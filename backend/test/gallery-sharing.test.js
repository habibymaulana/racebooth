import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  deriveGallerySigningKey, createGalleryShare, verifyGalleryShare,
  getSharedGallery, getSharedPhotoFile, getSharedStripFile,
} from '../src/gallery-sharing.js';

function fixture({ scope = 'gallery', ttl = 60 } = {}) {
  const config = { TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PHOTO_GALLERY_TTL_HOURS: 24, PHOTO_SHARE_TTL_MINUTES: ttl };
  const session = {
    id: randomUUID(), status: 'completed', photo_limit: 4, photos_taken: 4,
    token_expires_at: new Date(Date.now() + 15 * 60000).toISOString(), created_at: new Date().toISOString(),
    package_name: 'Four real photos', session_duration_minutes: 15,
    payment_status: 'paid', paid_at: new Date().toISOString(), cancelled_at: null, refunded_at: null,
    checkout_key: randomBytes(32).toString('hex'), access_token_hash: randomBytes(32).toString('hex'),
  };
  const photo = { id: randomUUID(), session_id: session.id, sequence: 1, filter: 'original', status: 'saved', file_size_bytes: 1000, width_px: 240, height_px: 180, created_at: session.created_at };
  const strip = { id: randomUUID(), session_id: session.id, status: 'composed', background: 'white', file_size_bytes: 3000, created_at: session.created_at };
  const pool = {
    queries: [],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      if (sql.includes('FROM photobooth_sessions')) return { rowCount: 1, rows: [{ ...session }] };
      if (sql.includes('FROM session_photostrips')) return { rowCount: 1, rows: [{ ...strip }] };
      if (sql.includes('FROM session_photos')) {
        const hasUnrelatedId = values.some(value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) && value !== session.id && value !== photo.id);
        return hasUnrelatedId ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ ...photo }] };
      }
      throw new Error('Unexpected query in gallery signing fixture.');
    },
  };
  return { pool, config, session, photo, strip, request: { scope, ...(scope === 'photo' ? { photoId: photo.id } : {}) } };
}

