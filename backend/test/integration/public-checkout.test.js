import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { loadConfig } from '../../src/config.js';
import { createManagedPackage, createAutomaticSimulatedCheckout, dashboard, getPublicPackages, getTransaction, updatePackage } from '../../src/services.js';
import { uploadPhoto, getSessionGallery, getPhotoFile, getStripFile, composePhotostrip } from '../../src/photos.js';
import { applyTestMigrations } from './setup.js';

if (process.env.PGHOST !== 'photobooth-phase1-test-db' || process.env.PGDATABASE !== 'photobooth_phase1_test' || process.env.ALLOW_INTEGRATION_DB_SETUP !== 'disposable-container') {
  throw new Error('Refusing public checkout integration setup outside the documented disposable test database.');
}

const storageRoot = await mkdtemp(join(tmpdir(), 'racebooth-checkout-integration-'));
process.env.PHOTO_STORAGE_DRIVER = 'local';
process.env.PHOTO_STORAGE_PATH = storageRoot;
const config = loadConfig({ ...process.env, NODE_ENV: 'test', PHOTO_STORAGE_DRIVER: 'local', PHOTO_STORAGE_PATH: storageRoot,
  N8N_ENABLED: 'false', N8N_EMAIL_ENABLED: 'false', N8N_SIMULATOR_ENABLED: 'false', N8N_WEBHOOK_URL: undefined,
  N8N_EMAIL_WEBHOOK_URL: '', HERMES_ENDPOINT: '', HERMES_API_KEY: '' });
const schema = `checkout_test_${randomBytes(8).toString('hex')}`;
let pool;

before(async () => {
  const setup = new pg.Pool(config.pg);
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { await setup.end(); }
  pool = new pg.Pool({ ...config.pg, options: `-c search_path=${schema},pg_catalog` });
  await pool.query(await readFile(new URL('../../../database/01-schema.sql', import.meta.url), 'utf8'));
  await applyTestMigrations(pool);
});

