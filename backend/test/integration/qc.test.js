import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../../src/config.js';
import { createFreeSession } from '../../src/free-sessions.js';
import { dashboard } from '../../src/services.js';
import { applyTestMigrations } from './setup.js';
import { recordQualityControlIncident, runQualityControlCheck, getQualityControlStatus, diagnoseIncident } from '../../src/qc.js';

if (process.env.PGHOST !== 'photobooth-phase1-test-db' || process.env.PGDATABASE !== 'photobooth_phase1_test' || process.env.ALLOW_INTEGRATION_DB_SETUP !== 'disposable-container') {
  throw new Error('Refusing QC integration setup outside the documented disposable test database.');
}
const config = loadConfig({ ...process.env, NODE_ENV: 'test', N8N_ENABLED: 'false', N8N_EMAIL_ENABLED: 'false', N8N_WEBHOOK_URL: undefined, N8N_EMAIL_WEBHOOK_URL: '', HERMES_ENDPOINT: '', HERMES_API_KEY: '' });
const schema = `qc_test_${randomBytes(8).toString('hex')}`;
let pool, storageRoot, previousStorageRoot;

before(async () => {
  const setup = new pg.Pool(config.pg);
  try { await setup.query(`CREATE SCHEMA ${schema}`); } finally { await setup.end(); }
  pool = new pg.Pool({ ...config.pg, options: `-c search_path=${schema},pg_catalog` });
  storageRoot = await mkdtemp(join(tmpdir(), 'racebooth-qc-integration-'));
  previousStorageRoot = process.env.PHOTO_STORAGE_PATH;
  process.env.PHOTO_STORAGE_PATH = storageRoot;
  await pool.query(await readFile(new URL('../../../database/01-schema.sql', import.meta.url), 'utf8'));
  await applyTestMigrations(pool);
});
after(async () => {
  if (pool) await pool.end();
  if (previousStorageRoot === undefined) delete process.env.PHOTO_STORAGE_PATH; else process.env.PHOTO_STORAGE_PATH = previousStorageRoot;
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

test('simultaneous real-DB incident reports preserve one open record', async () => {
  const entity = randomUUID();
  const incident = { category: 'api', severity: 'warning', title: 'Integration request failure', description: 'Synthetic failure in the isolated test database.', entity_id: entity };
  const ids = await Promise.all(Array.from({ length: 12 }, () => recordQualityControlIncident(pool, incident)));
  assert.equal(new Set(ids).size, 1);
  assert.equal((await pool.query('SELECT id FROM qc_incidents WHERE entity_id=$1', [entity])).rowCount, 1);
});

test('real-schema QC persists actual file/counter findings and reports them through status', async () => {
  const session = await createFreeSession(pool, config, { frameDesign: 'blueberry', clientIp: '127.0.0.3' });
  const photoId = randomUUID();
  await pool.query(`INSERT INTO session_photos(id,session_id,sequence,status,filter,storage_path,file_size_bytes)
    VALUES($1,$2,1,'saved','original',$3,1234)`, [photoId, session.sessionId, `sessions/${session.sessionId}/missing-test-file.jpg`]);
  const result = await runQualityControlCheck(pool, config, 'disposable-qc-test');
  assert.equal(result.checks.some(check => check.status === 'error'), false, 'Every diagnostic SQL statement must execute against the full migration schema.');
  assert.equal(result.checks.find(check => check.name === 'Private storage consistency').inconsistent, 1);
  assert.equal(result.checks.find(check => check.name === 'Session quota consistency').inconsistent, 1);
  const status = await getQualityControlStatus(pool, config);
  assert.equal(status.lastRun.id, result.runId);
  assert.ok(status.lastRun.details.checks.length >= 8);
  assert.ok(status.incidents.some(incident => incident.entity_id === photoId && incident.category === 'storage'));
  assert.ok(status.counts.critical_count >= 2);
  const countBefore = (await pool.query("SELECT COUNT(*)::INT AS count FROM qc_incidents WHERE status='open'")).rows[0].count;
  await runQualityControlCheck(pool, config, 'disposable-qc-test');
  const countAfter = (await pool.query("SELECT COUNT(*)::INT AS count FROM qc_incidents WHERE status='open'")).rows[0].count;
  assert.equal(countAfter, countBefore, 'Repeated scans should not duplicate open findings.');
  assert.equal(status.hermes.status, 'unconfigured');
  assert.equal((await pool.query('SELECT status,photos_taken FROM photobooth_sessions WHERE id=$1', [session.sessionId])).rows[0].photos_taken, 0, 'QC must not change the mismatched business record.');
});


test('operator dashboard metrics reflect free sessions, historical revenue, and delivery records', async () => {
  const service = '00000000-0000-4000-8000-000000000001';
  const baseline = await dashboard(pool, service);
  const activeBefore = baseline.stats.activeSessions;
  const session = await createFreeSession(pool, config, { frameDesign: 'pink-diary', clientIp: '127.0.0.4' });
  const sessionRow = (await pool.query('SELECT package_id FROM photobooth_sessions WHERE id=$1', [session.sessionId])).rows[0];
  await pool.query(`INSERT INTO payment_transactions(package_id,operator_id,amount_idr,payment_method,payment_status,is_simulated,paid_at)
    VALUES($1,$2,72000,'cash','paid',FALSE,NOW()),($1,$2,18000,'qris','paid',TRUE,NOW())`, [sessionRow.package_id, service]);
  await pool.query(`INSERT INTO free_session_email_deliveries(free_session_id,recipient_email,gallery_url,status,sent_at)
    VALUES($1,'fixture@example.invalid','http://localhost:8088/test','sent',NOW()),($1,'failed@example.invalid','http://localhost:8088/test','failed',NULL)`, [session.freeSessionId]);
  const current = await dashboard(pool, service);
  assert.equal(current.stats.totalFreeSessions, baseline.stats.totalFreeSessions + 1);
  assert.equal(current.stats.activeSessions, activeBefore + 1);
  assert.equal(BigInt(current.stats.realRevenueIdr) - BigInt(baseline.stats.realRevenueIdr), 72000n);
  assert.equal(BigInt(current.stats.simulatedRevenueIdr) - BigInt(baseline.stats.simulatedRevenueIdr), 18000n);
  assert.equal(current.stats.emailsSent, baseline.stats.emailsSent + 1);
  assert.equal(current.stats.emailsFailed, baseline.stats.emailsFailed + 1);
  assert.ok(current.popularFrames.some(row => row.frame_design === 'pink-diary' && row.count === 1));
  assert.ok(current.recentFreeSessions.some(row => row.id === session.freeSessionId && row.photos_saved === 0));
});

test('a mocked Hermes response is persisted in PostgreSQL and exposed for the protected dashboard', async () => {
  const id = await recordQualityControlIncident(pool, { category: 'storage', severity: 'warning', title: 'Stored image unavailable or inconsistent', description: 'Synthetic diagnostic incident.' });
  const settings = { ...config, HERMES_ENDPOINT: 'http://hermes.invalid', HERMES_API_KEY: 'test-only-secret', HERMES_INFERENCE_ENABLED: true };
  const provider = async url => {
    if (url.endsWith('/v1/capabilities')) return Response.json({ platform: 'hermes-agent', object: 'hermes.api_server.capabilities', auth: { required: true } });
    if (url.endsWith('/v1/toolsets')) return Response.json({ data: [{ name: 'terminal', enabled: false }] });
    return Response.json({ model: 'hermes-test', choices: [{ message: { content: JSON.stringify({ severity: 'warning', diagnosis: 'A stored image could not be verified.', probable_root_cause: 'A storage issue is possible.', recommendation: 'Inspect the storage path manually.' }) } }] });
  };
  const diagnosis = await diagnoseIncident(pool, settings, id, provider);
  assert.equal(diagnosis.model, 'hermes-test');
  assert.equal((await pool.query('SELECT COUNT(*)::INT AS count FROM qc_diagnoses WHERE incident_id=$1', [id])).rows[0].count, 1);
  const dashboard = await getQualityControlStatus(pool, config);
  assert.equal(dashboard.incidents.find(incident => incident.id === id).ai_diagnosis.diagnosis, 'A stored image could not be verified.');
});
