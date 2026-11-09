import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { signWorkflowJwt, callWorkflow, parseWorkflowResult } from '../src/n8n.js';

const config = () => ({
  N8N_WEBHOOK_URL: 'http://workflow-unit.invalid/webhook/photobooth/token/create',
  N8N_JWT_SECRET: randomBytes(48).toString('base64url'),
  N8N_JWT_SUBJECT: '{operator_id}', N8N_JWT_ISSUER: 'backend-unit-issuer',
  N8N_JWT_AUDIENCE: 'workflow-unit-audience', N8N_JWT_TTL_SECONDS: 60, N8N_TIMEOUT_MS: 1000
});
const body = () => ({ transaction_id: randomUUID(), operator_id: randomUUID(), package_id: randomUUID(), idempotency_key: randomBytes(32).toString('hex') });
const validPayload = () => ({ success: true, data: { access_token: randomBytes(32).toString('base64url'), session_id: randomUUID() } });

test('workflow JWT signs configured identity, audience, short expiry, and request binding', () => {
  const c = config(); const input = body();
  const signed = signWorkflowJwt(c, input);
  const verified = jwt.verify(signed, c.N8N_JWT_SECRET, { algorithms: ['HS256'], subject: input.operator_id, issuer: c.N8N_JWT_ISSUER, audience: c.N8N_JWT_AUDIENCE, complete: true });
  assert.equal(verified.header.alg, 'HS256');
  assert.equal(verified.payload.sub, input.operator_id);
  assert.equal(verified.payload.operator_id, input.operator_id);
  assert.equal(verified.payload.transaction_id, input.transaction_id);
  assert.equal(verified.payload.exp - verified.payload.iat, c.N8N_JWT_TTL_SECONDS);
  assert.match(verified.payload.jti, /^[0-9a-f-]{36}$/);
  assert.notEqual(jwt.decode(signWorkflowJwt(c, input)).jti, verified.payload.jti);
});

test('signed workflow JWT fails verification for a different algorithm, identity, audience, secret, or expired clock', () => {
  const c = config(); const signed = signWorkflowJwt(c, body());
  const claims = jwt.decode(signed);
  for (const options of [
    { algorithms: ['HS384'] }, { algorithms: ['HS256'], issuer: 'wrong-issuer' },
    { algorithms: ['HS256'], audience: 'wrong-audience' }, { algorithms: ['HS256'], subject: 'wrong-subject' },
    { algorithms: ['HS256'], subject: c.N8N_JWT_SUBJECT }
  ]) assert.throws(() => jwt.verify(signed, c.N8N_JWT_SECRET, options));
  assert.throws(() => jwt.verify(signed, randomBytes(48).toString('base64url'), { algorithms: ['HS256'] }), /signature/);
  assert.throws(() => jwt.verify(signed, c.N8N_JWT_SECRET, { algorithms: ['HS256'], clockTimestamp: claims.exp + 1 }), { name: 'TokenExpiredError' });
});

test('workflow call uses configured server URL, bound JWT, no redirects, and matching idempotency header', async () => {
  const c = config(); const input = body(); const payload = validPayload();
  let called = false;
  const result = await callWorkflow(c, input, async (url, options) => {
    called = true;
    assert.equal(url, c.N8N_WEBHOOK_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['Idempotency-Key'], input.idempotency_key);
    assert.deepEqual(JSON.parse(options.body), input);
    assert.equal(options.signal instanceof AbortSignal, true);
    const verified = jwt.verify(options.headers.Authorization.replace(/^Bearer /, ''), c.N8N_JWT_SECRET, { algorithms: ['HS256'], subject: input.operator_id, issuer: c.N8N_JWT_ISSUER, audience: c.N8N_JWT_AUDIENCE });
    assert.equal(verified.operator_id, input.operator_id);
    assert.equal(verified.transaction_id, input.transaction_id);
    return Response.json(payload);
  });
  assert.equal(called, true);
  assert.deepEqual(result, payload);
});

test('workflow call rejects non-success status, invalid JSON, missing body, oversized response, and fetch failure', async () => {
  const c = config(); const input = body();
  await assert.rejects(callWorkflow(c, input, async () => new Response('upstream details', { status: 401 })), error => error.status === 502 && error.code === 'N8N_REJECTED' && !error.message.includes('upstream details'));
  await assert.rejects(callWorkflow(c, input, async () => new Response('not-json')), SyntaxError);
  await assert.rejects(callWorkflow(c, input, async () => new Response(null)), /Missing response body/);
  await assert.rejects(callWorkflow(c, input, async () => new Response(JSON.stringify({ value: 'x'.repeat(65536) }))), /Response too large/);
  await assert.rejects(callWorkflow(c, input, async () => { throw new Error('unit network failure'); }), /unit network failure/);
});

test('workflow response parsing accepts expected envelope and rejects failures or absent credentials', () => {
  const payload = validPayload();
  assert.deepEqual(parseWorkflowResult(payload), { token: payload.data.access_token, sessionId: payload.data.session_id });
  assert.deepEqual(parseWorkflowResult({ success: true, ...payload.data, expires_at: new Date(Date.now() + 60000).toISOString(), photo_limit: 6 }), { token: payload.data.access_token, sessionId: payload.data.session_id });
  for (const invalid of [
    null, {}, { success: false, data: payload.data },
    { access_token: 'too-short', session_id: randomUUID() },
    { access_token: 'x'.repeat(2049), session_id: randomUUID() },
    { access_token: payload.data.access_token },
    { access_token: payload.data.access_token, session_id: 1 }
  ]) assert.throws(() => parseWorkflowResult(invalid), error => error.status === 502 && error.code === 'N8N_INVALID_RESPONSE');
});
