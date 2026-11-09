import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { fail } from './errors.js';
import { verifySessionAccess, getSessionGallery, getPhotoFile, getStripFile } from './photos.js';

const issuer = 'photobooth-backend';
const audience = 'photobooth-gallery';
const scopes = new Set(['gallery', 'photo', 'strip']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claimNames = new Set(['ver', 'scope', 'photo_id', 'cap', 'sub', 'iss', 'aud', 'iat', 'exp', 'jti']);

export function deriveGallerySigningKey(config) {
  if (!/^[a-f0-9]{64}$/i.test(config.TOKEN_ENCRYPTION_KEY || '')) throw new Error('Gallery sharing requires a valid token encryption key.');
  // Domain separation keeps gallery capabilities independent of n8n JWTs and
  // token ciphertext, including when both features use one deployment root key.
  return Buffer.from(hkdfSync('sha256', Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex'),
    Buffer.from('lumi-gallery-v1'), Buffer.from('read-only-photo-sharing-signatures'), 32));
}

function policy(config) {
  const galleryTtlHours = config.PHOTO_GALLERY_TTL_HOURS ?? 24;
  const shareMinutes = config.PHOTO_SHARE_TTL_MINUTES ?? 60;
  if (!Number.isInteger(galleryTtlHours) || galleryTtlHours < 1 || galleryTtlHours > 168 || !Number.isInteger(shareMinutes) || shareMinutes < 1 || shareMinutes > 1440) throw new Error('Invalid gallery sharing expiry configuration.');
  return { galleryTtlHours, shareSeconds: shareMinutes * 60 };
}

function sessionBinding(key, sessionId, checkoutKey) {
  return createHmac('sha256', key).update(`checkout:${sessionId}:${checkoutKey}`).digest('hex');
}
function galleryExpiry(session, galleryTtlHours) {
  return Math.floor((new Date(session.token_expires_at).getTime() + galleryTtlHours * 3600000) / 1000);
}
function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !uuid.test(sessionId)) fail(400, 'SESSION_INVALID', 'Invalid session identifier.');
  return sessionId.toLowerCase();
}
function publicScope(claims) {
  return { scope: claims.scope, ...(claims.scope === 'photo' ? { photoId: claims.photo_id } : {}), expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export async function createGalleryShare(pool, config, sessionId, credential, options = {}) {
  const id = assertSessionId(sessionId); const { galleryTtlHours, shareSeconds } = policy(config);
  const scope = options.scope ?? 'gallery';
  if (!scopes.has(scope)) fail(400, 'SHARE_SCOPE_INVALID', 'Choose a supported sharing scope.');
  if (scope === 'photo' && (typeof options.photoId !== 'string' || !uuid.test(options.photoId))) fail(400, 'PHOTO_INVALID', 'Choose a valid photo to share.');
  if (scope !== 'photo' && options.photoId !== undefined) fail(400, 'SHARE_SCOPE_INVALID', 'Photo selection is only available for photo links.');
  const session = await verifySessionAccess(pool, id, credential, { galleryTtlHours });
  // A share is bound to a public checkout capability, never to operator login or
  // n8n identity. Legacy sessions without a checkout can still use direct access.
  if (typeof session.checkout_key !== 'string' || session.checkout_key.length < 16) fail(409, 'SHARING_UNAVAILABLE', 'Sharing is unavailable for this session. Use its authenticated download controls.');
  const photoId = scope === 'photo' ? options.photoId.toLowerCase() : undefined;
  if (scope === 'photo') {
    const photo = await pool.query("SELECT id FROM session_photos WHERE id=$1 AND session_id=$2 AND status='saved'", [photoId, id]);
    if (!photo.rowCount) fail(404, 'PHOTO_NOT_FOUND', 'Photo not found in this session.');
  } else if (scope === 'strip') {
    const strip = await pool.query("SELECT id,is_finalized FROM session_photostrips WHERE session_id=$1 AND status='composed'", [id]);
    if (!strip.rowCount) fail(404, 'STRIP_NOT_READY', 'The photostrip has not been composed yet.');
    if (strip.rows[0].is_finalized === false) fail(409, 'RESULT_NOT_FINALIZED', 'Finalize the photostrip before sharing it.');
  } else {
    const photo = await pool.query("SELECT id FROM session_photos WHERE session_id=$1 AND status='saved' LIMIT 1", [id]);
    if (!photo.rowCount) {
      const strip = await pool.query("SELECT id,is_finalized FROM session_photostrips WHERE session_id=$1 AND status='composed'", [id]);
      if (!strip.rowCount) fail(409, 'GALLERY_EMPTY', 'Confirm a photo before creating a gallery link.');
      if (strip.rows[0].is_finalized === false) fail(409, 'RESULT_NOT_FINALIZED', 'Finalize the photostrip before sharing it.');
    }
  }
  const now = Math.floor(Date.now() / 1000); const expires = Math.min(now + shareSeconds, galleryExpiry(session, galleryTtlHours));
  if (!Number.isFinite(expires) || expires <= now) fail(410, 'GALLERY_EXPIRED', 'This gallery link has expired.');
  const signingKey = deriveGallerySigningKey(config);
  const claims = { ver: 1, scope, ...(photoId ? { photo_id: photoId } : {}), cap: sessionBinding(signingKey, id, session.checkout_key), iat: now, exp: expires };
  const shareToken = jwt.sign(claims, signingKey, { algorithm: 'HS256', subject: id, issuer, audience, jwtid: randomBytes(32).toString('base64url') });
  return { shareToken, ...publicScope(claims) };
}

// Internal authorization result contains a checkout credential solely for reuse by
// the existing photo service. HTTP handlers should call getShared* and never send
// this result or the decoded JWT claims to a browser.
export async function verifyGalleryShare(pool, config, sessionId, shareToken) {
  const id = assertSessionId(sessionId); const { galleryTtlHours, shareSeconds } = policy(config);
  if (typeof shareToken !== 'string' || shareToken.length < 100 || shareToken.length > 4096) fail(403, 'SHARE_INVALID', 'This photo link is invalid or expired.');
  const signingKey = deriveGallerySigningKey(config); let claims;
  try {
    claims = jwt.verify(shareToken, signingKey, { algorithms: ['HS256'], issuer, audience, subject: id, maxAge: shareSeconds });
  } catch { fail(403, 'SHARE_INVALID', 'This photo link is invalid or expired.'); }
  const now = Math.floor(Date.now() / 1000);
  if (!claims || typeof claims !== 'object' || Object.keys(claims).some(k => !claimNames.has(k)) || claims.ver !== 1 || !scopes.has(claims.scope)
    || claims.iss !== issuer || claims.aud !== audience || claims.sub !== id
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + 5 || claims.exp <= claims.iat || claims.exp - claims.iat > shareSeconds
    || !/^[A-Za-z0-9_-]{43}$/.test(claims.jti || '') || !/^[a-f0-9]{64}$/.test(claims.cap || '')
    || (claims.scope === 'photo' ? !uuid.test(claims.photo_id || '') : claims.photo_id !== undefined)) {
    fail(403, 'SHARE_INVALID', 'This photo link is invalid or expired.');
  }
  const checkout = await pool.query(`SELECT pcs.checkout_key FROM photobooth_sessions s
    JOIN public_checkout_sessions pcs ON pcs.transaction_id=s.transaction_id WHERE s.id=$1`, [id]);
  const checkoutKey = checkout.rows[0]?.checkout_key;
  if (typeof checkoutKey !== 'string' || checkoutKey.length < 16) fail(403, 'SHARE_REVOKED', 'This photo link is no longer authorized.');
  const expected = sessionBinding(signingKey, id, checkoutKey);
  if (!timingSafeEqual(Buffer.from(claims.cap, 'hex'), Buffer.from(expected, 'hex'))) fail(403, 'SHARE_REVOKED', 'This photo link is no longer authorized.');
  const session = await verifySessionAccess(pool, id, checkoutKey, { galleryTtlHours });
  if (claims.exp > galleryExpiry(session, galleryTtlHours)) fail(403, 'SHARE_INVALID', 'This photo link is invalid or expired.');
  return { session, checkoutKey, claims, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export async function getSharedGallery(pool, config, sessionId, shareToken) {
  const { checkoutKey, claims } = await verifyGalleryShare(pool, config, sessionId, shareToken);
  const gallery = await getSessionGallery(pool, sessionId, checkoutKey, policy(config));
  if (claims.scope === 'photo') {
    gallery.photos = gallery.photos.filter(photo => photo.id === claims.photo_id); gallery.strip = null;
    if (!gallery.photos.length) fail(404, 'PHOTO_NOT_FOUND', 'Photo not found in this session.');
  } else if (claims.scope === 'strip') {
    gallery.photos = [];
    if (gallery.strip?.status !== 'composed') fail(404, 'STRIP_NOT_READY', 'The photostrip has not been composed yet.');
  }
  return { ...gallery, ...publicScope(claims) };
}
export async function getSharedPhotoFile(pool, config, sessionId, photoId, shareToken) {
  const { checkoutKey, claims } = await verifyGalleryShare(pool, config, sessionId, shareToken);
  if (typeof photoId !== 'string' || !uuid.test(photoId)) fail(400, 'PHOTO_INVALID', 'Invalid photo identifier.');
  if (claims.scope === 'strip' || (claims.scope === 'photo' && claims.photo_id !== photoId.toLowerCase())) fail(403, 'SHARE_SCOPE_DENIED', 'This link does not grant access to that photo.');
  return getPhotoFile(pool, sessionId, photoId, checkoutKey, policy(config));
}
export async function getSharedStripFile(pool, config, sessionId, shareToken) {
  const { checkoutKey, claims } = await verifyGalleryShare(pool, config, sessionId, shareToken);
  if (claims.scope === 'photo') fail(403, 'SHARE_SCOPE_DENIED', 'This link does not grant access to the photostrip.');
  return getStripFile(pool, sessionId, checkoutKey, policy(config));
}