after(async () => {
  if (pool) await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

test('database packages create atomic simulated payment/session records and replay idempotently', async () => {
  const serviceId = '00000000-0000-4000-8000-000000000001';
  const pkg = await createManagedPackage(pool, {
    name: 'Studio Keepsake', price_idr: 65000, description: 'A four-photo keepsake.',
    benefits: ['12 frame designs', 'Private gallery'], is_active: true, display_order: 1,
  }, 45);
  assert.equal(pkg.photo_limit, 4);
  assert.deepEqual(pkg.benefits, ['12 frame designs', 'Private gallery']);
  assert.equal((await getPublicPackages(pool)).some(item => item.id === pkg.id), true);

  const idempotencyKey = randomUUID();
  const input = { packageId: pkg.id, idempotencyKey, frameDesign: 'retro-checker' };
  const results = await Promise.all([
    createAutomaticSimulatedCheckout(pool, config, input, '127.0.0.21', randomUUID()),
    createAutomaticSimulatedCheckout(pool, config, input, '127.0.0.21', randomUUID()),
  ]);
  assert.equal(new Set(results.map(result => result.transaction.id)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  const checkout = results[0];
  assert.ok(checkout.checkout.id);
  assert.match(checkout.checkout.paymentReference, /^RB-SIM-/);
  assert.equal(checkout.transaction.payment_status, 'paid');
  assert.equal(checkout.transaction.payment_method, 'simulation');
  assert.equal(checkout.transaction.is_simulated, true);
  assert.equal(checkout.transaction.currency_id, 'IDR');
  assert.equal(checkout.transaction.amount_idr, 65000);
  assert.equal(checkout.session.status, 'active');
  assert.equal(checkout.session.photoLimit, 4);
  assert.equal(checkout.sessionKey.length, 64);

  const joined = await pool.query(`SELECT t.id,t.payment_status,t.payment_method,t.is_simulated,t.amount_idr,t.currency_id,t.payment_reference,
    t.paid_at,t.package_snapshot,pcs.id AS checkout_id,pcs.package_id AS checkout_package_id,pcs.simulation_state,pcs.flow_type,pcs.frame_design,
    s.id AS session_id,s.status AS session_status,s.photo_limit,s.access_token_hash
    FROM payment_transactions t JOIN public_checkout_sessions pcs ON pcs.transaction_id=t.id
    JOIN photobooth_sessions s ON s.transaction_id=t.id WHERE t.id=$1`, [checkout.transaction.id]);
  const row = joined.rows[0];
  assert.equal(row.checkout_id, checkout.checkout.id);
  assert.equal(row.checkout_package_id, pkg.id);
  assert.equal(row.session_id, checkout.session.id);
  assert.equal(row.session_status, 'active');
  assert.equal(row.simulation_state, 'completed');
  assert.equal(row.flow_type, 'visitor');
  assert.equal(row.frame_design, 'retro-checker');
  assert.ok(row.paid_at);
  assert.equal(row.package_snapshot.name, 'Studio Keepsake');
  assert.equal(row.access_token_hash.length, 64);
  assert.equal((await pool.query('SELECT COUNT(*)::INT AS count FROM payment_transactions WHERE id=$1', [checkout.transaction.id])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::INT AS count FROM payment_simulation_events WHERE transaction_id=$1 AND status='paid'", [checkout.transaction.id])).rows[0].count, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::INT AS count FROM operator_payment_audit WHERE transaction_id=$1 AND is_simulated=TRUE", [checkout.transaction.id])).rows[0].count, 1);

  const history = await getTransaction(pool, checkout.transaction.id);
  assert.equal(history.package_name, 'Studio Keepsake');
  await updatePackage(pool, pkg.id, { name: 'Studio Keepsake Revised', price_idr: 99000, description: 'Future terms.', benefits: ['New benefit'], display_order: 5 });
  const unchanged = await getTransaction(pool, checkout.transaction.id);
  assert.equal(unchanged.package_name, 'Studio Keepsake');
  assert.equal(Number(unchanged.amount_idr), 65000);
  const baseline = await dashboard(pool, serviceId);
  assert.equal(baseline.stats.realRevenueIdr, '0');
  assert.equal(baseline.stats.simulatedRevenueIdr, '65000');
});

test('simulated visitor sessions retain the four-original capture, filter, frame lock and gallery flow', async () => {
  const pkg = await createManagedPackage(pool, { name: 'Photo set', price_idr: 25000, description: '', benefits: [], is_active: true, display_order: 2 }, 30);
  const checkout = await createAutomaticSimulatedCheckout(pool, config,
    { packageId: pkg.id, idempotencyKey: randomUUID(), frameDesign: 'retro-checker' }, '127.0.0.22', randomUUID());
  const colors = ['#d87c8b', '#6c8ac4', '#83aa86', '#d3a353'];
  for (let sequence = 1; sequence <= 4; sequence++) {
    const photo = await sharp({ create: { width: 320, height: 180, channels: 3, background: colors[sequence - 1] } }).jpeg().toBuffer();
    const saved = await uploadPhoto(pool, checkout.session.id,
      { sequence, checkoutKey: checkout.sessionKey, filter: 'original' }, photo,
      { claimedMime: 'image/jpeg', galleryTtlHours: 24 });
    assert.equal(saved.photo.filter, 'original');
  }

  const gallery = await getSessionGallery(pool, checkout.session.id, checkout.sessionKey, { galleryTtlHours: 24 });
  assert.equal(gallery.photos.length, 4);
  assert.equal(gallery.session.frame_design, 'retro-checker');
  assert.equal(gallery.strip.status, 'composed');
  await assert.rejects(composePhotostrip(pool, checkout.session.id,
    { checkoutKey: checkout.sessionKey, background: 'blueberry', filter: 'original', finalize: false, editRevision: 1 },
    { galleryTtlHours: 24 }), error => error.code === 'FRAME_LOCKED');

  const finalized = await composePhotostrip(pool, checkout.session.id,
    { checkoutKey: checkout.sessionKey, background: 'retro-checker', filter: 'vintage', finalize: true, editRevision: 1 },
    { galleryTtlHours: 24 });
  assert.equal(finalized.strip.is_finalized, true);
  assert.equal(finalized.strip.selected_filter, 'vintage');
  const stripFile = await getStripFile(pool, checkout.session.id, checkout.sessionKey, { download: true, galleryTtlHours: 24 });
  const stripChunks = [];
  for await (const chunk of stripFile.stream) stripChunks.push(chunk);
  assert.ok(Buffer.concat(stripChunks).length > 0);
  const photoId = gallery.photos[0].id;
  const original = await getPhotoFile(pool, checkout.session.id, photoId, checkout.sessionKey, { download: true, galleryTtlHours: 24 });
  assert.match(original.filename, /photo-01/);
  const savedRows = await pool.query('SELECT COUNT(*)::INT AS count FROM session_photos WHERE session_id=$1 AND filter=$2', [checkout.session.id, 'original']);
  assert.equal(savedRows.rows[0].count, 4);
  assert.equal((await pool.query('SELECT status FROM photobooth_sessions WHERE id=$1', [checkout.session.id])).rows[0].status, 'completed');
});
