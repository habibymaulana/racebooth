import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { savePhotoFile } from '../src/storage.js';
import { checkHermesAvailability, checkN8nConnectivity, recordQualityControlIncident, runQualityControlCheck, getQualityControlStatus, retryFailedEmail, diagnoseIncident } from '../src/qc.js';

const rows = value => ({ rows: value, rowCount: value.length });
const identity = { platform: 'hermes-agent', object: 'hermes.api_server.capabilities' };
const config = { HERMES_ENDPOINT: 'http://hermes.invalid:8642', HERMES_API_KEY: 'private-test-key' };

function diagnosticPool({ files = [], quotas = [], emails = [], failedUploads = 0, failure } = {}) {
  const incidents = [];
  const runs = [];
  const queries = [];
  const pool = {
    incidents, runs, queries,
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (failure?.(sql)) throw new Error('database credentials or internal detail must never become fake success');
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return rows([]);
      if (sql.includes('SELECT 1 AS ok')) return rows([{ ok: 1 }]);
      if (sql.includes('COUNT(*) OVER()')) return rows(files.map(file => ({ kind: 'photo', total: files.length, ...file })));
      if (sql.includes('AS failed FROM session_photos')) return rows([{ failed: failedUploads }]);
      if (sql.includes('AS failed FROM session_photostrips')) return rows([{ failed: 0 }]);
      if (sql.includes('GROUP BY s.id,fs.id')) return rows(quotas);
      if (sql.includes("SELECT id,status FROM free_session_email_deliveries")) return rows(emails);
      if (sql.includes('SELECT category,COUNT')) return rows([]);
      if (sql.includes('SELECT id FROM qc_incidents')) return rows(incidents.filter(item => item.category === values[0] && item.title === values[1] && item.entity_id === values[2]));
      if (sql.includes('INSERT INTO qc_incidents')) {
        const id = randomUUID(); incidents.push({ id, category: values[0], severity: values[1], title: values[2], description: values[3], recommendation: values[4], entity_id: values[5] }); return rows([{ id }]);
      }
      if (sql.includes('UPDATE qc_incidents')) return rows([]);
      if (sql.includes('INSERT INTO qc_runs')) { const record = { id: randomUUID(), created_at: new Date().toISOString(), details: JSON.parse(values[5]) }; runs.push(record); return rows([record]); }
      throw new Error(`Unhandled diagnostic SQL: ${sql}`);
    }
  };
  return pool;
}

test('Hermes is unconfigured without an endpoint and never starts model inference', async () => {
  const result = await checkHermesAvailability({}, async () => { throw new Error('must not be called'); });
  assert.equal(result.status, 'unconfigured');
  assert.equal(result.modelVerified, false);
  assert.equal(result.connected, false);
  assert.equal((await checkHermesAvailability({ HERMES_ENDPOINT: config.HERMES_ENDPOINT })).status, 'unconfigured');
});

