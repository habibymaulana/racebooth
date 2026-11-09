import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { loadConfig } from '../../src/config.js';
import {
  uploadPhoto, getSessionGallery, composePhotostrip, getPhotoFile, getStripFile,
} from '../../src/photos.js';
import { resolveStoragePath, MAX_UPLOAD_BYTES, saveStripFile } from '../../src/storage.js';
import { cleanExpiredPhotoAssets } from '../../src/photo-retention.js';
import { createApp } from '../../src/app.js';
import { applyTestMigrations } from './setup.js';

// This suite owns a schema inside the disposable test database, so it cannot race
// the business suite's independent public-schema initialization.
if (process.env.PGHOST !== 'photobooth-phase1-test-db' || process.env.PGDATABASE !== 'photobooth_phase1_test' || process.env.ALLOW_INTEGRATION_DB_SETUP !== 'disposable-container') {
  throw new Error('Refusing photo integration setup outside the documented disposable test database.');
}
const config = loadConfig({ ...process.env, NODE_ENV: 'test', COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '0', APP_ORIGINS: 'http://localhost:8088', PUBLIC_APP_ORIGIN: '',
  N8N_ENABLED: 'false', N8N_WEBHOOK_URL: undefined, N8N_EMAIL_ENABLED: 'false', N8N_EMAIL_WEBHOOK_URL: '', N8N_EMAIL_WEBHOOK_SECRET: '',
  HERMES_ENDPOINT: '', HERMES_API_KEY: '', N8N_SIMULATOR_ENABLED: 'false' });
const schema = `photo_test_${randomBytes(8).toString('hex')}`;
let pool, storageRoot, originalStorageRoot, originalStorageDriver, pkg;
const serviceId = '00000000-0000-4000-8000-000000000001';

