import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.js';
import { fail } from './errors.js';
import { createGalleryShare } from './gallery-sharing.js';
import { emailDeliverySchema } from './validation.js';
import { FRAME_DESIGNS } from '../../shared/frame-designs.js';

const SERVICE_USER_ID = '00000000-0000-4000-8000-000000000001';
const frames = new Set(Object.keys(FRAME_DESIGNS));
const digest = value => createHash('sha256').update(value).digest();

/** Four accepted photos, with no checkout or upstream payment/token workflow. */
export async function createFreeSession(pool, config, { frameDesign = 'blueberry', clientIp = '127.0.0.1' }) {
  if (!frames.has(frameDesign)) fail(400, 'INVALID_FRAME', 'Unknown frame design.');
  const photoLimit = 4;
  const durationMinutes = config.FREE_SESSION_DURATION_MINUTES ?? 120;
  const rateLimit = config.FREE_SESSION_RATE_LIMIT_PER_IP_PER_HOUR ?? 5;
  return transaction(pool, async db => {
    // Count and create under the same transaction lock so parallel requests cannot
    // each observe the last available slot. The lock contains no visitor secret.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`racebooth-free-ip:${clientIp}`]);
    const recent = await db.query(`SELECT COUNT(*)::INT AS count FROM free_photobooth_sessions
      WHERE client_ip=$1 AND created_at > NOW() - INTERVAL '1 hour'`, [clientIp]);
    if (recent.rows[0].count >= rateLimit) fail(429, 'FREE_SESSION_RATE_LIMITED', 'Too many free sessions started from this device. Try again later.');

    // Existing historical package terms are immutable. Reuse only matching terms,
    // and serialize the first insert instead of creating duplicate packages.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('racebooth-free-package',0))");
    let pkg = await db.query(`SELECT id FROM photo_packages WHERE name='Free Racebooth Session'
      AND price_idr=0 AND photo_limit=4 AND session_duration_minutes=$1 AND is_active=TRUE
      ORDER BY created_at LIMIT 1`, [durationMinutes]);
    if (!pkg.rowCount) pkg = await db.query(`INSERT INTO photo_packages(name,price_idr,photo_limit,session_duration_minutes,is_active)
      VALUES('Free Racebooth Session',0,4,$1,TRUE) RETURNING id`, [durationMinutes]);
    const packageId = pkg.rows[0].id;
    const sessionKey = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + durationMinutes * 60000);
    const free = await db.query(`INSERT INTO free_photobooth_sessions(session_key,photo_limit,frame_design,client_ip,expires_at)
      VALUES($1,4,$2,$3,$4) RETURNING id`, [sessionKey, frameDesign, clientIp, expiresAt]);
    const freeSessionId = free.rows[0].id;

    // Zero-value provenance preserves the existing session foreign keys and all
    // historical transactions. No gateway or simulated payment is invoked.
    const tx = await db.query(`INSERT INTO payment_transactions(package_id,operator_id,amount_idr,payment_method,payment_status,is_simulated,paid_at,package_snapshot)
      SELECT p.id,$2,0,'free','paid',FALSE,NOW(),jsonb_build_object('id',p.id,'name',p.name,'price_idr',0,'description',p.description,
        'benefits',p.benefits,'photo_limit',4,'session_duration_minutes',p.session_duration_minutes)
      FROM photo_packages p WHERE p.id=$1 RETURNING id`, [packageId, SERVICE_USER_ID]);
    const transactionId = tx.rows[0].id;
    const session = await db.query(`INSERT INTO photobooth_sessions(transaction_id,operator_id,package_id,idempotency_key,access_token_hash,photo_limit,status,token_expires_at)
      VALUES($1,$2,$3,$4,$5,4,'active',$6) RETURNING id`,
    [transactionId, SERVICE_USER_ID, packageId, randomUUID(), digest(sessionKey).toString('hex'), expiresAt]);
    const sessionId = session.rows[0].id;
    await db.query("UPDATE free_photobooth_sessions SET session_id=$1,status='active' WHERE id=$2", [sessionId, freeSessionId]);
    await db.query(`INSERT INTO public_checkout_sessions(transaction_id,checkout_key,package_id,package_snapshot,client_ip)
      VALUES($1,$2,$3,$4,$5)`, [transactionId, sessionKey, packageId,
      JSON.stringify({ name: 'Free Racebooth Session', price_idr: 0, photo_limit: photoLimit, session_duration_minutes: durationMinutes }), clientIp]);
    return { freeSessionId, sessionId, sessionKey, frameDesign, photoLimit, expiresAt: expiresAt.toISOString() };
  });
}

