import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signPayload } from '../src/security.js';

const configEnv = overrides => ({
  NODE_ENV: 'test', PGHOST: 'database.invalid', PGPORT: '5432', PGDATABASE: 'isolated_unit_test',
  PGUSER: 'unit_test_only', PGPASSWORD: randomBytes(24).toString('hex'),
  SESSION_SECRET: randomBytes(48).toString('base64url'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false', APP_ORIGINS: 'http://localhost:8088', N8N_ENABLED: 'false',
  PAYMENT_SIMULATOR_SECRET: randomBytes(32).toString('hex'),
  ...overrides
});

test('public packages endpoint returns active packages without authentication or CSRF', async () => {
  const packages = [
    { id: randomUUID(), name: 'Classic Session', price_idr: 50000, photo_limit: 4, session_duration_minutes: 10, is_active: true }
  ];
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM photo_packages WHERE is_active=TRUE AND photo_limit=4')) {
        return { rowCount: packages.length, rows: packages };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const config = loadConfig(configEnv());
  const agent = request(createApp({ pool, config, sessionStore: new session.MemoryStore() }));

  const response = await agent.get('/api/public/packages').expect(200);
  assert.equal(response.body.packages.length, 1);
  assert.equal(response.body.packages[0].name, 'Classic Session');
});

test('public transaction creation creates pending simulated transaction without operator session', async () => {
  const packageId = randomUUID();
  const pkg = { id: packageId, name: 'Single Session', price_idr: 45000, photo_limit: 3, session_duration_minutes: 10, is_active: true };
  const txId = randomUUID();

  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM operator_transaction_requests')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO operator_transaction_requests')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM photo_packages WHERE id=$1 FOR UPDATE')) {
        return { rowCount: 1, rows: [pkg] };
      }
      if (sql.includes('INSERT INTO payment_transactions')) {
        return { rowCount: 1, rows: [{ id: txId }] };
      }
      if (sql.includes('INSERT INTO public_checkout_sessions')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT t.*')) {
        return { rowCount: 1, rows: [{ id: txId, amount_idr: pkg.price_idr, payment_status: 'pending', is_simulated: true, package_name: pkg.name }] };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    },
    release() {}
  };
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect() {
      return client;
    }
  };

  const config = loadConfig(configEnv());
  const agent = request(createApp({ pool, config, sessionStore: new session.MemoryStore() }));

  const response = await agent.post('/api/public/transactions')
    .send({ packageId })
    .expect(201);

  assert.equal(response.body.transaction.id, txId);
  assert.equal(response.body.transaction.payment_status, 'pending');
  assert.equal(response.body.transaction.is_simulated, true);
  assert.ok(response.body.checkoutKey);
  assert.equal(response.body.checkoutKey.length, 64);
});

test('production free-only mode hides simulated payment creation and notification endpoints', async () => {
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const config = loadConfig(configEnv({
    NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
    APP_ORIGINS: 'https://booth.example.invalid', PUBLIC_APP_ORIGIN: 'https://booth.example.invalid',
    PHOTO_STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'racebooth-unit-test',
    R2_ACCESS_KEY_ID: 'R2TESTACCESSKEY000000', R2_SECRET_ACCESS_KEY: 'R2TESTSECRETKEY000000000000000000'
  }));
  const agent = request(createApp({ pool, config, sessionStore: new session.MemoryStore() }));

  await agent.post('/api/public/transactions').send({}).expect(404);
  await agent.post(`/api/public/transactions/${randomUUID()}/simulate-payment`).send({}).expect(404);
  await agent.post('/api/webhooks/payment-notification').send({}).expect(404);
});

test('payment webhook notification rejects invalid HMAC signature when secret is configured', async () => {
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const secret = randomBytes(32).toString('hex');
  const config = loadConfig(configEnv({ PAYMENT_SIMULATOR_SECRET: secret }));
  const agent = request(createApp({ pool, config, sessionStore: new session.MemoryStore() }));

  const payload = {
    transaction_id: randomUUID(),
    event: 'payment.simulated.success',
    status: 'paid',
    scenario: 'success'
  };

  // 1. Missing signature
  await agent.post('/api/webhooks/payment-notification')
    .send(payload)
    .expect(401);

  // 2. Wrong signature
  await agent.post('/api/webhooks/payment-notification')
    .set('X-Simulation-Signature', '0'.repeat(64))
    .send(payload)
    .expect(401);
});

test('payment webhook notification accepts valid HMAC signature and processes atomically', async () => {
  const txId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  let tokenIssued = false;

  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ id: txId, payment_status: 'pending', is_simulated: true, amount_idr: 50000 }] };
      }
      if (sql.includes('INSERT INTO payment_simulation_events')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE payment_transactions SET payment_status=\'paid\'')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE public_checkout_sessions')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO operator_payment_audit')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query in client: ${sql}`);
    },
    release() {}
  };
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      throw new Error(`Unexpected query in pool: ${sql}`);
    },
    async connect() { return client; }
  };

  const mockTokenIssuer = async (p, c, actor, transactionId) => {
    assert.equal(transactionId, txId);
    tokenIssued = true;
    return { token: 'mock-token', session: { id: randomUUID() } };
  };

  const config = loadConfig(configEnv({ PAYMENT_SIMULATOR_SECRET: secret }));
  const agent = request(createApp({ pool, config, tokenIssuer: mockTokenIssuer, sessionStore: new session.MemoryStore() }));

  const payload = {
    transaction_id: txId,
    event: 'payment.simulated.success',
    status: 'paid',
    scenario: 'success',
    simulated_at: new Date().toISOString()
  };
  const signature = signPayload(JSON.stringify(payload), secret);

  const response = await agent.post('/api/webhooks/payment-notification')
    .set('X-Simulation-Signature', signature)
    .send(payload)
    .expect(200);

  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'paid');
  assert.equal(tokenIssued, true);
});

test('public session endpoint returns verified session info and enforces access credentials', async () => {
  const sessionId = randomUUID();
  const checkoutKey = randomBytes(32).toString('hex');
  const sessionRow = {
    id: sessionId,
    status: 'active',
    photo_limit: 4,
    photos_taken: 0,
    token_expires_at: new Date(Date.now() + 900000).toISOString(),
    created_at: new Date().toISOString(),
    package_name: 'Studio Duo',
    session_duration_minutes: 15,
    checkout_key: checkoutKey,
    access_token_hash: 'mock-hash'
    ,payment_status: 'paid', paid_at: new Date().toISOString(), cancelled_at: null, refunded_at: null
  };

  const pool = {
    async query(sql, values = []) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM photobooth_sessions s')) {
        if (values[0] === sessionId) {
          return { rowCount: 1, rows: [sessionRow] };
        }
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  const config = loadConfig(configEnv());
  const agent = request(createApp({ pool, config, sessionStore: new session.MemoryStore() }));

  // Valid checkout key access
  const res = await agent.get(`/api/public/sessions/${sessionId}?key=${checkoutKey}`).expect(200);
  assert.equal(res.body.session.id, sessionId);
  assert.equal(res.body.session.package_name, 'Studio Duo');
  assert.equal(res.body.session.photo_limit, 4);

  // Invalid key access rejected
  await agent.get(`/api/public/sessions/${sessionId}?key=wrong-key`).expect(403);
  await agent.get(`/api/public/sessions/${sessionId}`).expect(403);
});
