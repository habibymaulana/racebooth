import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, verifyPassword, encryptToken, decryptToken } from '../src/security.js';
import { loadConfig } from '../src/config.js';
import { parseR2Config } from '../src/r2-config.js';
import { PostgresRateLimitStore } from '../src/postgres-rate-limit-store.js';
import { packageSchema, packagePatchSchema, managedPackageSchema, managedPackagePatchSchema, publicCheckoutSchema, transactionSchema, confirmationSchema } from '../src/validation.js';

const configEnv = overrides => ({
  NODE_ENV: 'test', PGHOST: 'database.invalid', PGPORT: '5432', PGDATABASE: 'isolated_unit_test',
  PGUSER: 'unit_test_only', PGPASSWORD: randomBytes(24).toString('hex'),
  SESSION_SECRET: randomBytes(48).toString('base64url'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false', APP_ORIGINS: 'http://localhost:8088', N8N_ENABLED: 'false',
  ...overrides
});

test('new passwords have independent salts and reject wrong passwords or malformed hashes', async () => {
  const password = `${randomBytes(24).toString('base64url')} 東京`;
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(`${password}!`, first), false);
  for (const invalid of [null, '', password, first.replace('32768', '999999999'), `${first}$trailing`]) {
    assert.equal(await verifyPassword(password, invalid), false);
  }
});

test('supported existing bcrypt passwords remain usable', async () => {
  const password = randomBytes(24).toString('base64url');
  const existing = await bcrypt.hash(password, 10);
  assert.equal(await verifyPassword(password, existing), true);
  assert.equal(await verifyPassword('incorrect', existing), false);
});

test('managed package validation rejects negative prices, invalid order and incompatible photo limits', () => {
  const valid = { name: 'Keepsake', price_idr: 45000, description: 'Four photos in one strip.', benefits: ['Private gallery'], is_active: true, display_order: 2 };
  assert.equal(managedPackageSchema.parse(valid).price_idr, 45000);
  assert.throws(() => managedPackageSchema.parse({ ...valid, price_idr: -1 }));
  assert.throws(() => managedPackageSchema.parse({ ...valid, price_idr: 1.5 }));
  assert.throws(() => managedPackageSchema.parse({ ...valid, benefits: Array(9).fill('Benefit') }));
  assert.throws(() => managedPackagePatchSchema.parse({ display_order: -1 }));
  assert.throws(() => managedPackageSchema.parse({ ...valid, photo_limit: 6 }));
});

test('visitor checkout accepts package id, idempotency key and supported frame only', () => {
  const valid = { packageId: randomUUID(), idempotencyKey: randomUUID(), frameDesign: 'retro-checker' };
  assert.deepEqual(publicCheckoutSchema.parse(valid), valid);
  assert.throws(() => publicCheckoutSchema.parse({ ...valid, price_idr: 1 }));
  assert.throws(() => publicCheckoutSchema.parse({ ...valid, frameDesign: 'not-a-frame' }));
});

test('token encryption is randomized, authenticated, and bound to its transaction', () => {
  const key = randomBytes(32).toString('hex');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const encrypted = encryptToken(token, key, id);
  assert.notEqual(encrypted, encryptToken(token, key, id));
  assert.equal(encrypted.includes(token), false);
  assert.equal(decryptToken(encrypted, key, id), token);
  assert.throws(() => decryptToken(encrypted, key, randomUUID()));
  assert.throws(() => decryptToken(encrypted, randomBytes(32).toString('hex'), id));
  const parts = encrypted.split('.');
  const ciphertext = Buffer.from(parts[2], 'base64url');
  ciphertext[0] ^= 1;
  parts[2] = ciphertext.toString('base64url');
  assert.throws(() => decryptToken(parts.join('.'), key, id));
});