async function readFreeSession(db, freeSessionId, sessionKey, { lock = false, galleryTtlHours = 0 } = {}) {
  const result = await db.query(`SELECT fs.*,s.status AS session_status,s.photos_taken,
      s.token_expires_at,s.id AS photobooth_session_id
    FROM free_photobooth_sessions fs LEFT JOIN photobooth_sessions s ON s.id=fs.session_id
    WHERE fs.id=$1 ${lock ? 'FOR UPDATE OF fs' : ''}`, [freeSessionId]);
  if (!result.rowCount) fail(404, 'FREE_SESSION_NOT_FOUND', 'Free session not found.');
  const fs = result.rows[0];
  if (typeof sessionKey !== 'string' || !/^[a-f0-9]{64}$/i.test(sessionKey)
    || !timingSafeEqual(digest(fs.session_key), digest(sessionKey))) fail(403, 'FREE_SESSION_ACCESS_DENIED', 'Invalid session key.');
  if (Date.now() >= new Date(fs.expires_at).getTime() + galleryTtlHours * 3600000) fail(410, 'FREE_SESSION_EXPIRED', 'This free session has expired.');
  return fs;
}

/** Authorized metadata never echoes capability keys or visitor IP addresses. */
export async function getFreeSession(db, freeSessionId, sessionKey) {
  const fs = await readFreeSession(db, freeSessionId, sessionKey);
  const { session_key, client_ip, ...metadata } = fs;
  return metadata;
}

function emailConfiguration(config) {
  let url;
  try { url = new URL(config.N8N_EMAIL_WEBHOOK_URL); } catch {}
  const origin = config.PUBLIC_APP_ORIGIN || config.APP_ORIGINS?.[0];
  if (!config.N8N_EMAIL_ENABLED || !url || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || typeof config.N8N_EMAIL_WEBHOOK_SECRET !== 'string' || config.N8N_EMAIL_WEBHOOK_SECRET.length < 32
    || !origin || !config.APP_ORIGINS?.includes(origin)) {
    fail(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not currently configured.');
  }
  return { url: url.href, origin };
}

async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 65536) return null;
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Only provider acknowledgement is success; HTTP acceptance alone is ambiguous. */
export async function dispatchPhotoEmail(config, payload, fetchImpl = fetch) {
  const { url } = emailConfiguration(config);
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Racebooth-Secret': config.N8N_EMAIL_WEBHOOK_SECRET },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(config.N8N_EMAIL_TIMEOUT_MS ?? 20000) });
    const data = await boundedJson(response);
    const metadata = { http_status: response.status, confirmation: 'unconfirmed' };
    const body = Array.isArray(data) && data.length === 1 ? data[0] : data;
    const messageId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
    const gmailSent = body && messageId(body.id) && messageId(body.threadId)
      && Array.isArray(body.labelIds) && body.labelIds.includes('SENT');
    const correlated = body?.delivery_id === payload.delivery_id;
    if (response.ok && (gmailSent || (correlated && body.status === 'sent'))) {
      return { status: 'sent', metadata: { ...metadata, confirmation: 'provider_accepted',
        ...(gmailSent ? { provider_message_id: body.id, provider_thread_id: body.threadId } : {}) } };
    }
    if ((correlated && body.status === 'failed') || (response.status >= 400 && response.status < 500 && response.status !== 408)) {
      return { status: 'failed', reason: correlated ? 'WORKFLOW_DELIVERY_FAILED' : `WEBHOOK_REJECTED_${response.status}`,
        metadata: { ...metadata, confirmation: 'rejected' } };
    }
    return { status: 'pending', reason: 'DELIVERY_UNCONFIRMED', metadata };
  } catch {
    // Timeout/network/redirect errors can follow an upstream send. Preserve the
    // reservation and require reconciliation instead of risking a second email.
    return { status: 'pending', reason: 'DELIVERY_UNCONFIRMED', metadata: { confirmation: 'unconfirmed' } };
  }
}