async function image(color = { r: 210, g: 90, b: 50 }) {
  return sharp({ create: { width: 240, height: 180, channels: 3, background: color } }).png().toBuffer();
}
async function fixture({ limit = 4, expiresAt = new Date(Date.now() + 15 * 60000), status = 'pending' } = {}) {
  const tx = (await pool.query(`INSERT INTO payment_transactions(package_id,operator_id,amount_idr,payment_method,payment_status,is_simulated,paid_at)
    VALUES($1,$2,75000,'qris','paid',TRUE,NOW()) RETURNING id`, [pkg.id, serviceId])).rows[0];
  const key = randomBytes(32).toString('hex');
  const rawToken = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO public_checkout_sessions(transaction_id,checkout_key,package_id,package_snapshot) VALUES($1,$2,$3,$4)', [tx.id, key, pkg.id, JSON.stringify(pkg)]);
  const s = (await pool.query(`INSERT INTO photobooth_sessions(transaction_id,operator_id,package_id,idempotency_key,access_token_hash,photo_limit,token_expires_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [tx.id, serviceId, pkg.id, randomBytes(32).toString('hex'), createHash('sha256').update(rawToken).digest('hex'), limit, expiresAt, status])).rows[0];
  return { ...s, key, rawToken, transactionId: tx.id };
}
async function upload(s, sequence, buffer, filter = 'original') {
  return uploadPhoto(pool, s.id, { sequence, filter, checkoutKey: s.key }, buffer, { claimedMime: 'image/png', galleryTtlHours: 24 });
}
async function fill(s) {
  const accepted = [];
  for (let sequence = 1; sequence <= s.photo_limit; sequence++) {
    accepted.push(await upload(s, sequence, await image({ r: sequence * 45, g: 200 - sequence * 25, b: sequence * 35 })));
  }
  return accepted;
}
async function streamBuffer(result) {
  const chunks = []; for await (const chunk of result.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function assertPrivateMetadata(value) {
  for (const [key, nested] of Object.entries(value || {})) {
    assert.equal(['storage_path', 'download_token', 'checkout_key', 'access_token_hash'].includes(key), false, `private metadata ${key} leaked`);
    if (nested && typeof nested === 'object' && !(nested instanceof Date)) assertPrivateMetadata(nested);
  }
}

before(async () => {
  const setup = new pg.Pool(config.pg);
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { await setup.end(); }
  pool = new pg.Pool({ ...config.pg, options: `-c search_path=${schema},pg_catalog` });
  storageRoot = await mkdtemp(join(tmpdir(), 'lumi-photo-integration-'));
  originalStorageRoot = process.env.PHOTO_STORAGE_PATH;
  originalStorageDriver = process.env.PHOTO_STORAGE_DRIVER;
  process.env.PHOTO_STORAGE_PATH = storageRoot;
  process.env.PHOTO_STORAGE_DRIVER = 'local';
  await pool.query(await readFile(new URL('../../../database/01-schema.sql', import.meta.url), 'utf8'));
  await applyTestMigrations(pool);
  pkg = (await pool.query("INSERT INTO photo_packages(name,price_idr,photo_limit,session_duration_minutes) VALUES('Four real photos',75000,4,15) RETURNING *")).rows[0];
});
after(async () => {
  if (pool) await pool.end();
  if (originalStorageRoot === undefined) delete process.env.PHOTO_STORAGE_PATH; else process.env.PHOTO_STORAGE_PATH = originalStorageRoot;
  if (originalStorageDriver === undefined) delete process.env.PHOTO_STORAGE_DRIVER; else process.env.PHOTO_STORAGE_DRIVER = originalStorageDriver;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

test('fresh base schema receives simulated-payment tracking from additive migration 12', async () => {
  const column = await pool.query(`SELECT column_default,is_nullable FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='payment_transactions' AND column_name='is_simulated'`, [schema]);
  assert.equal(column.rowCount, 1);
  assert.equal(column.rows[0].column_default, 'false');
  assert.equal(column.rows[0].is_nullable, 'NO');
  assert.equal((await pool.query("SELECT count(*)::INT AS n FROM operator_schema_migrations WHERE name='12-simulated-payment-tracking'", [])).rows[0].n, 1);
});

test('accepted uploads are real persistent JPEG files with dimensions and private public metadata', async () => {
  const s = await fixture();
  const result = await upload(s, 1, await image(), 'bw');
  assert.equal(result.replayed, false); assert.equal(result.photo.sequence, 1);
  assertPrivateMetadata(result);
  const row = (await pool.query('SELECT * FROM session_photos WHERE session_id=$1', [s.id])).rows[0];
  assert.equal(row.status, 'saved'); assert.ok(row.file_size_bytes > 0);
  assert.equal(row.width_px, 240); assert.equal(row.height_px, 180);
  const stored = await readFile(resolveStoragePath(row.storage_path));
  assert.equal((await sharp(stored).metadata()).format, 'jpeg');
  const state = (await pool.query('SELECT status,photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0];
  assert.equal(state.photos_taken, 1); assert.equal(state.status, 'active');
  assert.deepEqual(await streamBuffer(await getPhotoFile(pool, s.id, row.id, s.key)), stored);
});

test('concurrent retries count exactly four accepted slots, and different contents cannot replace a confirmed slot', async () => {
  const s = await fixture(); const bytes = await image();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(s, i % 4 + 1, bytes)));
  assert.equal(results.filter(r => !r.replayed).length, 4);
  assert.equal(new Set(results.map(r => r.photo.id)).size, 4);
  const state = (await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0];
  assert.equal(state.photos_taken, 4);
  assert.equal((await pool.query("SELECT count(*)::INT AS n FROM session_photos WHERE session_id=$1 AND status='saved'", [s.id])).rows[0].n, 4);
  await assert.rejects(upload(s, 5, bytes), e => e.status >= 400 && e.status < 500);
  await assert.rejects(upload(s, 0, bytes), e => e.status >= 400 && e.status < 500);
  await assert.rejects(upload(s, 1, await image({ r: 20, g: 40, b: 240 })), e => e.code === 'PHOTO_SEQUENCE_CONFLICT');
  await assert.rejects(upload(s, 1, bytes, 'bw'), e => e.code === 'PHOTO_SEQUENCE_CONFLICT');
  assert.equal((await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0].photos_taken, 4);
});

test('a failed storage write consumes no quota and the same sequence can safely retry', async () => {
  const s = await fixture(); const bytes = await image();
  const previousRoot = process.env.PHOTO_STORAGE_PATH;
  process.env.PHOTO_STORAGE_PATH = '/dev/null/not-a-directory';
  try { await assert.rejects(upload(s, 1, bytes)); } finally { process.env.PHOTO_STORAGE_PATH = previousRoot; }
  assert.equal((await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0].photos_taken, 0);
  assert.equal((await pool.query("SELECT count(*)::INT AS n FROM session_photos WHERE session_id=$1 AND status='saved'", [s.id])).rows[0].n, 0);
  const retried = await upload(s, 1, bytes);
  assert.equal(retried.replayed, false);
  assert.equal((await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0].photos_taken, 1);
});

test('capture expiry blocks uploads and composition while stored gallery remains available only in its retention window', async () => {
  const s = await fixture(); await upload(s, 1, await image());
  await pool.query("UPDATE photobooth_sessions SET token_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [s.id]);
  await assert.rejects(upload(s, 2, await image()), e => e.status === 410);
  await assert.rejects(composePhotostrip(pool, s.id, { background: 'white', checkoutKey: s.key }), e => e.status === 410);
  const gallery = await getSessionGallery(pool, s.id, s.key, { galleryTtlHours: 24 });
  assert.equal(gallery.photos.length, 1);
  await pool.query("UPDATE photobooth_sessions SET token_expires_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [s.id]);
  await assert.rejects(getSessionGallery(pool, s.id, s.key, { galleryTtlHours: 24 }), e => e.status === 410);
});

test('session capabilities cannot authorize another visitor photo, gallery, upload, or strip', async () => {
  const owner = await fixture(); const other = await fixture();
  const bytes = await image();
  const saved = await upload(owner, 1, bytes);
  assert.equal((await getSessionGallery(pool, owner.id, owner.rawToken)).photos.length, 1, 'existing hashed session-token access remains valid');
  for (const operation of [
    () => getSessionGallery(pool, owner.id, other.key),
    () => getPhotoFile(pool, owner.id, saved.photo.id, other.key),
    () => getPhotoFile(pool, other.id, saved.photo.id, other.key),
    () => uploadPhoto(pool, owner.id, { sequence: 2, filter: 'original', checkoutKey: other.key }, bytes),
    () => composePhotostrip(pool, owner.id, { background: 'white', checkoutKey: other.key }),
    () => getStripFile(pool, owner.id, other.key),
  ]) await assert.rejects(operation(), e => e.status >= 400 && e.status < 500);
  assert.equal((await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [owner.id])).rows[0].photos_taken, 1);
});

test('cancelled or refunded sessions revoke gallery and download access', async () => {
  for (const revoked of ['cancelled', 'refunded']) {
    const s = await fixture(); const result = await upload(s, 1, await image());
    await pool.query('UPDATE payment_transactions SET payment_status=$2 WHERE id=$1', [s.transactionId, revoked]);
    await assert.rejects(getSessionGallery(pool, s.id, s.key), e => e.status >= 400 && e.status < 500);
    await assert.rejects(getPhotoFile(pool, s.id, result.photo.id, s.key), e => e.status >= 400 && e.status < 500);
  }
  const unpaid = await fixture();
  await pool.query('UPDATE payment_transactions SET paid_at=NULL WHERE id=$1', [unpaid.transactionId]);
  await assert.rejects(upload(unpaid, 1, await image()), e => e.status >= 400 && e.status < 500);
});

test('server composes an actual vertical photostrip only from all accepted images and completes the session', async () => {
  const s = await fixture();
  await assert.rejects(composePhotostrip(pool, s.id, { background: 'mint', checkoutKey: s.key }), e => e.code === 'PHOTOS_INCOMPLETE');
  await fill(s);
  const compositions = await Promise.all(Array.from({ length: 6 }, () => composePhotostrip(pool, s.id, { background: 'mint', checkoutKey: s.key })));
  assert.equal(compositions.filter(result => !result.replayed).length, 1);
  assert.equal(new Set(compositions.map(result => result.strip.id)).size, 1);
  compositions.forEach(assertPrivateMetadata);
  const gallery = await getSessionGallery(pool, s.id, s.key);
  assert.equal(gallery.photos.length, 4); assert.equal(gallery.strip.status, 'composed');
  assertPrivateMetadata(gallery);
  const bytes = await streamBuffer(await getStripFile(pool, s.id, s.key));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.ok(metadata.height > metadata.width * 2, 'strip must be vertical');
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const colors = new Set();
  for (let y = 0; y < info.height; y += Math.max(1, Math.floor(info.height / 32))) {
    const offset = (y * info.width + Math.floor(info.width / 2)) * info.channels;
    colors.add([...data.subarray(offset, offset + 3)].map(n => Math.round(n / 20)).join(','));
  }
  assert.ok(colors.size >= 4, 'strip must contain the accepted images, not a blank placeholder');
  assert.equal((await pool.query('SELECT status,photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0].status, 'completed');
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM session_photostrips WHERE session_id=$1', [s.id])).rows[0].n, 1);
  await assert.rejects(composePhotostrip(pool, s.id, { background: 'black', checkoutKey: s.key }), e => e.code === 'STRIP_ALREADY_COMPOSED');
  const replay = await upload(s, 1, await image({ r: 45, g: 175, b: 35 }));
  assert.equal(replay.replayed, true, 'a lost upload response can be recovered after strip completion');
});

test('HTTP photo routes enforce session capabilities, real bytes, quota, MIME validation, and body limits', async () => {
  const s = await fixture({ limit: 1 }); const other = await fixture();
  const bytes = await image();
  const app = createApp({ pool, config });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/public/sessions`;
    const uploadRequest = (overrides = {}) => {
      const { key = s.key, sequence = '1', filter = 'bw', mime = 'image/png', body = bytes } = overrides;
      return fetch(`${base}/${s.id}/photos`, { method: 'POST', headers: {
        ...(key === null ? {} : { 'X-Checkout-Key': key }),
        ...(sequence === null ? {} : { 'X-Photo-Sequence': sequence }),
        'X-Photo-Filter': filter, 'Content-Type': mime,
      }, body });
    };
    const rejected = await uploadRequest({ key: null });
    assert.equal(rejected.status, 403); assert.equal((await rejected.json()).error.code, 'SESSION_ACCESS_DENIED');
    const unauthorized = await uploadRequest({ key: other.key });
    assert.equal(unauthorized.status, 403); await unauthorized.arrayBuffer();
    const created = await uploadRequest();
    assert.equal(created.status, 201);
    const result = await created.json(); assertPrivateMetadata(result);
    assert.equal(result.photo.filter, 'bw'); assert.equal(result.photo.sequence, 1);
    const retry = await uploadRequest(); assert.equal(retry.status, 200);
    assert.equal((await retry.json()).photo.id, result.photo.id);
    const overflow = await uploadRequest({ sequence: '2' }); assert.equal(overflow.status, 422); await overflow.arrayBuffer();
    const conflict = await uploadRequest({ body: await image({ r: 15, g: 30, b: 220 }) });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'PHOTO_SEQUENCE_CONFLICT');
    const spoofed = await uploadRequest({ mime: 'image/jpeg' });
    assert.equal(spoofed.status, 415); assert.equal((await spoofed.json()).error.code, 'IMAGE_MIME_MISMATCH');
    const oversized = await uploadRequest({ body: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1) });
    assert.equal(oversized.status, 413); assert.equal((await oversized.json()).error.code, 'REQUEST_TOO_LARGE');
    const missingSequence = await uploadRequest({ sequence: null });
    assert.equal(missingSequence.status, 400); await missingSequence.arrayBuffer();
    const validAfterErrors = await uploadRequest();
    assert.equal(validAfterErrors.status, 200, 'body-parser failures must release upload admission'); await validAfterErrors.arrayBuffer();
    const gallery = await fetch(`${base}/${s.id}/gallery`, { headers: { 'X-Checkout-Key': s.key } });
    assert.equal(gallery.status, 200);
    const galleryResult = await gallery.json(); assert.equal(galleryResult.photos.length, 1); assertPrivateMetadata(galleryResult);
    const fileUrl = `${base}/${s.id}/photos/${result.photo.id}/file`;
    const noKeyDownload = await fetch(fileUrl); assert.equal(noKeyDownload.status, 403); await noKeyDownload.arrayBuffer();
    const queryKeyDownload = await fetch(`${fileUrl}?key=${s.key}`); assert.equal(queryKeyDownload.status, 403); await queryKeyDownload.arrayBuffer();
    const download = await fetch(`${fileUrl}?download=1`, { headers: { 'X-Checkout-Key': s.key } });
    assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /^image\/jpeg/);
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="racebooth-photo-01\.jpg"$/);
    assert.equal(download.headers.get('cache-control'), 'private, no-store'); assert.equal(download.headers.get('referrer-policy'), 'no-referrer');
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    assert.equal((await sharp(downloadedBytes).metadata()).format, 'jpeg');
    assert.equal(downloadedBytes.length, Number(download.headers.get('content-length')));
    const bodyTooLarge = await fetch(`${base}/${s.id}/photostrip`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Checkout-Key': s.key }, body: JSON.stringify({ background: 'white', extra: 'x'.repeat(17000) }) });
    assert.equal(bodyTooLarge.status, 413); await bodyTooLarge.arrayBuffer();
    assert.equal((await pool.query('SELECT photos_taken FROM photobooth_sessions WHERE id=$1', [s.id])).rows[0].photos_taken, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('photo retention dry-run is safe and apply removes only assets beyond gallery expiry', async () => {
  const expired = await fixture();
  await upload(expired, 1, await image());
  const strip = await saveStripFile(expired.id, await image({ r: 30, g: 60, b: 180 }));
  await pool.query(`INSERT INTO session_photostrips(session_id,status,background,storage_path,file_size_bytes,is_finalized)
    VALUES($1,'composed','white',$2,$3,TRUE)`, [expired.id, strip.storagePath, strip.fileSizeBytes]);
  await pool.query("UPDATE photobooth_sessions SET token_expires_at=NOW()-INTERVAL '25 hours' WHERE id=$1", [expired.id]);
  const expiredPhoto = (await pool.query('SELECT storage_path FROM session_photos WHERE session_id=$1', [expired.id])).rows[0].storage_path;
  const expiredPhotoBytes = await readFile(resolveStoragePath(expiredPhoto));

  const active = await fixture();
  await upload(active, 1, await image({ r: 20, g: 190, b: 70 }));
  const activePhoto = (await pool.query('SELECT storage_path FROM session_photos WHERE session_id=$1', [active.id])).rows[0].storage_path;
  const activeBytes = await readFile(resolveStoragePath(activePhoto));

  const dryRun = await cleanExpiredPhotoAssets(pool, { galleryTtlHours: 24, batchSize: 100 });
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.scanned >= 2);
  assert.equal(dryRun.deletedRecords, 0);
  assert.deepEqual(await readFile(resolveStoragePath(expiredPhoto)), expiredPhotoBytes);

  const report = await cleanExpiredPhotoAssets(pool, { galleryTtlHours: 24, batchSize: 100, apply: true });
  assert.equal(report.dryRun, false);
  assert.ok(report.deletedRecords >= 2);
  assert.ok(report.deletedFiles >= 2);
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM session_photos WHERE session_id=$1', [expired.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM session_photostrips WHERE session_id=$1', [expired.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM photobooth_sessions WHERE id=$1', [expired.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM payment_transactions WHERE id=$1', [expired.transactionId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::INT AS n FROM session_photos WHERE session_id=$1', [active.id])).rows[0].n, 1);
  assert.deepEqual(await readFile(resolveStoragePath(activePhoto)), activeBytes);
  await assert.rejects(readFile(resolveStoragePath(expiredPhoto)), error => error.code === 'ENOENT');
  await assert.rejects(readFile(resolveStoragePath(strip.storagePath)), error => error.code === 'ENOENT');
});
