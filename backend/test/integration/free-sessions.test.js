import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { createFreeSession, getFreeSession, sendPhotoEmail, getEmailDeliveryStatus } from '../../src/free-sessions.js';
import { uploadPhoto, composePhotostrip, getStripFile } from '../../src/photos.js';
import { getSharedGallery } from '../../src/gallery-sharing.js';
import { dashboard } from '../../src/services.js';
import { applyTestMigrations } from './setup.js';
import { FRAME_LAYOUT, FRAME_DESIGNS } from '../../../shared/frame-designs.js';

if (process.env.PGHOST !== 'photobooth-phase1-test-db' || process.env.PGDATABASE !== 'photobooth_phase1_test' || process.env.ALLOW_INTEGRATION_DB_SETUP !== 'disposable-container') {
  throw new Error('Refusing free-session integration setup outside the documented disposable test database.');
}
const config = loadConfig({ ...process.env, NODE_ENV: 'test', COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '0', APP_ORIGINS: 'http://localhost:8088', PUBLIC_APP_ORIGIN: '',
  N8N_ENABLED: 'false', N8N_WEBHOOK_URL: undefined, N8N_EMAIL_ENABLED: 'false', N8N_EMAIL_WEBHOOK_URL: '', N8N_EMAIL_WEBHOOK_SECRET: '',
  HERMES_ENDPOINT: '', HERMES_API_KEY: '', N8N_SIMULATOR_ENABLED: 'false' });
const schema = `free_test_${randomBytes(8).toString('hex')}`;
let pool, storageRoot, previousStorageRoot, webhook, appServer, origin, emailConfig;
let webhookRequests = []; let ipCounter = 10;
let respond = (payload, response) => response.end(JSON.stringify({ id: '18abc123', threadId: '18abc123', labelIds: ['SENT'] }));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
const close = server => new Promise(resolve => server?.close(resolve));
const bytes = sequence => sharp({ create: { width: 240, height: 180, channels: 3, background: { r: 30 + sequence * 40, g: 180 - sequence * 20, b: 60 + sequence * 30 } } }).png().toBuffer();
const fresh = (frameDesign = 'blueberry', overrides = {}) => createFreeSession(pool, { ...config, ...overrides }, { frameDesign, clientIp: `192.0.2.${ipCounter++}` });
async function complete(frame = 'blueberry') {
  const session = await fresh(frame);
  for (let sequence = 1; sequence <= 4; sequence++) await uploadPhoto(pool, session.sessionId, { sequence, filter: sequence === 2 ? 'bw' : 'original', checkoutKey: session.sessionKey }, await bytes(sequence), { claimedMime: 'image/png' });
  await composePhotostrip(pool, session.sessionId, { background: frame, checkoutKey: session.sessionKey });
  return session;
}
const email = (session, overrides = {}, fetchImpl) => sendPhotoEmail(pool, { ...emailConfig, ...overrides }, {
  freeSessionId: session.freeSessionId, sessionKey: session.sessionKey, recipientEmail: 'visitor@example.invalid',
}, fetchImpl);