test('configuration rejects insecure production cookies and incomplete enabled JWT settings', () => {
  const defaults = loadConfig(configEnv({ PGSSL: undefined, COOKIE_SECURE: undefined, N8N_ENABLED: undefined }));
  assert.equal(defaults.PGSSL, false); assert.equal(defaults.pg.ssl, false);
  assert.equal(defaults.COOKIE_SECURE, false); assert.equal(defaults.N8N_ENABLED, false);
  assert.throws(() => loadConfig(configEnv({ NODE_ENV: 'production' })), /COOKIE_SECURE/);
  assert.throws(() => loadConfig(configEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'true' })), /PGSSL/);
  const validProduction = {
    NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
    APP_ORIGINS: 'https://booth.example.invalid', PUBLIC_APP_ORIGIN: 'https://booth.example.invalid',
    PHOTO_STORAGE_DRIVER: 'r2', R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET: 'racebooth-unit-test',
    R2_ACCESS_KEY_ID: 'R2TESTACCESSKEY000000', R2_SECRET_ACCESS_KEY: 'R2TESTSECRETKEY000000000000000000'
  };
  const production = loadConfig(configEnv(validProduction));
  assert.equal(production.PGSSL, true);
  assert.equal(production.TRUST_PROXY_HOPS, 1);
  assert.throws(() => loadConfig(configEnv({ ...validProduction, TRUST_PROXY_HOPS: '0' })), /TRUST_PROXY_HOPS/);
  assert.throws(() => loadConfig(configEnv({
    NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
    APP_ORIGINS: 'http://localhost', PHOTO_STORAGE_PATH: '/var/lib/racebooth/photos'
  })), /HTTPS/);
  assert.throws(() => loadConfig(configEnv({ ...validProduction, PHOTO_STORAGE_DRIVER: 'local' })), /private durable photo storage/);
  assert.throws(() => loadConfig(configEnv({ ...validProduction, R2_SECRET_ACCESS_KEY: '' })), /Cloudflare R2 storage configuration/);
  assert.throws(() => loadConfig(configEnv({ PHOTO_CLEANUP_ENABLED: 'true' })), /cleanup can be enabled only in production with private durable storage/);
  assert.throws(() => loadConfig(configEnv({
    ...validProduction, N8N_SIMULATOR_ENABLED: 'true'
  })), /N8N_SIMULATOR_ENABLED/);
  assert.throws(() => loadConfig(configEnv({
    ...validProduction, N8N_EMAIL_ENABLED: 'true', N8N_EMAIL_WEBHOOK_URL: 'http://workflow.example.invalid/webhook/email',
    N8N_EMAIL_WEBHOOK_SECRET: randomBytes(32).toString('hex')
  })), /HTTPS/);
  assert.throws(() => loadConfig(configEnv({ N8N_ENABLED: 'true' })), /JWT/);
  assert.throws(() => loadConfig(configEnv({ TOKEN_ENCRYPTION_KEY: 'short' })), /TOKEN_ENCRYPTION_KEY/);
  const validJwt = {
    N8N_ENABLED: 'true', N8N_WEBHOOK_URL: 'http://workflow.invalid/webhook/test',
    N8N_JWT_SECRET: randomBytes(48).toString('base64url'), N8N_JWT_SUBJECT: '{operator_id}',
    N8N_JWT_ISSUER: 'unit-issuer', N8N_JWT_AUDIENCE: 'unit-audience'
  };
  assert.equal(loadConfig(configEnv(validJwt)).N8N_ENABLED, true);
  assert.throws(() => loadConfig(configEnv({ ...validJwt, N8N_JWT_SUBJECT: 'static-service-subject' })), /operator_id/);
  for (const key of ['N8N_JWT_SUBJECT', 'N8N_JWT_ISSUER', 'N8N_JWT_AUDIENCE']) {
    assert.throws(() => loadConfig(configEnv({ ...validJwt, [key]: '' })), /JWT/);
  }
  assert.throws(() => loadConfig(configEnv({ ...validJwt, N8N_WEBHOOK_URL: 'http://user:password@workflow.invalid/webhook' })), /webhook URL/);
  assert.throws(() => loadConfig(configEnv({ ...validJwt, N8N_JWT_TTL_SECONDS: '3600' })), /N8N_JWT_TTL_SECONDS/);
});

test('serverless configuration uses pooled PostgreSQL URL, a small pool, and private Blob auth', () => {
  const databaseUrl = 'postgresql://racebooth:placeholder@database.invalid/app?sslmode=require';
  const cloudEnv = {
    ...configEnv({
      NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
      APP_ORIGINS: 'https://booth.example.invalid', PUBLIC_APP_ORIGIN: 'https://booth.example.invalid',
      SERVERLESS_DEPLOYMENT: 'true', DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: '3',
      PHOTO_STORAGE_DRIVER: 'vercel-blob', BLOB_STORE_ID: 'store_placeholder',
    }),
  };
  const config = loadConfig(cloudEnv);
  assert.equal(new URL(config.pg.connectionString).searchParams.has('sslmode'), false);
  assert.equal(config.pg.ssl.rejectUnauthorized, true);
  assert.equal(config.pg.max, 3);
  assert.equal(config.SERVERLESS_DEPLOYMENT, true);
  assert.throws(() => loadConfig({ ...cloudEnv, DATABASE_POOL_MAX: '6' }), /DATABASE_POOL_MAX of 5 or less/);
  assert.throws(() => loadConfig({ ...cloudEnv, BLOB_STORE_ID: '' }), /connected private store/);
  assert.throws(() => loadConfig({ ...cloudEnv, SERVERLESS_DEPLOYMENT: 'true', DATABASE_URL: '' }), /pooled DATABASE_URL/);
  assert.throws(() => loadConfig({ ...cloudEnv, PHOTO_CLEANUP_ENABLED: 'true', CRON_SECRET: '' }), /CRON_SECRET/);
});

