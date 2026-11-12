import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security.js';

const configForTest = () => loadConfig({
  NODE_ENV: 'test', PGHOST: 'database.invalid', PGDATABASE: 'unit_test', PGUSER: 'test', PGPASSWORD: 'test',
  SESSION_SECRET: randomBytes(48).toString('base64url'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false', APP_ORIGINS: 'http://localhost:8088', N8N_ENABLED: 'false',
});

async function authenticatedAgent(role) {
  const password = randomBytes(24).toString('base64url');
  const user = { id: randomUUID(), full_name: 'Test User', email: `${role}@example.invalid`, role, is_active: true, password_hash: await hashPassword(password) };
  let inserts = 0;
  const pool = {
    async query(sql) {
      if (sql === 'SELECT 1') return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO operator_login_limits')) return { rowCount: 1, rows: [{ attempts: 1 }] };
      if (sql.includes('SELECT id,password_hash,role,is_active FROM app_users')) return { rowCount: 1, rows: [user] };
      if (sql.includes('UPDATE operator_login_limits')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT id,full_name,email,role,is_active FROM app_users')) return { rowCount: 1, rows: [user] };
      if (sql.includes('SELECT * FROM photo_packages ORDER BY')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO photo_packages')) {
        inserts++;
        return { rowCount: 1, rows: [{ id: randomUUID(), name: 'Test package', price_idr: 45000, photo_limit: 4, is_active: true }] };
      }
      throw new Error(`Unexpected query in package authorization test: ${sql}`);
    },
    get insertCount() { return inserts; },
  };
  const agent = request.agent(createApp({ pool, config: configForTest(), sessionStore: new session.MemoryStore() }));
  const csrf = await agent.get('/api/auth/csrf').expect(200);
  const login = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken)
    .send({ email: user.email, password }).expect(200);
  return { agent, csrf: login.body.csrfToken, pool };
}

test('only an explicitly provisioned admin role can create or edit package settings', async () => {
  const operator = await authenticatedAgent('operator');
  await operator.agent.post('/api/admin/packages').set('X-CSRF-Token', operator.csrf)
    .send({ name: 'Seasonal', price_idr: 0 }).expect(403);
  await operator.agent.post('/api/packages').set('X-CSRF-Token', operator.csrf)
    .send({ name: 'Seasonal', price_idr: 0, photo_limit: 4, session_duration_minutes: 120 }).expect(403);
  assert.equal(operator.pool.insertCount, 0);

  const supervisor = await authenticatedAgent('supervisor');
  await supervisor.agent.get('/api/admin/packages').expect(403);
  await supervisor.agent.patch(`/api/admin/packages/${randomUUID()}`).set('X-CSRF-Token', supervisor.csrf)
    .send({ is_active: false }).expect(403);
  assert.equal(supervisor.pool.insertCount, 0);

  const admin = await authenticatedAgent('admin');
  await admin.agent.post('/api/admin/packages').set('X-CSRF-Token', admin.csrf)
    .send({ name: 'Seasonal', price_idr: 45000, description: 'A four-photo session.', benefits: ['Private gallery'], is_active: true, display_order: 0 }).expect(201);
  assert.equal(admin.pool.insertCount, 1);
});