/** Reserve once under a row lock, then call n8n after the reservation commits. */
export async function sendPhotoEmail(pool, config, { freeSessionId, sessionKey, recipientEmail }, fetchImpl = fetch) {
  const { origin } = emailConfiguration(config);
  const normalizedEmail = typeof recipientEmail === 'string' ? recipientEmail.trim().toLowerCase() : recipientEmail;
  emailDeliverySchema.parse({ recipientEmail: normalizedEmail });
  const reservation = await transaction(pool, async db => {
    const fs = await readFreeSession(db, freeSessionId, sessionKey, { lock: true, galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS ?? 24 });
    if (!fs.photobooth_session_id) fail(409, 'SESSION_NOT_STARTED', 'No photobooth session linked yet.');
    const photos = await db.query("SELECT COUNT(*)::INT AS count FROM session_photos WHERE session_id=$1 AND status='saved'", [fs.photobooth_session_id]);
    if (photos.rows[0].count !== 4 || fs.photo_limit !== 4) fail(409, 'SESSION_INCOMPLETE', 'Complete all four photos before requesting email delivery.');
    const strip = await db.query('SELECT status,is_finalized FROM session_photostrips WHERE session_id=$1', [fs.photobooth_session_id]);
    if (strip.rows[0]?.status !== 'composed') fail(409, 'STRIP_NOT_READY', 'Create your photostrip before requesting email delivery.');
    if (strip.rows[0]?.is_finalized === false) fail(409, 'RESULT_NOT_FINALIZED', 'Finalize your photostrip before sending its gallery link.');
    const existing = await db.query(`SELECT id,status,n8n_response FROM free_session_email_deliveries
      WHERE free_session_id=$1 AND status IN ('pending','sent') ORDER BY created_at DESC LIMIT 1`, [freeSessionId]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      const status = row.status === 'sent' && row.n8n_response?.confirmation === 'provider_accepted' ? 'sent' : 'pending';
      return { replay: { ok: true, deliveryId: row.id, status, replayed: true,
        note: status === 'sent' ? 'Gmail accepted the gallery email. Check your inbox.' : 'An email request already exists. Delivery has not been confirmed; it will not be sent again automatically.' } };
    }
    const share = await createGalleryShare(db, config, fs.photobooth_session_id, sessionKey);
    const galleryUrl = `${origin}/photobooth/gallery/${fs.photobooth_session_id}#share=${share.shareToken}`;
    const delivery = await db.query(`INSERT INTO free_session_email_deliveries(free_session_id,recipient_email,gallery_url,status)
      VALUES($1,$2,$3,'pending') RETURNING id`, [freeSessionId, normalizedEmail, galleryUrl]);
    return { payload: { recipient_email: normalizedEmail, gallery_url: galleryUrl, gallery_expires_at: share.expiresAt,
      session_id: freeSessionId, photobooth_session_id: fs.photobooth_session_id, delivery_id: delivery.rows[0].id } };
  });
  if (reservation.replay) return reservation.replay;
  const payload = reservation.payload;
  const result = await dispatchPhotoEmail(config, payload, fetchImpl);
  await pool.query(`UPDATE free_session_email_deliveries SET status=$2,
    sent_at=CASE WHEN $2='sent' THEN NOW() ELSE NULL END,
    failed_at=CASE WHEN $2='failed' THEN NOW() ELSE NULL END,failure_reason=$3,n8n_response=$4 WHERE id=$1`,
  [payload.delivery_id, result.status, result.reason || null, JSON.stringify(result.metadata)]);
  if (result.status === 'failed') fail(502, 'EMAIL_DISPATCH_FAILED', 'The email service rejected this request. Your photos are still available to download.');
  return { ok: true, deliveryId: payload.delivery_id, status: result.status,
    note: result.status === 'sent' ? 'Gmail accepted the gallery email. Check your inbox.' : 'Your email request was recorded, but delivery has not been confirmed. It will not be sent again automatically.' };
}

export async function getEmailDeliveryStatus(pool, freeSessionId, sessionKey, config = {}) {
  await readFreeSession(pool, freeSessionId, sessionKey, { galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS ?? 24 });
  const result = await pool.query(`SELECT id,status,sent_at,failed_at,failure_reason,created_at,n8n_response
    FROM free_session_email_deliveries WHERE free_session_id=$1 ORDER BY created_at DESC LIMIT 5`, [freeSessionId]);
  return { deliveries: result.rows.map(({ n8n_response, ...row }) => row.status === 'sent' && n8n_response?.confirmation !== 'provider_accepted'
    ? { ...row, status: 'pending', sent_at: null, failure_reason: 'DELIVERY_UNCONFIRMED' } : row) };
}