before(async () => {
  const setup = new pg.Pool(config.pg);
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { await setup.end(); }
  pool = new pg.Pool({ ...config.pg, options: `-c search_path=${schema},pg_catalog` });
  storageRoot = await mkdtemp(join(tmpdir(), 'racebooth-free-integration-'));
  previousStorageRoot = process.env.PHOTO_STORAGE_PATH; process.env.PHOTO_STORAGE_PATH = storageRoot;
  await pool.query(await readFile(new URL('../../../database/01-schema.sql', import.meta.url), 'utf8'));
  await applyTestMigrations(pool);
  webhook = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    webhookRequests.push({ payload, authenticated: request.headers['x-racebooth-secret'] === emailConfig.N8N_EMAIL_WEBHOOK_SECRET });
    response.setHeader('Content-Type', 'application/json'); await respond(payload, response);
  });
  await listen(webhook);
  emailConfig = { ...config, N8N_EMAIL_ENABLED: true, PUBLIC_APP_ORIGIN: 'http://localhost:8088',
    N8N_EMAIL_WEBHOOK_URL: `http://127.0.0.1:${webhook.address().port}/webhook/racebooth/photo-result-email`,
    N8N_EMAIL_WEBHOOK_SECRET: randomBytes(32).toString('hex'), N8N_EMAIL_TIMEOUT_MS: 1000 };
  appServer = await listen(createServer(createApp({ pool, config: emailConfig })));
  origin = `http://127.0.0.1:${appServer.address().port}`;
});
after(async () => {
  if (appServer) await close(appServer); if (webhook) await close(webhook); if (pool) await pool.end();
  if (previousStorageRoot === undefined) delete process.env.PHOTO_STORAGE_PATH; else process.env.PHOTO_STORAGE_PATH = previousStorageRoot;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

test('HTTP free flow preserves four real uploads, selected strip, private downloads, QR sharing and authenticated email', async () => {
  const created = await fetch(`${origin}/api/public/free-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frameDesign: 'pink-diary' }) });
  assert.equal(created.status, 201);
  const session = await created.json(); assert.equal(session.photoLimit, 4); assert.equal(session.frameDesign, 'pink-diary');
  const headers = { 'X-Session-Key': session.sessionKey };
  const metadata = await (await fetch(`${origin}/api/public/free-sessions/${session.freeSessionId}`, { headers })).json();
  assert.equal(metadata.freeSession.session_key, undefined); assert.equal(metadata.freeSession.client_ip, undefined);
  const sessionUrl = `${origin}/api/public/sessions/${session.sessionId}`;
  const denied = await fetch(`${sessionUrl}/gallery`); assert.equal(denied.status, 403); await denied.arrayBuffer();
  for (let sequence = 1; sequence <= 4; sequence++) {
    const saved = await fetch(`${sessionUrl}/photos`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'X-Photo-Sequence': String(sequence), 'X-Photo-Filter': sequence === 2 ? 'bw' : 'original' }, body: await bytes(sequence) });
    assert.equal(saved.status, 201); assert.equal((await saved.json()).photo.sequence, sequence);
  }
  const fifth = await fetch(`${sessionUrl}/photos`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'X-Photo-Sequence': '5' }, body: await bytes(5) });
  assert.equal(fifth.status, 422); await fifth.arrayBuffer();
  const composed = await fetch(`${sessionUrl}/photostrip`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(composed.status, 201); assert.equal((await composed.json()).strip.background, 'pink-diary');
  const download = await fetch(`${sessionUrl}/photostrip/file?download=1`, { headers });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await sharp(Buffer.from(await download.arrayBuffer())).metadata()).format, 'jpeg');
  const shareResponse = await fetch(`${sessionUrl}/gallery-share`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(shareResponse.status, 200); const share = await shareResponse.json(); assert.match(share.qrDataUrl, /^data:image\/png;base64,/);
  const shared = await fetch(`${origin}/api/public/galleries/${session.sessionId}`, { headers: { Authorization: `Bearer ${share.shareToken}` } });
  assert.equal(shared.status, 200); const gallery = await shared.json(); assert.equal(gallery.photos.length, 4);
  assert.equal(gallery.session.free_session_id, session.freeSessionId); assert.equal(gallery.session.frame_design, 'pink-diary');
  const sharedFile = await fetch(`${origin}/api/public/galleries/${session.sessionId}/photostrip/file?download=1`, { headers: { Authorization: `Bearer ${share.shareToken}` } });
  assert.equal(sharedFile.status, 200); await sharedFile.arrayBuffer();
  const tx = (await pool.query('SELECT t.* FROM payment_transactions t JOIN photobooth_sessions s ON s.transaction_id=t.id WHERE s.id=$1', [session.sessionId])).rows[0];
  assert.equal(tx.amount_idr, '0'); assert.equal(tx.payment_method, 'free'); assert.equal(tx.is_simulated, false);
  assert.equal(webhookRequests.length, 0, 'free capture must never call token/payment/email workflows');
  const metrics = await dashboard(pool, '00000000-0000-4000-8000-000000000001');
  assert.equal(metrics.stats.realRevenueIdr, '0'); assert.equal(metrics.stats.totalFreeSessions, 1); assert.equal(metrics.stats.completedFreeSessions, 1);
  const emailPath = `${origin}/api/public/free-sessions/${session.freeSessionId}`;
  const deliveryResponse = await fetch(`${emailPath}/send-email`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'http-visitor@example.invalid' }) });
  assert.equal(deliveryResponse.status, 200); const delivery = await deliveryResponse.json(); assert.equal(delivery.status, 'sent');
  const deliveryStatus = await fetch(`${emailPath}/email-status`, { headers }); assert.equal(deliveryStatus.status, 200);
  assert.equal((await deliveryStatus.json()).deliveries[0].status, 'sent'); assert.equal(webhookRequests.length, 1);
  assert.equal(webhookRequests[0].authenticated, true); assert.equal(webhookRequests[0].payload.recipient_email, 'http-visitor@example.invalid');
});

test('parallel free requests enforce the database rate limit and share one matching free package', async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => createFreeSession(pool, { ...config, FREE_SESSION_RATE_LIMIT_PER_IP_PER_HOUR: 2, FREE_SESSION_PHOTO_LIMIT: 10 }, { clientIp: '198.51.100.10' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'FREE_SESSION_RATE_LIMITED'));
  for (const result of results.filter(result => result.status === 'fulfilled')) assert.equal(result.value.photoLimit, 4);
  const packages = await pool.query("SELECT COUNT(*)::INT AS count FROM photo_packages WHERE name='Free Racebooth Session'");
  assert.equal(packages.rows[0].count, 1);
});

test('global artistic edit preserves four unmirrored 16:9 originals, fills the slots, rejects stale edits, and shares the finalized result', async () => {
  const session = await fresh('retro-checker');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ef3b27"/><rect width="160" height="160" fill="#f5e231"/><rect x="1120" y="560" width="160" height="160" fill="#2ce576"/><text x="220" y="120" font-size="64" font-family="sans-serif" fill="#102030">LEFT</text><text x="1000" y="680" font-size="64" font-family="sans-serif" fill="#102030">RIGHT</text></svg>');
  const input = await sharp(svg).png().toBuffer();
  const headers = { 'X-Session-Key': session.sessionKey };
  const base = `${origin}/api/public/sessions/${session.sessionId}`;
  for (let i = 1; i <= 4; i++) {
    const response = await fetch(`${base}/photos`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'X-Photo-Sequence': String(i) }, body: input });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.photo.filter, 'original');
    if (i === 4) assert.equal(result.autoComposed, true);
  }
  const gallery = await (await fetch(`${base}/gallery`, { headers })).json();
  assert.equal(gallery.session.frame_design, 'retro-checker');
  const photo = Buffer.from(await (await fetch(`${base}/photos/${gallery.photos[0].id}/file`, { headers })).arrayBuffer());
  const originalPixel = await sharp(photo).extract({ left: 40, top: 40, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(originalPixel[0] > 180 && originalPixel[1] > 150, 'left marker remains on the left');
  const preview = Buffer.from(await (await fetch(`${base}/photostrip/file`, { headers })).arrayBuffer());
  const edit = await fetch(`${base}/photostrip`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'comic-pop', finalize: false, editRevision: 2 }) });
  assert.equal(edit.status, 201);
  assert.equal((await edit.json()).strip.selected_filter, 'comic-pop');
  const stale = await fetch(`${base}/photostrip`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'bw', finalize: true, editRevision: 1 }) });
  assert.equal((await stale.json()).stale, true);
  const finalize = await fetch(`${base}/photostrip`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: 'comic-pop', finalize: true, editRevision: 3 }) });
  const finalResult = await finalize.json();
  assert.equal(finalResult.strip.is_finalized, true); assert.equal(finalResult.strip.selected_filter, 'comic-pop');
  const strip = Buffer.from(await (await fetch(`${base}/photostrip/file`, { headers })).arrayBuffer());
  const pixels = await sharp(strip).raw().toBuffer({ resolveWithObject: true });
  const prior = await sharp(preview).raw().toBuffer();
  const pixelAt = (data, x, y) => [...data.subarray((y * pixels.info.width + x) * 3, (y * pixels.info.width + x) * 3 + 3)];
  for (let i = 0; i < 4; i++) {
    const top = FRAME_LAYOUT.top + i * (FRAME_LAYOUT.photoHeight + FRAME_LAYOUT.gap);
    const left = pixelAt(pixels.data, FRAME_LAYOUT.margin + 35, top + 35);
    const right = pixelAt(pixels.data, FRAME_LAYOUT.margin + 560, top + 300);
    assert.ok(left[0] > 160 && left[1] > 130 && left[2] < 100, `slot ${i + 1} keeps left yellow corner`);
    assert.ok(right[1] > 140 && right[0] < 110, `slot ${i + 1} keeps right green corner`);
    const topEdge = pixelAt(pixels.data, FRAME_LAYOUT.margin + 300, top + 2);
    const bottomEdge = pixelAt(pixels.data, FRAME_LAYOUT.margin + 300, top + FRAME_LAYOUT.photoHeight - 3);
    assert.ok(topEdge[0] > 150 && topEdge[1] < 120, `slot ${i + 1} has no empty band at the top`);
    assert.ok(bottomEdge[0] > 150 && bottomEdge[1] < 120, `slot ${i + 1} has no empty band at the bottom`);
    const center = (Math.round(top + FRAME_LAYOUT.photoHeight / 2) * pixels.info.width + FRAME_LAYOUT.margin + 180) * 3;
    assert.ok(Math.abs(pixels.data[center] - prior[center]) + Math.abs(pixels.data[center + 1] - prior[center + 1]) + Math.abs(pixels.data[center + 2] - prior[center + 2]) > 20, `filter changes slot ${i + 1}`);
  }
  const originalAgain = Buffer.from(await (await fetch(`${base}/photos/${gallery.photos[0].id}/file`, { headers })).arrayBuffer());
  assert.deepEqual(originalAgain, photo, 'derived edits leave originals unchanged');
  const share = await fetch(`${base}/gallery-share`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(share.status, 200); assert.match((await share.json()).qrDataUrl, /^data:image\/png;base64,/);
});

test('all 12 frame templates fill four landscape photo slots edge-to-edge without distortion or mirroring', async () => {
  assert.ok(Math.abs(FRAME_LAYOUT.photoWidth / FRAME_LAYOUT.photoHeight - 1280 / 720) < 0.005,
    'shared photo slot geometry stays within 0.5% of the 16:9 camera aspect ratio');
  const landscape = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#ef3b27"/><rect width="160" height="160" fill="#f5e231"/><rect x="1120" y="560" width="160" height="160" fill="#2ce576"/><text x="220" y="120" font-size="64" font-family="sans-serif" fill="#102030">LEFT</text><text x="1000" y="680" font-size="64" font-family="sans-serif" fill="#102030">RIGHT</text></svg>')).png().toBuffer();
  const hashes = new Set();
  for (const frame of Object.keys(FRAME_DESIGNS)) {
    const session = await fresh(frame);
    for (let sequence = 1; sequence <= 4; sequence++) await uploadPhoto(pool, session.sessionId,
      { sequence, filter: 'original', checkoutKey: session.sessionKey }, landscape, { claimedMime: 'image/png' });
    const metadata = await getFreeSession(pool, session.freeSessionId, session.sessionKey);
    assert.equal(metadata.frame_design, frame); assert.equal(metadata.photo_limit, 4);
    await composePhotostrip(pool, session.sessionId, { background: frame, checkoutKey: session.sessionKey });
    const file = await getStripFile(pool, session.sessionId, session.sessionKey); const chunks = [];
    for await (const chunk of file.stream) chunks.push(chunk); const data = Buffer.concat(chunks);
    const decoded = await sharp(data).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, FRAME_LAYOUT.width);
    assert.equal(decoded.info.height, FRAME_LAYOUT.top + 4 * FRAME_LAYOUT.photoHeight + 3 * FRAME_LAYOUT.gap + FRAME_LAYOUT.footer);
    const pixel = (x, y) => [...decoded.data.subarray((y * decoded.info.width + x) * 3, (y * decoded.info.width + x) * 3 + 3)];
    for (let index = 0; index < 4; index++) {
      const top = FRAME_LAYOUT.top + index * (FRAME_LAYOUT.photoHeight + FRAME_LAYOUT.gap);
      for (const [label, x, y] of [
        ['top edge', FRAME_LAYOUT.margin + 300, top + 2],
        ['bottom edge', FRAME_LAYOUT.margin + 300, top + FRAME_LAYOUT.photoHeight - 3],
        ['left edge', FRAME_LAYOUT.margin + 2, top + 170],
        ['right edge', FRAME_LAYOUT.margin + FRAME_LAYOUT.photoWidth - 3, top + 170],
      ]) {
        const [red, green, blue] = pixel(x, y);
        assert.ok(red > 150 && green < 120 && blue < 100, `${frame} slot ${index + 1} ${label} is full-bleed photo, not mat or empty fill`);
      }
      const leftMarker = pixel(FRAME_LAYOUT.margin + 25, top + 25);
      const rightMarker = pixel(FRAME_LAYOUT.margin + FRAME_LAYOUT.photoWidth - 25, top + FRAME_LAYOUT.photoHeight - 25);
      assert.ok(leftMarker[0] > 180 && leftMarker[1] > 150 && leftMarker[2] < 110, `${frame} slot ${index + 1} retains its top-left marker`);
      assert.ok(rightMarker[1] > 140 && rightMarker[0] < 110, `${frame} slot ${index + 1} retains its bottom-right marker`);
    }
    hashes.add(createHash('sha256').update(data).digest('hex'));
  }
  assert.equal(hashes.size, 12);
});

test('email rejects incomplete sessions and invalid recipient/capability before dispatch', async () => {
  const session = await fresh(); const before = webhookRequests.length;
  await assert.rejects(email(session), error => error.code === 'SESSION_INCOMPLETE');
  await assert.rejects(sendPhotoEmail(pool, emailConfig, { freeSessionId: session.freeSessionId, sessionKey: '0'.repeat(64), recipientEmail: 'visitor@example.invalid' }), error => error.code === 'FREE_SESSION_ACCESS_DENIED');
  await assert.rejects(sendPhotoEmail(pool, emailConfig, { freeSessionId: session.freeSessionId, sessionKey: session.sessionKey, recipientEmail: 'invalid' }));
  assert.equal(webhookRequests.length, before);
});

test('concurrent email submissions send once, record Gmail acceptance and contain a real read-only gallery link', async () => {
  const session = await complete(); const before = webhookRequests.length;
  respond = async (payload, response) => { await new Promise(resolve => setTimeout(resolve, 60)); response.end(JSON.stringify({ id: '18abc123', threadId: '18abc123', labelIds: ['SENT'] })); };
  const results = await Promise.all(Array.from({ length: 8 }, () => email(session)));
  assert.equal(new Set(results.map(result => result.deliveryId)).size, 1); assert.equal(webhookRequests.length - before, 1);
  const replay = await email(session); assert.equal(replay.status, 'sent'); assert.equal(replay.replayed, true); assert.equal(webhookRequests.length - before, 1);
  const request = webhookRequests.at(-1); assert.equal(request.authenticated, true);
  const url = new URL(request.payload.gallery_url); assert.equal(url.pathname, `/photobooth/gallery/${session.sessionId}`);
  assert.equal(url.hash.includes(session.sessionKey), false); const token = new URLSearchParams(url.hash.slice(1)).get('share'); assert.ok(token);
  assert.equal((await getSharedGallery(pool, config, session.sessionId, token)).photos.length, 4);
  const status = await getEmailDeliveryStatus(pool, session.freeSessionId, session.sessionKey);
  assert.equal(status.deliveries.length, 1); assert.equal(status.deliveries[0].status, 'sent'); assert.ok(status.deliveries[0].sent_at);
});

test('immediate webhook acceptance stays unconfirmed and is never retried automatically even when old', async () => {
  const session = await complete(); const before = webhookRequests.length;
  respond = (payload, response) => response.end(JSON.stringify({ message: 'Workflow was started' }));
  const result = await email(session); assert.equal(result.status, 'pending');
  await pool.query("UPDATE free_session_email_deliveries SET created_at=NOW()-INTERVAL '10 minutes' WHERE id=$1", [result.deliveryId]);
  const replay = await email(session); assert.equal(replay.status, 'pending'); assert.equal(replay.deliveryId, result.deliveryId);
  assert.equal(webhookRequests.length - before, 1);
  const state = (await getEmailDeliveryStatus(pool, session.freeSessionId, session.sessionKey)).deliveries[0];
  assert.equal(state.sent_at, null); assert.equal(state.failure_reason, 'DELIVERY_UNCONFIRMED');
});

test('a definite webhook rejection records failure and permits an explicit later retry', async () => {
  const session = await complete(); const before = webhookRequests.length;
  respond = (payload, response) => { response.statusCode = 401; response.end(JSON.stringify({ message: 'Unauthorized' })); };
  await assert.rejects(email(session), error => error.code === 'EMAIL_DISPATCH_FAILED');
  const failed = (await getEmailDeliveryStatus(pool, session.freeSessionId, session.sessionKey)).deliveries[0];
  assert.equal(failed.status, 'failed'); assert.ok(failed.failed_at); assert.equal(failed.sent_at, null);
  respond = (payload, response) => response.end(JSON.stringify({ delivery_id: payload.delivery_id, status: 'sent' }));
  const retry = await email(session); assert.equal(retry.status, 'sent'); assert.notEqual(retry.deliveryId, failed.id); assert.equal(webhookRequests.length - before, 2);
});

test('transport and workflow server failures preserve pending reservations and block duplicate sends', async () => {
  const session = await complete(); let calls = 0;
  const failingTransport = async () => { calls++; throw new Error('timeout'); };
  assert.equal((await email(session, {}, failingTransport)).status, 'pending');
  assert.equal((await email(session, {}, failingTransport)).status, 'pending'); assert.equal(calls, 1);
  const serverFailureSession = await complete(); const before = webhookRequests.length;
  respond = (payload, response) => { response.statusCode = 500; response.end(JSON.stringify({ message: 'Unknown upstream state' })); };
  assert.equal((await email(serverFailureSession)).status, 'pending'); assert.equal((await email(serverFailureSession)).status, 'pending');
  assert.equal(webhookRequests.length - before, 1);
});

test('legacy sent rows without provider acknowledgement remain unconfirmed and block resending', async () => {
  const session = await complete(); const before = webhookRequests.length;
  await pool.query(`INSERT INTO free_session_email_deliveries(free_session_id,recipient_email,gallery_url,status,sent_at,n8n_response)
    VALUES($1,'legacy@example.invalid','http://localhost:8088/legacy','sent',NOW(),$2)`, [session.freeSessionId, JSON.stringify({ status: 200, ok: true })]);
  const status = await getEmailDeliveryStatus(pool, session.freeSessionId, session.sessionKey);
  assert.equal(status.deliveries[0].status, 'pending'); assert.equal(status.deliveries[0].sent_at, null);
  const replay = await email(session); assert.equal(replay.status, 'pending'); assert.equal(replay.replayed, true);
  assert.equal(webhookRequests.length, before);
  const original = (await pool.query('SELECT status,sent_at FROM free_session_email_deliveries WHERE free_session_id=$1', [session.freeSessionId])).rows[0];
  assert.equal(original.status, 'sent'); assert.ok(original.sent_at, 'original historical record is preserved');
});