test('gallery signing derives a stable purpose-specific key without reusing the encryption key', () => {
  const config = { TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
  const derived = deriveGallerySigningKey(config);
  assert.deepEqual(deriveGallerySigningKey(config), derived);
  assert.notDeepEqual(derived, Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex'));
  assert.notDeepEqual(deriveGallerySigningKey({ TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex') }), derived);
});

test('gallery shares contain only signed read scope, session binding, bounded expiry, and an unpredictable identifier', async () => {
  const f = fixture({ scope: 'photo' });
  const first = await createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, f.request);
  const second = await createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, f.request);
  const claims = jwt.verify(first.shareToken, deriveGallerySigningKey(f.config), { algorithms: ['HS256'], issuer: 'photobooth-backend', audience: 'photobooth-gallery', subject: f.session.id });
  assert.equal(claims.scope, 'photo'); assert.equal(claims.photo_id, f.photo.id); assert.equal(claims.ver, 1);
  assert.notEqual(claims.jti, jwt.decode(second.shareToken).jti);
  assert.ok(claims.jti.length >= 32); assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 3600);
  assert.equal(first.scope, 'photo'); assert.equal(first.photoId, f.photo.id);
  assert.equal(JSON.stringify(first).includes(f.session.checkout_key), false);
  assert.equal(JSON.stringify(claims).includes(f.session.checkout_key), false);
  assert.equal(JSON.stringify(claims).includes(f.session.access_token_hash), false);
});

test('shared tokens reject tampering, wrong identity, scope, algorithm, and expiration before database access', async () => {
  const f = fixture(); const key = deriveGallerySigningKey(f.config);
  const claims = { ver: 1, scope: 'gallery', cap: randomBytes(32).toString('hex') };
  const options = { algorithm: 'HS256', issuer: 'photobooth-backend', audience: 'photobooth-gallery', subject: f.session.id, expiresIn: 60, jwtid: randomBytes(32).toString('hex') };
  const forbiddenDb = { async query() { assert.fail('Invalid share tokens must be rejected before database access.'); } };
  for (const invalid of [
    '', 'not-a-jwt', jwt.sign(claims, randomBytes(32), options),
    jwt.sign(claims, key, { ...options, issuer: 'other-app' }),
    jwt.sign(claims, key, { ...options, audience: 'payment-api' }),
    jwt.sign(claims, key, { ...options, subject: randomUUID() }),
    jwt.sign(claims, key, { ...options, expiresIn: -1 }),
    jwt.sign(claims, key, { ...options, algorithm: 'HS384' }),
    jwt.sign({ ...claims, scope: 'capture' }, key, options),
    jwt.sign({ ...claims, scope: 'photo' }, key, options),
    jwt.sign({ ...claims, ver: 2 }, key, options),
  ]) await assert.rejects(verifyGalleryShare(forbiddenDb, f.config, f.session.id, invalid), error => error.status >= 400 && error.status < 500);
});

test('gallery scopes expose only the permitted photo or strip and cannot authorize another resource', async () => {
  for (const scope of ['gallery', 'photo', 'strip']) {
    const f = fixture({ scope });
    const shared = await createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, f.request);
    const gallery = await getSharedGallery(f.pool, f.config, f.session.id, shared.shareToken);
    assert.equal(gallery.scope, scope);
    assert.equal(gallery.photos.length, scope === 'strip' ? 0 : 1);
    assert.equal(Boolean(gallery.strip), scope !== 'photo');
    assert.equal(JSON.stringify(gallery).includes(f.session.checkout_key), false);
    assert.equal(JSON.stringify(gallery).includes(f.session.access_token_hash), false);
    await assert.rejects(getSharedPhotoFile(f.pool, f.config, f.session.id, randomUUID(), shared.shareToken), error => error.status >= 400 && error.status < 500);
    if (scope === 'photo') await assert.rejects(getSharedStripFile(f.pool, f.config, f.session.id, shared.shareToken), error => error.status === 403);
    if (scope === 'strip') await assert.rejects(getSharedPhotoFile(f.pool, f.config, f.session.id, f.photo.id, shared.shareToken), error => error.status === 403);
  }
});

test('payment revocation and checkout capability rotation invalidate previously issued share links', async () => {
  const f = fixture();
  const created = await createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, f.request);
  assert.ok((await verifyGalleryShare(f.pool, f.config, f.session.id, created.shareToken)).session);
  const previousKey = f.session.checkout_key; f.session.checkout_key = randomBytes(32).toString('hex');
  await assert.rejects(verifyGalleryShare(f.pool, f.config, f.session.id, created.shareToken), error => error.status === 403);
  f.session.checkout_key = previousKey; f.session.payment_status = 'refunded';
  await assert.rejects(verifyGalleryShare(f.pool, f.config, f.session.id, created.shareToken), error => error.status === 403);
});

test('share expiry is capped by gallery retention and cannot enable missing or invalid scopes', async () => {
  const f = fixture({ ttl: 60 });
  f.session.token_expires_at = new Date(Date.now() - (24 * 3600000 - 90000)).toISOString();
  const created = await createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, f.request);
  assert.ok(new Date(created.expiresAt).getTime() <= Date.now() + 91000);
  await assert.rejects(createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, { scope: 'capture' }), error => error.status >= 400 && error.status < 500);
  await assert.rejects(createGalleryShare(f.pool, f.config, f.session.id, f.session.checkout_key, { scope: 'photo', photoId: randomUUID() }), error => error.status >= 400 && error.status < 500);
  f.session.checkout_key = null;
  await assert.rejects(createGalleryShare(f.pool, f.config, f.session.id, randomBytes(32).toString('hex'), { scope: 'gallery' }), error => error.status >= 400 && error.status < 500);
});