test('serverless preview uses the deployment URL for exact same-origin checks and gallery links', () => {
  const config = loadConfig(configEnv({
    NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
    SERVERLESS_DEPLOYMENT: 'true', DATABASE_URL: 'postgresql://racebooth:placeholder@database.invalid/app',
    DATABASE_POOL_MAX: '3', PHOTO_STORAGE_DRIVER: 'vercel-blob', BLOB_STORE_ID: 'store_placeholder',
    APP_ORIGINS: '', PUBLIC_APP_ORIGIN: '',
    VERCEL_URL: 'racebooth-preview-123.vercel.app', VERCEL_ENV: 'preview',
  }));
  assert.deepEqual(config.APP_ORIGINS, ['https://racebooth-preview-123.vercel.app']);
  assert.equal(config.PUBLIC_APP_ORIGIN, 'https://racebooth-preview-123.vercel.app');
  assert.throws(() => loadConfig(configEnv({
    NODE_ENV: 'production', COOKIE_SECURE: 'true', PGSSL: 'true', TRUST_PROXY_HOPS: '1',
    SERVERLESS_DEPLOYMENT: 'true', DATABASE_URL: 'postgresql://racebooth:placeholder@database.invalid/app',
    DATABASE_POOL_MAX: '3', PHOTO_STORAGE_DRIVER: 'vercel-blob', BLOB_STORE_ID: 'store_placeholder',
    APP_ORIGINS: '', PUBLIC_APP_ORIGIN: '',
    VERCEL_URL: 'https://invalid.vercel.app', VERCEL_ENV: 'preview',
  })), /VERCEL_URL must be a deployment hostname/);
});

test('Postgres rate-limit store shares counters and stores only keyed digests', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('RETURNING hits')) return { rows: [{ hits: '4', reset_at: '2026-11-09T00:01:00Z' }] };
    return { rows: [], rowCount: 1 };
  } };
  const store = new PostgresRateLimitStore(pool, 'a'.repeat(64), 'upload');
  store.init({ windowMs: 60_000 });
  const result = await store.increment('203.0.113.17');
  assert.equal(result.totalHits, 4);
  assert.ok(result.resetTime instanceof Date);
  assert.notEqual(calls[0].params[1], '203.0.113.17');
  assert.equal(calls[0].params[1].length, 64);
  await store.decrement('203.0.113.17');
  await store.resetKey('203.0.113.17');
  await store.resetAll();
  assert.equal(calls.length, 4);
});