test('Hermes verifies real API identity and detailed readiness, not binary presence or HTTP 200 alone', async () => {
  const calls = [];
  const result = await checkHermesAvailability(config, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${config.HERMES_API_KEY}`);
    assert.equal(options.redirect, 'error');
    return Response.json(url.endsWith('/v1/capabilities') ? identity : { status: 'ok', readiness: { status: 'ok', checks: { model: { status: 'ok' } } } });
  });
  assert.equal(result.status, 'ready'); assert.equal(result.connected, true); assert.equal(result.modelVerified, false);
  assert.deepEqual(calls, ['http://hermes.invalid:8642/v1/capabilities', 'http://hermes.invalid:8642/health/detailed']);
  const degraded = await checkHermesAvailability(config, async url => Response.json(url.endsWith('/v1/capabilities') ? identity : { status: 'degraded', readiness: { status: 'degraded' } }));
  assert.equal(degraded.status, 'degraded');
  assert.equal((await checkHermesAvailability(config, async () => Response.json({ status: 'ok' }))).status, 'unverified');
  const unreachable = await checkHermesAvailability(config, async () => { throw new Error('secret-in-upstream-error'); });
  assert.equal(unreachable.status, 'unreachable'); assert.ok(!JSON.stringify(unreachable).includes('secret-in-upstream-error'));
});

test('n8n connectivity uses GET health only and does not trigger a webhook', async () => {
  const result = await checkN8nConnectivity({ N8N_EMAIL_WEBHOOK_URL: 'http://workflow.invalid:5678/webhook/racebooth/photo-result-email' }, async (url, options) => {
    assert.equal(url, 'http://workflow.invalid:5678/healthz'); assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined); return Response.json({ status: 'ok' });
  });
  assert.equal(result.status, 'reachable'); assert.match(result.message, /does not verify/);
  assert.equal((await checkN8nConnectivity({})).status, 'unconfigured');
});

test('incidents deduplicate repeated open findings under a transaction and advisory lock', async () => {
  const pool = diagnosticPool();
  const incident = { category: 'storage', severity: 'critical', title: 'Missing file', description: 'A referenced file is unavailable.', entity_id: randomUUID() };
  assert.equal(await recordQualityControlIncident(pool, incident), await recordQualityControlIncident(pool, incident));
  assert.equal(pool.incidents.length, 1);
  assert.equal(pool.queries.filter(query => query.sql.includes('pg_advisory_xact_lock')).length, 2);
  assert.equal(pool.queries.filter(query => query.sql === 'COMMIT').length, 2);
});

test('QC checks actual private file availability and size, quota mismatches, and unconfirmed email records', async () => {
  const previous = process.env.PHOTO_STORAGE_PATH;
  const root = await mkdtemp(join(tmpdir(), 'racebooth-qc-'));
  process.env.PHOTO_STORAGE_PATH = root;
  try {
    const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#aaccee' } }).jpeg().toBuffer();
    const file = await savePhotoFile(randomUUID(), 1, bytes);
    const pool = diagnosticPool({ files: [
      { id: randomUUID(), storage_path: file.storagePath, file_size_bytes: file.fileSizeBytes },
      { id: randomUUID(), storage_path: file.storagePath, file_size_bytes: 1 },
      { id: randomUUID(), storage_path: `sessions/${randomUUID()}/missing.jpg`, file_size_bytes: 100 },
    ], quotas: [{ id: randomUUID(), actual_photos: 5, photos_taken: 4, photo_limit: 4 }], emails: [{ id: randomUUID(), status: 'pending' }], failedUploads: 1 });
    const result = await runQualityControlCheck(pool, {}, 'test-operator');
    const storage = result.checks.find(check => check.name === 'Private storage consistency');
    assert.equal(storage.checked, 3); assert.equal(storage.inconsistent, 2);
    assert.equal(result.incidents.filter(incident => incident.title === 'Stored image unavailable or inconsistent').length, 2);
    assert.ok(result.incidents.some(incident => incident.category === 'quota'));
    assert.ok(result.incidents.some(incident => incident.title === 'Photo email delivery unconfirmed'));
    assert.equal(pool.runs.length, 1); assert.equal(pool.runs[0].details.checks.length, result.checksRun);
    assert.ok(!pool.queries.some(query => /DELETE|TRUNCATE|UPDATE photobooth_sessions/.test(query.sql)));
  } finally {
    if (previous === undefined) delete process.env.PHOTO_STORAGE_PATH; else process.env.PHOTO_STORAGE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('QC exposes failed checks as unknown and never swallows failed persistence or status queries', async () => {
  const pool = diagnosticPool({ failure: sql => sql.includes('AS failed FROM session_photos') });
  const result = await runQualityControlCheck(pool, {}, 'test-operator');
  assert.equal(result.checks.find(check => check.name === 'Photo upload records').status, 'error');
  assert.ok(result.incidents.some(incident => incident.title === 'Photo upload records check unavailable'));
  assert.ok(!JSON.stringify(result).includes('database credentials'));
  await assert.rejects(runQualityControlCheck(diagnosticPool({ failure: sql => sql.includes('INSERT INTO qc_runs') }), {}, 'test-operator'));
  await assert.rejects(getQualityControlStatus({ query: async () => { throw new Error('database unavailable'); } }, {}));
});

test('operator retry never resets ambiguous pending or sent email deliveries', async () => {
  const queries = [];
  await assert.rejects(retryFailedEmail({ async query(sql) { queries.push(sql); return rows([]); } }, {}, randomUUID()), error => error.code === 'DELIVERY_NOT_RETRYABLE');
  assert.equal(queries.length, 1); assert.match(queries[0], /d.status='failed'/);
  assert.ok(!queries.some(sql => sql.includes('UPDATE')));
});

test('Hermes diagnosis transmits only allowlisted incident metadata and saves only a valid response', async () => {
  const saved = []; const id = randomUUID();
  const pool = { async query(sql, values) {
    if (sql.includes('SELECT category,severity,title')) return rows([{ category: 'email', severity: 'warning', title: 'Photo email delivery failed', description: 'private@example.invalid secret-token' }]);
    if (sql.includes('INSERT INTO qc_diagnoses')) { saved.push(values); return rows([{ id: randomUUID(), severity: values[1], diagnosis: values[2], probable_root_cause: values[3], recommendation: values[4], model: values[5] }]); }
    throw new Error('Unexpected query');
  } };
  const settings = { ...config, HERMES_INFERENCE_ENABLED: true, HERMES_PROVIDER: 'groq', HERMES_MODEL: 'openai/gpt-oss-20b' };
  let calls = 0;
  const goodFetch = async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, `Bearer ${config.HERMES_API_KEY}`);
    if (url.endsWith('/v1/capabilities')) return Response.json({ ...identity, auth: { required: true } });
    if (url.endsWith('/v1/toolsets')) return Response.json({ data: [{ name: 'terminal', enabled: false }] });
    assert.ok(!options.body.includes('private@example.invalid'));
    assert.ok(!options.body.includes('secret-token'));
    assert.ok(!options.body.includes(id));
    return Response.json({ model: 'hermes-agent', choices: [{ message: { content: JSON.stringify({ severity: 'warning', diagnosis: 'Delivery failed.', probable_root_cause: 'The provider may have rejected the request.', recommendation: 'Inspect the workflow manually.' }) } }] });
  };
  const diagnosis = await diagnoseIncident(pool, settings, id, goodFetch);
  assert.equal(diagnosis.severity, 'warning'); assert.equal(diagnosis.model, 'groq:openai/gpt-oss-20b');
  assert.equal(saved.length, 1); assert.equal(calls, 3);
  await assert.rejects(diagnoseIncident(pool, settings, id, async url => url.endsWith('/v1/capabilities')
    ? Response.json({ ...identity, auth: { required: true } }) : Response.json({ data: [{ name: 'terminal', enabled: true }] })), error => error.code === 'HERMES_TOOLS_ENABLED');
  await assert.rejects(diagnoseIncident(pool, settings, id, async url => url.endsWith('/v1/capabilities')
    ? Response.json({ ...identity, auth: { required: true } }) : url.endsWith('/v1/toolsets') ? Response.json({ data: [{ name: 'terminal', enabled: false }] }) : new Response('', { status: 429 })), error => error.code === 'HERMES_RATE_LIMITED');
  assert.equal(saved.length, 1, 'failed or unsafe requests must never save a fabricated diagnosis');
});
