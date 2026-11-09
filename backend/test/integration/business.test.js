import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createPool } from '../../src/db.js';
import { hashPassword, tokenHash, signPayload } from '../../src/security.js';
import {
  createTransaction, confirmSimulation, dashboard, updatePackage, getTransaction,
  createPublicTransaction, getPublicTransaction, handlePaymentNotification,
  getPublicSession
} from '../../src/services.js';
import { issueToken, signWorkflowJwt } from '../../src/n8n.js';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { applyTestMigrations } from './setup.js';

// Only a disposable, isolated PostgreSQL container may be initialized by this suite.
if (process.env.PGHOST !== 'photobooth-phase1-test-db' || process.env.PGDATABASE !== 'photobooth_phase1_test' || process.env.ALLOW_INTEGRATION_DB_SETUP !== 'disposable-container') {
  throw new Error('Refusing integration setup: use the documented disposable-container test command. Never target photobooth_db.');
}
const config = loadConfig({ ...process.env, NODE_ENV: 'test', COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '0', APP_ORIGINS: 'http://localhost:8088', PUBLIC_APP_ORIGIN: '',
  N8N_EMAIL_ENABLED: 'false', N8N_EMAIL_WEBHOOK_URL: '', N8N_EMAIL_WEBHOOK_SECRET: '', HERMES_ENDPOINT: '', HERMES_API_KEY: '', N8N_SIMULATOR_ENABLED: 'false',
  N8N_ENABLED: 'true', N8N_WEBHOOK_URL: 'http://workflow.invalid/test',
  N8N_JWT_SECRET: randomBytes(48).toString('base64url'), N8N_JWT_SUBJECT: '{operator_id}', N8N_JWT_ISSUER: 'test-issuer', N8N_JWT_AUDIENCE: 'test-workflow',
  PAYMENT_SIMULATOR_SECRET: randomBytes(32).toString('hex') });
const pool = createPool(config);
let operator, other, pkg, operatorPassword;
const confirm = id => confirmSimulation(pool, operator.id, id, { id: randomUUID(), ip: '127.0.0.1' });
async function create() { return (await createTransaction(pool, operator.id, { packageId: pkg.id, idempotencyKey: randomUUID() })).transaction; }
async function paidTransaction() { const t = await create(); await confirm(t.id); return t; }
async function fakeSuccessfulWorkflow(c, body) {
  jwt.verify(signWorkflowJwt(c, body), c.N8N_JWT_SECRET, { algorithms: ['HS256'], subject: body.operator_id, issuer: c.N8N_JWT_ISSUER, audience: c.N8N_JWT_AUDIENCE });
  const token = randomBytes(32).toString('base64url');
  const result = await pool.query(`INSERT INTO photobooth_sessions(transaction_id,operator_id,package_id,idempotency_key,access_token_hash,photo_limit,token_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '15 minutes') RETURNING id`, [body.transaction_id, body.operator_id, body.package_id, body.idempotency_key, tokenHash(token), pkg.photo_limit]);
  return { success: true, access_token: token, session_id: result.rows[0].id };
}