test('Cloudflare R2 configuration validates identifiers without an account lookup', () => {
  const valid = { R2_ACCOUNT_ID: 'b'.repeat(32), R2_BUCKET: 'racebooth-stage-test', R2_ACCESS_KEY_ID: 'R2TESTACCESSKEY000000', R2_SECRET_ACCESS_KEY: 'R2TESTSECRETKEY000000000000000000' };
  const parsed = parseR2Config(valid);
  assert.equal(parsed.endpoint, `https://${valid.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.equal(parsed.region, 'auto');
  assert.equal(parsed.bucket, valid.R2_BUCKET);
  for (const input of [{ ...valid, R2_ACCOUNT_ID: 'invalid' }, { ...valid, R2_BUCKET: 'bad.bucket' }, { ...valid, R2_ACCESS_KEY_ID: '' }]) {
    assert.throws(() => parseR2Config(input), /configuration is incomplete or invalid/);
  }
});

test('optional Hermes key file loads privately and missing files do not prevent booth startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'racebooth-hermes-config-'));
  try {
    const file = join(dir, 'gateway.key');
    await writeFile(file, 'fixture-only-key\n', { mode: 0o600 });
    assert.equal(loadConfig(configEnv({ HERMES_API_KEY_FILE: file })).HERMES_API_KEY, 'fixture-only-key');
    assert.equal(loadConfig(configEnv({ HERMES_API_KEY_FILE: join(dir, 'missing') })).HERMES_API_KEY, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('transaction input cannot choose payment state, amount, method, simulation flag, or operator', () => {
  const valid = { packageId: randomUUID(), idempotencyKey: randomUUID() };
  assert.deepEqual(transactionSchema.parse(valid), valid);
  for (const extra of [
    { amount_idr: 1 }, { amountIdr: 1 }, { payment_status: 'paid' }, { payment_method: 'cash' },
    { is_simulated: false }, { operator_id: randomUUID() }
  ]) assert.equal(transactionSchema.safeParse({ ...valid, ...extra }).success, false);
  assert.equal(transactionSchema.safeParse({ ...valid, idempotencyKey: 'predictable' }).success, false);
  assert.equal(confirmationSchema.safeParse({ confirmation: 'SIMULATED_PAYMENT' }).success, true);
  assert.equal(confirmationSchema.safeParse({ confirmation: 'PAID' }).success, false);
  assert.equal(confirmationSchema.safeParse({ confirmation: 'SIMULATED_PAYMENT', payment_status: 'paid' }).success, false);
});

test('package validation enforces bounded integer pricing and session limits', () => {
  const valid = { name: 'Unit package', price_idr: 50000, photo_limit: 6, session_duration_minutes: 15 };
  assert.equal(packageSchema.parse(valid).is_active, true);
  for (const invalid of [
    { name: ' ' }, { price_idr: -1 }, { price_idr: 1.5 }, { price_idr: 1000000001 },
    { price_idr: '50000' }, { photo_limit: 0 }, { photo_limit: 1001 },
    { session_duration_minutes: 0 }, { session_duration_minutes: 1441 }, { is_active: 'true' }, { role: 'supervisor' }
  ]) assert.equal(packageSchema.safeParse({ ...valid, ...invalid }).success, false);
  assert.equal(packagePatchSchema.safeParse({}).success, false);
  assert.equal(packagePatchSchema.safeParse({ is_active: false }).success, true);
});

// This fixture only implements authentication queries. An unexpected business query fails
// immediately, so rejection tests prove they did not reach a database side effect.
async function appFixture() {
  const { createApp } = await import('../src/app.js');
  const password = randomBytes(32).toString('base64url');
  const account = { id: randomUUID(), email: 'unit-fixture@example.invalid', full_name: 'Unit Fixture', password_hash: await hashPassword(password), role: 'operator', is_active: true };
  const pool = {
    queries: [],
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO operator_login_limits')) return { rowCount: 1, rows: [{ attempts: 1 }] };
      if (sql.includes('DELETE FROM operator_login_limits') || sql.includes('UPDATE operator_login_limits')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM app_users WHERE lower(email)')) {
        const rows = values[0] === account.email ? [{ ...account }] : [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('FROM app_users WHERE id=')) {
        const rows = values[0] === account.id ? [{ ...account }] : [];
        return { rowCount: rows.length, rows };
      }
      throw new Error(`Unexpected business query in rejection test: ${sql}`);
    }
  };
  const config = loadConfig(configEnv());
  const agent = request.agent(createApp({ pool, config, sessionStore: new session.MemoryStore(), tokenIssuer: () => { throw new Error('Token issuer must not run in rejection tests.'); } }));
  const csrf = await agent.get('/api/auth/csrf').expect(200);
  return { agent, pool, account, password, csrf: csrf.body.csrfToken, cookie: csrf.headers['set-cookie'][0] };
}
async function loggedInFixture() {
  const fixture = await appFixture();
  const response = await fixture.agent.post('/api/auth/login').set('Origin', 'http://localhost:8088').set('X-CSRF-Token', fixture.csrf).send({ email: fixture.account.email, password: fixture.password }).expect(200);
  return { ...fixture, oldCsrf: fixture.csrf, csrf: response.body.csrfToken, loginCookie: response.headers['set-cookie'][0] };
}

test('public feature flags disclose only whether email delivery is enabled', async () => {
  const { agent, pool } = await appFixture();
  const response = await agent.get('/api/public/features').expect(200);
  assert.deepEqual(response.body, { emailDeliveryEnabled: false });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(pool.queries.length, 0);
});

test('HTTP API blocks unauthenticated reads, confirmation, and token issuance', async () => {
  const { agent, csrf, pool } = await appFixture();
  for (const url of ['/api/auth/me', '/api/packages', '/api/transactions', '/api/dashboard']) {
    const response = await agent.get(url).expect(401);
    assert.equal(response.body.error.code, 'AUTH_REQUIRED');
  }
  for (const action of ['confirm-simulation', 'token']) {
    await agent.post(`/api/transactions/${randomUUID()}/${action}`).set('X-CSRF-Token', csrf).send({ confirmation: 'SIMULATED_PAYMENT' }).expect(401);
  }
  assert.equal(pool.queries.length, 0);
});

test('HTTP login rejects missing CSRF and untrusted origins before accessing credentials', async () => {
  const { agent, csrf, account, password, pool } = await appFixture();
  await agent.post('/api/auth/login').send({ email: account.email, password }).expect(403);
  const response = await agent.post('/api/auth/login').set('Origin', 'https://untrusted.invalid').set('X-CSRF-Token', csrf).send({ email: account.email, password }).expect(403);
  assert.equal(response.body.error.code, 'ORIGIN_REJECTED');
  const malformed = await agent.post('/api/auth/login').set('X-CSRF-Token', 'é'.repeat(43)).send({ email: account.email, password }).expect(403);
  assert.equal(malformed.body.error.code, 'CSRF_REJECTED');
  assert.equal(pool.queries.length, 0);
});

test('HTTP login rotates session and CSRF, uses protected cookies, and logout revokes access', async () => {
  const { agent, csrf, oldCsrf, cookie, loginCookie, account } = await loggedInFixture();
  assert.notEqual(csrf, oldCsrf);
  assert.notEqual(cookie.split(';')[0], loginCookie.split(';')[0]);
  assert.match(loginCookie, /HttpOnly/i);
  assert.match(loginCookie, /SameSite=Strict/i);
  const me = await agent.get('/api/auth/me').expect(200);
  assert.equal(me.body.user.id, account.id);
  assert.equal(me.body.user.password_hash, undefined);
  assert.equal(me.headers['cache-control'], 'no-store');
  await agent.post('/api/auth/logout').set('X-CSRF-Token', oldCsrf).send({}).expect(403);
  await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf).send({}).expect(200);
  await agent.get('/api/auth/me').expect(401);
});

test('HTTP login returns the same generic rejection for wrong passwords and unknown or disallowed accounts', async () => {
  const { agent, csrf, account, password } = await appFixture();
  const attempt = body => agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send(body).expect(401);
  const incorrect = await attempt({ email: account.email, password: `${password}wrong` });
  const unknown = await attempt({ email: 'missing-fixture@example.invalid', password });
  account.role = 'service';
  const disallowed = await attempt({ email: account.email, password });
  for (const response of [incorrect, unknown, disallowed]) {
    assert.deepEqual(response.body.error, { code: 'INVALID_CREDENTIALS', message: 'Invalid operator email or password.' });
  }
});

test('HTTP authorization rereads active role instead of trusting the browser session', async () => {
  const fixture = await loggedInFixture();
  fixture.account.role = 'supervisor';
  const currentUser = await fixture.agent.get('/api/auth/me').expect(200);
  assert.equal(currentUser.body.user.role, 'supervisor');
  const forbidden = await fixture.agent.post(`/api/transactions/${randomUUID()}/confirm-simulation`).set('X-CSRF-Token', fixture.csrf).send({ confirmation: 'SIMULATED_PAYMENT' }).expect(403);
  assert.equal(forbidden.body.error.code, 'READ_ONLY_ROLE');
  fixture.account.role = 'operator';
  fixture.account.is_active = false;
  await fixture.agent.post(`/api/transactions/${randomUUID()}/confirm-simulation`).set('X-CSRF-Token', fixture.csrf).send({ confirmation: 'SIMULATED_PAYMENT' }).expect(401);
  fixture.account.is_active = true;
  await fixture.agent.get('/api/auth/me').expect(401);
});

test('HTTP rejects tampered transaction and confirmation input before business queries', async () => {
  const { agent, csrf, pool } = await loggedInFixture();
  const before = pool.queries.length;
  const invalid = await agent.post('/api/transactions').set('X-CSRF-Token', csrf).send({ packageId: randomUUID(), idempotencyKey: randomUUID(), amount_idr: 1, payment_status: 'paid' }).expect(400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  await agent.post(`/api/transactions/${randomUUID()}/confirm-simulation`).set('X-CSRF-Token', csrf).send({ confirmation: 'PAID' }).expect(400);
  await agent.post('/api/packages').set('X-CSRF-Token', csrf).send({ name: 'Invalid package', price_idr: -1, photo_limit: 0, session_duration_minutes: 0 }).expect(403);
  assert.equal(pool.queries.slice(before).every(q => q.sql.includes('FROM app_users WHERE id=')), true);
});

test('HTTP invalid JSON and oversized body have controlled errors', async () => {
  const { agent } = await appFixture();
  const invalid = await agent.post('/api/auth/login').set('Content-Type', 'application/json').send('{invalid').expect(400);
  assert.equal(invalid.body.error.code, 'INVALID_JSON');
  const oversized = await agent.post('/api/auth/login').send({ password: 'x'.repeat(18000) }).expect(413);
  assert.equal(oversized.body.error.code, 'REQUEST_TOO_LARGE');
});
