import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { dispatchPhotoEmail } from '../src/free-sessions.js';

const config = { N8N_EMAIL_ENABLED: true, N8N_EMAIL_WEBHOOK_URL: 'http://workflow.invalid/webhook/racebooth/photo-result-email',
  N8N_EMAIL_WEBHOOK_SECRET: randomBytes(32).toString('hex'), N8N_EMAIL_TIMEOUT_MS: 1000,
  APP_ORIGINS: ['http://localhost:8088'], PUBLIC_APP_ORIGIN: 'http://localhost:8088' };
const payload = { delivery_id: randomUUID(), recipient_email: 'test@example.invalid', gallery_url: 'https://gallery.invalid/#share=test' };
const response = (body, status = 200) => async () => Response.json(body, { status });

test('email dispatch requires Gmail acknowledgement or a correlated sent result', async () => {
  const gmail = await dispatchPhotoEmail(config, payload, response({ id: '18abc123', threadId: '18abc123', labelIds: ['SENT'] }));
  assert.equal(gmail.status, 'sent'); assert.equal(gmail.metadata.confirmation, 'provider_accepted');
  assert.equal((await dispatchPhotoEmail(config, payload, response({ delivery_id: payload.delivery_id, status: 'sent' }))).status, 'sent');
  for (const body of [null, { message: 'Workflow was started' }, { success: true }, { delivery_id: randomUUID(), status: 'sent' }, { id: '18abc123', threadId: '18abc123' }]) {
    assert.equal((await dispatchPhotoEmail(config, payload, response(body))).status, 'pending');
  }
});

test('email dispatch distinguishes a rejection from ambiguous server and transport failures', async () => {
  const denied = await dispatchPhotoEmail(config, payload, response({ message: 'unauthorized' }, 401));
  assert.equal(denied.status, 'failed'); assert.equal(denied.reason, 'WEBHOOK_REJECTED_401');
  assert.equal((await dispatchPhotoEmail(config, payload, response({ delivery_id: payload.delivery_id, status: 'failed' }))).status, 'failed');
  assert.equal((await dispatchPhotoEmail(config, payload, response({ message: 'timeout' }, 500))).status, 'pending');
  assert.equal((await dispatchPhotoEmail(config, payload, async () => { throw new Error('network detail must not leak'); })).status, 'pending');
});

test('email webhook calls stay server-side, reject redirects, and bound response parsing', async () => {
  await dispatchPhotoEmail(config, payload, async (url, request) => {
    assert.equal(url, config.N8N_EMAIL_WEBHOOK_URL); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['X-Racebooth-Secret'], config.N8N_EMAIL_WEBHOOK_SECRET);
    assert.deepEqual(JSON.parse(request.body), payload); assert.ok(request.signal instanceof AbortSignal);
    return Response.json({ id: '18abc123', threadId: '18abc123', labelIds: ['SENT'] });
  });
  const oversized = await dispatchPhotoEmail(config, payload, async () => new Response('x'.repeat(65537)));
  assert.equal(oversized.status, 'pending');
  const invalid = await dispatchPhotoEmail(config, payload, async () => new Response('not json'));
  assert.equal(invalid.status, 'pending');
  await assert.rejects(dispatchPhotoEmail({ ...config, N8N_EMAIL_WEBHOOK_SECRET: '' }, payload, response({})), error => error.code === 'EMAIL_NOT_CONFIGURED');
});