before(async () => {
  const tables = await pool.query("SELECT COUNT(*)::INT AS n FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(tables.rows[0].n, 0, 'Test database must be empty and disposable.');
  await pool.query(await readFile(new URL('../../../database/01-schema.sql', import.meta.url), 'utf8'));
  await applyTestMigrations(pool);
  operatorPassword = randomBytes(24).toString('hex');
  const passwordHash = await hashPassword(operatorPassword);
  operator = (await pool.query("INSERT INTO app_users(full_name,email,password_hash,role) VALUES('Test Operator',$1,$2,'operator') RETURNING *", [`${randomUUID()}@example.invalid`, passwordHash])).rows[0];
  other = (await pool.query("INSERT INTO app_users(full_name,email,password_hash,role) VALUES('Other Operator',$1,$2,'operator') RETURNING *", [`${randomUUID()}@example.invalid`, passwordHash])).rows[0];
  pkg = (await pool.query("INSERT INTO photo_packages(name,price_idr,photo_limit,session_duration_minutes) VALUES('Integration fixture',75000,6,15) RETURNING *")).rows[0];
});
after(() => pool.end());

test('concurrent transaction retries commit a single simulated record and reject reused keys for another package', async () => {
  const body = { packageId: pkg.id, idempotencyKey: randomUUID() };
  const results = await Promise.all(Array.from({ length: 8 }, () => createTransaction(pool, operator.id, body)));
  assert.equal(new Set(results.map(r => r.transaction.id)).size, 1);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  assert.equal(results[0].transaction.amount_idr, '75000');
  assert.equal(results[0].transaction.is_simulated, true);
  await assert.rejects(createTransaction(pool, operator.id, { ...body, packageId: randomUUID() }), e => e.code === 'IDEMPOTENCY_CONFLICT');
});
test('concurrent confirmation creates one durable audit entry and refuses another operator', async () => {
  const t = await create();
  await assert.rejects(confirmSimulation(pool, other.id, t.id, { id: randomUUID(), ip: '127.0.0.1' }), e => e.status === 404);
  await Promise.all(Array.from({ length: 6 }, () => confirm(t.id)));
  const verified = await getTransaction(pool, t.id, operator.id);
  assert.equal(verified.payment_status, 'paid'); assert.equal(verified.is_simulated, true); assert.ok(verified.paid_at);
  const audit = await pool.query('SELECT * FROM operator_payment_audit WHERE transaction_id=$1', [t.id]);
  assert.equal(audit.rowCount, 1); assert.equal(audit.rows[0].actor_id, operator.id);
  await assert.rejects(getTransaction(pool, t.id, other.id), e => e.status === 404);
});
test('audit insertion failure rolls back the payment confirmation atomically', async () => {
  const t = await create();
  await assert.rejects(confirmSimulation(pool, operator.id, t.id, { id: randomUUID(), ip: 'invalid-address' }));
  const verified = await getTransaction(pool, t.id, operator.id);
  assert.equal(verified.payment_status, 'pending'); assert.equal(verified.paid_at, null);
});
test('package terms stay fixed after a sale and inactive packages cannot be purchased', async () => {
  await assert.rejects(updatePackage(pool, pkg.id, { price_idr: 1 }), e => e.code === 'PACKAGE_TERMS_LOCKED');
  await updatePackage(pool, pkg.id, { is_active: false });
  await assert.rejects(create(), e => e.code === 'PACKAGE_UNAVAILABLE');
  await updatePackage(pool, pkg.id, { is_active: true });
});
test('simulated paid amounts are excluded from real revenue', async () => {
  await paidTransaction();
  const d = await dashboard(pool, operator.id);
  assert.equal(d.stats.realRevenueIdr, '0'); assert.ok(Number(d.stats.simulatedRevenueIdr) > 0);
});
test('token is returned only after a committed matching session; replay returns the same encrypted token', async () => {
  const t = await paidTransaction(); let calls = 0;
  const workflow = async (c, b) => { calls++; return fakeSuccessfulWorkflow(c, b); };
  const first = await issueToken(pool, config, operator.id, t.id, workflow);
  const second = await issueToken(pool, config, operator.id, t.id, workflow);
  assert.equal(second.token, first.token); assert.equal(second.replayed, true); assert.equal(calls, 1);
  const stored = (await pool.query('SELECT * FROM operator_token_issuance WHERE transaction_id=$1', [t.id])).rows[0];
  assert.equal(stored.state, 'issued'); assert.equal(stored.encrypted_token.includes(first.token), false);
  assert.equal((await pool.query('SELECT id FROM photobooth_sessions WHERE transaction_id=$1', [t.id])).rowCount, 1);
});
test('unpaid or disabled token requests never call the workflow', async () => {
  const t = await create(); let calls = 0; const workflow = async () => { calls++; };
  await assert.rejects(issueToken(pool, config, operator.id, t.id, workflow), e => e.code === 'PAYMENT_NOT_CONFIRMED');
  await confirm(t.id);
  await assert.rejects(issueToken(pool, { ...config, N8N_ENABLED: false }, operator.id, t.id, workflow), e => e.code === 'N8N_DISABLED');
  assert.equal(calls, 0);
});
test('timeout after session commit never creates another session or returns an invented token', async () => {
  const t = await paidTransaction(); let calls = 0;
  const workflow = async (c, b) => { calls++; await fakeSuccessfulWorkflow(c, b); throw new Error('Lost response'); };
  await assert.rejects(issueToken(pool, config, operator.id, t.id, workflow), e => e.code === 'N8N_UNCERTAIN');
  await assert.rejects(issueToken(pool, config, operator.id, t.id, workflow), e => e.code === 'TOKEN_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
  assert.equal((await pool.query('SELECT id FROM photobooth_sessions WHERE transaction_id=$1', [t.id])).rowCount, 1);
});
test('upstream token without matching committed hash is rejected and unavailable on retry', async () => {
  const t = await paidTransaction();
  await assert.rejects(issueToken(pool, config, operator.id, t.id, async () => ({ access_token: randomBytes(32).toString('hex'), session_id: randomUUID() })), e => e.code === 'N8N_UNCERTAIN');
  const stored = (await pool.query('SELECT state,encrypted_token FROM operator_token_issuance WHERE transaction_id=$1', [t.id])).rows[0];
  assert.equal(stored.state, 'uncertain'); assert.equal(stored.encrypted_token, null);
});
test('HTTP login through PostgreSQL session store completes the authenticated simulated checkout', async () => {
  const app = createApp({ pool, config, tokenIssuer: (p, c, actor, id) => issueToken(p, c, actor, id, fakeSuccessfulWorkflow) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let cookie, csrf;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = 'GET', body) => {
      const result = await fetch(`${base}/api${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const setCookie = result.headers.getSetCookie()[0]; if (setCookie) cookie = setCookie.split(';')[0];
      return { status: result.status, data: await result.json() };
    };
    assert.equal((await request('/packages')).status, 401);
    csrf = (await request('/auth/csrf')).data.csrfToken;
    const loggedIn = await request('/auth/login', 'POST', { email: operator.email, password: operatorPassword });
    assert.equal(loggedIn.status, 200); csrf = loggedIn.data.csrfToken;
    assert.equal((await request('/auth/me')).data.user.id, operator.id);
    const created = await request('/transactions', 'POST', { packageId: pkg.id, idempotencyKey: randomUUID() });
    assert.equal(created.status, 201);
    const id = created.data.transaction.id;
    assert.equal((await request(`/transactions/${id}/confirm-simulation`, 'POST', { confirmation: 'SIMULATED_PAYMENT' })).status, 200);
    const token = await request(`/transactions/${id}/token`, 'POST');
    assert.equal(token.status, 200); assert.ok(token.data.token);
    assert.equal((await request(`/transactions/${id}/token`, 'POST')).data.token, token.data.token);
    assert.equal((await request('/auth/logout', 'POST')).status, 200);
    assert.equal((await request('/auth/me')).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// ---------------- NEW AUTOMATED PAYMENT SIMULATION & PUBLIC INTEGRATION TESTS ----------------

test('public visitor automated flow: package select -> simulated checkout -> auto payment notification -> auto WF-01 token -> public session access without operator', async () => {
  const app = createApp({ pool, config, tokenIssuer: (p, c, actor, id) => issueToken(p, c, actor, id, fakeSuccessfulWorkflow) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = async (path, method = 'GET', body, headers = {}) => {
      const result = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: result.status, data: await result.json() };
    };

    // 1. Visitor browses packages publicly without auth
    const pkgsRes = await req('/public/packages');
    assert.equal(pkgsRes.status, 200);
    assert.ok(pkgsRes.data.packages.length > 0);

    // 2. Visitor selects package and creates transaction
    const createRes = await req('/public/transactions', 'POST', { packageId: pkg.id });
    assert.equal(createRes.status, 201);
    const txId = createRes.data.transaction.id;
    const checkoutKey = createRes.data.checkoutKey;
    assert.ok(txId);
    assert.ok(checkoutKey);
    assert.equal(createRes.data.transaction.payment_status, 'pending');
    assert.equal(createRes.data.transaction.is_simulated, true);

    // 3. Visitor views public transaction with checkout key
    const getRes = await req(`/public/transactions/${txId}?checkoutKey=${checkoutKey}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.transaction.id, txId);

    // 4. Verification that unauthorized visitors without checkoutKey cannot read transaction
    const deniedRes = await req(`/public/transactions/${txId}?checkoutKey=invalid-key`);
    assert.equal(deniedRes.status, 403);

    // 5. Automated Payment Simulator webhook callback arrives (signed by simulator)
    const notificationPayload = {
      transaction_id: txId,
      event: 'payment.simulated.success',
      status: 'paid',
      scenario: 'success',
      amount_idr: Number(pkg.price_idr),
      simulated_at: new Date().toISOString()
    };
    const signature = signPayload(JSON.stringify(notificationPayload), config.paymentSimulatorSecret);

    const webhookRes = await req('/webhooks/payment-notification', 'POST', notificationPayload, {
      'X-Simulation-Signature': signature
    });
    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.data.ok, true);
    assert.equal(webhookRes.data.status, 'paid');

    // 6. Verify PostgreSQL state: payment is paid and session was automatically created
    const verifiedTx = await pool.query('SELECT * FROM payment_transactions WHERE id = $1', [txId]);
    assert.equal(verifiedTx.rows[0].payment_status, 'paid');
    assert.equal(verifiedTx.rows[0].is_simulated, true);
    assert.ok(verifiedTx.rows[0].paid_at);

    // Automatic token issuance created photobooth_sessions row!
    const sessionRes = await pool.query('SELECT * FROM photobooth_sessions WHERE transaction_id = $1', [txId]);
    assert.equal(sessionRes.rowCount, 1);
    const sessionId = sessionRes.rows[0].id;
    assert.equal(sessionRes.rows[0].package_id, pkg.id);

    // 7. Public visitor polls /public/transactions/:id and sees token issued
    const finalTxRes = await req(`/public/transactions/${txId}?checkoutKey=${checkoutKey}`);
    assert.equal(finalTxRes.status, 200);
    assert.equal(finalTxRes.data.transaction.payment_status, 'paid');
    assert.equal(finalTxRes.data.transaction.token_status, 'issued');

    // 8. Public visitor accesses photobooth session view
    const publicSessionRes = await req(`/public/sessions/${sessionId}?key=${checkoutKey}`);
    assert.equal(publicSessionRes.status, 200);
    assert.equal(publicSessionRes.data.session.id, sessionId);
    assert.equal(publicSessionRes.data.session.package_name, pkg.name);
    assert.equal(publicSessionRes.data.session.photo_limit, pkg.photo_limit);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('payment simulation failure scenario marks transaction as failed without issuing token', async () => {
  const publicTx = await createPublicTransaction(pool, config, { packageId: pkg.id });
  const txId = publicTx.transaction.id;

  const failurePayload = {
    transaction_id: txId,
    event: 'payment.simulated.failed',
    status: 'failed',
    scenario: 'failure',
    failure_reason: 'simulated_card_declined'
  };

  const result = await handlePaymentNotification(pool, config, failurePayload, () => {
    throw new Error('Token issuer must not be called on failed payments');
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'failed');

  const tx = await pool.query('SELECT * FROM payment_transactions WHERE id = $1', [txId]);
  assert.equal(tx.rows[0].payment_status, 'failed');

  // No session row was created
  const session = await pool.query('SELECT * FROM photobooth_sessions WHERE transaction_id = $1', [txId]);
  assert.equal(session.rowCount, 0);
});
