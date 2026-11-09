import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError, fail } from './errors.js';
import { tokenHash, encryptToken, decryptToken, signPayload } from './security.js';

export function signWorkflowJwt(config, body) {
  const actorId = body.operator_id || config.SERVICE_USER_ID || '00000000-0000-4000-8000-000000000001';
  const sub = config.N8N_JWT_SUBJECT ? config.N8N_JWT_SUBJECT.replace('{operator_id}', actorId) : actorId;
  return jwt.sign({ operator_id: actorId, transaction_id: body.transaction_id, role: body.role || 'service' }, config.N8N_JWT_SECRET, {
    algorithm: 'HS256', subject: sub, issuer: config.N8N_JWT_ISSUER,
    audience: config.N8N_JWT_AUDIENCE, expiresIn: config.N8N_JWT_TTL_SECONDS, jwtid: randomUUID()
  });
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

// Kept separate for tests. It accepts only the configured server-side URL, never a browser URL.
export async function callWorkflow(config, body, fetchImpl = fetch) {
  const response = await fetchImpl(config.N8N_WEBHOOK_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.N8N_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${signWorkflowJwt(config, body)}`, 'Content-Type': 'application/json', 'Idempotency-Key': body.idempotency_key },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(502, 'N8N_REJECTED', 'Token service rejected the request.');
  }
  return readBoundedJson(response);
}

export function parseWorkflowResult(payload) {
  // WF-01 contract is checked against its exported workflow; no token is trusted until DB verification.
  const data = payload?.data || payload;
  const token = data?.access_token;
  if (payload?.success === false || typeof token !== 'string' || token.length < 16 || token.length > 2048 || typeof data?.session_id !== 'string') {
    fail(502, 'N8N_INVALID_RESPONSE', 'Token service returned an invalid result.');
  }
  return { token, sessionId: data.session_id };
}

function sessionResult(row, token, replayed) {
  return { token, session: { id: row.id, tokenExpiresAt: row.token_expires_at, photoLimit: row.photo_limit }, replayed };
}
function usableSession(s) { return s && ['pending', 'active'].includes(s.status) && new Date(s.token_expires_at).getTime() > Date.now(); }

export async function issueToken(pool, config, operatorId, transactionId, workflow = callWorkflow) {
  const actorId = operatorId || config.SERVICE_USER_ID || '00000000-0000-4000-8000-000000000001';
  const db = await pool.connect(); let locked = false;
  const lockKey = `photobooth-token:${transactionId}`;
  try {
    const lock = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey]);
    locked = lock.rows[0].locked;
    if (!locked) fail(409, 'TOKEN_IN_PROGRESS', 'Token creation is in progress. Refresh the transaction shortly.');
    const txResult = await db.query(`SELECT t.* FROM payment_transactions t WHERE t.id=$1`, [transactionId]);
    const t = txResult.rows[0];
    if (!t) fail(404, 'TRANSACTION_NOT_FOUND', 'Phase 1 transaction not found.');
    if (t.payment_status !== 'paid' || !t.is_simulated || !t.paid_at) fail(409, 'PAYMENT_NOT_CONFIRMED', 'Confirm the simulated payment before issuing a token.');
    const previous = await db.query('SELECT * FROM operator_token_issuance WHERE transaction_id=$1', [transactionId]);
    const i = previous.rows[0];
    const sessions = await db.query('SELECT * FROM photobooth_sessions WHERE transaction_id=$1', [transactionId]);
    const existing = sessions.rows[0];
    if (i?.state === 'issued' && existing && i.session_id === existing.id && i.encrypted_token) {
      if (existing.package_id !== t.package_id || existing.idempotency_key !== i.idempotency_key) {
        fail(409, 'TOKEN_RECONCILIATION_REQUIRED', 'The saved session no longer matches this transaction. Ask an administrator to reconcile it.');
      }
      if (!usableSession(existing)) fail(409, 'TOKEN_UNAVAILABLE', 'This session has expired or is no longer available.');
      let token;
      try { token = decryptToken(i.encrypted_token, config.TOKEN_ENCRYPTION_KEY, transactionId); }
      catch { fail(409, 'TOKEN_RECONCILIATION_REQUIRED', 'The saved token cannot be recovered. Ask an administrator to reconcile this session.'); }
      if (tokenHash(token) !== existing.access_token_hash) fail(409, 'TOKEN_RECONCILIATION_REQUIRED', 'The saved token does not match the session. Ask an administrator to reconcile it.');
      return sessionResult(existing, token, true);
    }
    // A committed hash cannot recreate a lost raw token. Never mint another session or invent a token.
    if (existing || (i && ['issuing', 'uncertain', 'issued'].includes(i.state))) {
      fail(409, 'TOKEN_RECONCILIATION_REQUIRED', 'A previous token request needs administrator reconciliation. Do not create another payment to work around this.');
    }
    if (!config.N8N_ENABLED) fail(503, 'N8N_DISABLED', 'Token issuing is not configured yet. The simulated payment remains recorded.');
    const inserted = await db.query(`INSERT INTO operator_token_issuance(transaction_id,idempotency_key) VALUES($1,$2)
      ON CONFLICT(transaction_id) DO UPDATE SET updated_at=NOW() RETURNING *`, [transactionId, randomBytes(32).toString('hex')]);
    const issuance = inserted.rows[0];
    await db.query("UPDATE operator_token_issuance SET state='issuing',attempts=attempts+1,last_error_code=NULL,updated_at=NOW() WHERE transaction_id=$1", [transactionId]);
    try {
      const body = { transaction_id: transactionId, operator_id: actorId, package_id: t.package_id, idempotency_key: issuance.idempotency_key };
      const parsed = parseWorkflowResult(await workflow(config, body));
      const verified = await db.query(`SELECT s.* FROM photobooth_sessions s JOIN payment_transactions t ON t.id=s.transaction_id
        WHERE s.transaction_id=$1 AND s.id=$2 AND s.package_id=$3
        AND s.idempotency_key=$4 AND s.access_token_hash=$5 AND t.payment_status='paid' AND t.is_simulated=TRUE`,
      [transactionId, parsed.sessionId, t.package_id, issuance.idempotency_key, tokenHash(parsed.token)]);
      const s = verified.rows[0];
      if (!usableSession(s)) fail(502, 'N8N_SESSION_MISMATCH', 'The returned token could not be verified against an available database session.');
      await db.query(`UPDATE operator_token_issuance SET state='issued',session_id=$2,encrypted_token=$3,last_error_code=NULL,updated_at=NOW() WHERE transaction_id=$1`, [transactionId, s.id, encryptToken(parsed.token, config.TOKEN_ENCRYPTION_KEY, transactionId)]);
      return sessionResult(s, parsed.token, false);
    } catch (error) {
      await db.query("UPDATE operator_token_issuance SET state='uncertain',last_error_code=$2,updated_at=NOW() WHERE transaction_id=$1", [transactionId, error instanceof AppError ? error.code : 'N8N_UNCERTAIN']);
      fail(502, 'N8N_UNCERTAIN', 'Token creation was not verified. The payment is saved; an administrator must reconcile the request before retrying.');
    }
  } finally {
    let releaseError;
    if (locked) {
      try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]); }
      catch (error) { releaseError = error; }
    }
    // A failed unlock must never return a potentially locked connection to the pool.
    db.release(releaseError);
  }
}

// Payment Simulator caller for n8n simulator webhook
export async function dispatchPaymentSimulator(config, payload, fetchImpl = fetch) {
  if (!config.N8N_SIMULATOR_ENABLED && !config.PAYMENT_SIMULATOR_URL) {
    return { dispatched: false, reason: 'SIMULATOR_DISABLED' };
  }
  const bodyString = JSON.stringify(payload);
  const signature = signPayload(bodyString, config.paymentSimulatorSecret);
  const response = await fetchImpl(config.PAYMENT_SIMULATOR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Simulation-Signature': signature
    },
    body: bodyString,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new AppError(502, 'SIMULATOR_DISPATCH_FAILED', 'Failed to dispatch to payment simulator workflow.');
  }
  return { dispatched: true };
}
