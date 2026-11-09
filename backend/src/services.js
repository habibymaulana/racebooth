import { randomBytes, randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { fail } from './errors.js';
import { issueToken, dispatchPaymentSimulator } from './n8n.js';
import { verifySessionAccess } from './photos.js';

const transactionSelect = `SELECT t.*,
  COALESCE(r.package_snapshot->>'name', pcs.package_snapshot->>'name', p.name) AS package_name,
  i.state AS token_status, s.token_expires_at, s.id AS session_id,
  pcs.checkout_key, pcs.simulation_scenario, pcs.simulation_state,
  (t.operator_id = '00000000-0000-4000-8000-000000000001') AS is_visitor
  FROM payment_transactions t
  JOIN photo_packages p ON p.id=t.package_id
  LEFT JOIN operator_transaction_requests r ON r.transaction_id=t.id
  LEFT JOIN public_checkout_sessions pcs ON pcs.transaction_id=t.id
  LEFT JOIN operator_token_issuance i ON i.transaction_id=t.id
  LEFT JOIN photobooth_sessions s ON s.transaction_id=t.id`;

export async function getTransaction(db, id, operatorId) {
  let query = `${transactionSelect} WHERE t.id=$1`;
  const params = [id];
  if (operatorId) {
    query += ` AND (t.operator_id=$2 OR t.operator_id='00000000-0000-4000-8000-000000000001')`;
    params.push(operatorId);
  }
  const result = await db.query(query, params);
  if (!result.rowCount) fail(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
  return result.rows[0];
}

export async function listTransactions(db, operatorId) {
  let query = `${transactionSelect}`;
  const params = [];
  if (operatorId) {
    query += ` WHERE (t.operator_id=$1 OR t.operator_id='00000000-0000-4000-8000-000000000001')`;
    params.push(operatorId);
  }
  query += ` ORDER BY t.created_at DESC LIMIT 100`;
  return (await db.query(query, params)).rows;
}

export async function createTransaction(pool, operatorId, body) {
  return transaction(pool, async db => {
    // Cross-process lock before checking the request key prevents concurrent duplicate inserts.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`create:${operatorId}:${body.idempotencyKey}`]);
    const existing = await db.query('SELECT transaction_id,package_id FROM operator_transaction_requests WHERE operator_id=$1 AND request_key=$2', [operatorId, body.idempotencyKey]);
    if (existing.rowCount) {
      if (existing.rows[0].package_id !== body.packageId) fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for another package.');
      return { transaction: await getTransaction(db, existing.rows[0].transaction_id, operatorId), replayed: true };
    }
    const result = await db.query('SELECT * FROM photo_packages WHERE id=$1 FOR UPDATE', [body.packageId]);
    if (!result.rowCount || !result.rows[0].is_active) fail(409, 'PACKAGE_UNAVAILABLE', 'Choose an active package.');
    const p = result.rows[0];
    const created = await db.query(`INSERT INTO payment_transactions(package_id,operator_id,amount_idr,payment_method,payment_status,is_simulated)
      VALUES($1,$2,$3,'qris','pending',TRUE) RETURNING id`, [p.id, operatorId, p.price_idr]);
    const id = created.rows[0].id;
    await db.query('INSERT INTO operator_transaction_requests(transaction_id,operator_id,request_key,package_id,package_snapshot) VALUES($1,$2,$3,$4,$5)', [id, operatorId, body.idempotencyKey, p.id, JSON.stringify(p)]);
    return { transaction: await getTransaction(db, id, operatorId), replayed: false };
  });
}

// ---------------- Public Visitor Services ----------------

export async function getPublicPackages(db) {
  return (await db.query('SELECT id, name, price_idr, photo_limit, session_duration_minutes, is_active FROM photo_packages WHERE is_active = TRUE ORDER BY price_idr ASC')).rows;
}

export async function createPublicTransaction(pool, config, body, clientIp = '127.0.0.1') {
  return transaction(pool, async db => {
    const serviceUserId = config.SERVICE_USER_ID || '00000000-0000-4000-8000-000000000001';
    const idemKey = body.idempotencyKey || randomUUID();
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`public_create:${idemKey}`]);

    const previous = await db.query('SELECT transaction_id,package_id,package_snapshot FROM operator_transaction_requests WHERE operator_id=$1 AND request_key=$2', [serviceUserId, idemKey]);
    if (previous.rowCount) {
      const prior = previous.rows[0];
      if (prior.package_id !== body.packageId) fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was used for another package.');
      const tx = await getTransaction(db, prior.transaction_id);
      return { transaction: tx, checkoutKey: tx.checkout_key, package: prior.package_snapshot, replayed: true };
    }

    const result = await db.query('SELECT * FROM photo_packages WHERE id=$1 FOR UPDATE', [body.packageId]);
    if (!result.rowCount || !result.rows[0].is_active) fail(409, 'PACKAGE_UNAVAILABLE', 'The selected package is not available.');
    const p = result.rows[0];

    const created = await db.query(`INSERT INTO payment_transactions(package_id,operator_id,amount_idr,payment_method,payment_status,is_simulated)
      VALUES($1,$2,$3,'qris','pending',TRUE) RETURNING id`, [p.id, serviceUserId, p.price_idr]);
    const transactionId = created.rows[0].id;
    const checkoutKey = randomBytes(32).toString('hex');

    await db.query(`INSERT INTO public_checkout_sessions(transaction_id,checkout_key,package_id,package_snapshot,client_ip)
      VALUES($1,$2,$3,$4,$5)`, [transactionId, checkoutKey, p.id, JSON.stringify(p), clientIp]);
    await db.query('INSERT INTO operator_transaction_requests(transaction_id,operator_id,request_key,package_id,package_snapshot) VALUES($1,$2,$3,$4,$5)', [transactionId, serviceUserId, idemKey, p.id, JSON.stringify(p)]);

    const tx = await getTransaction(db, transactionId);
    return { transaction: tx, checkoutKey, package: p, replayed: false };
  });
}

export async function getPublicTransaction(db, id, checkoutKey) {
  const result = await db.query(`${transactionSelect} WHERE t.id=$1`, [id]);
  if (!result.rowCount) fail(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
  const tx = result.rows[0];
  if (typeof checkoutKey !== 'string' || !checkoutKey || !tx.checkout_key || tx.checkout_key !== checkoutKey) {
    fail(403, 'CHECKOUT_ACCESS_DENIED', 'Invalid checkout key for this transaction.');
  }
  return tx;
}

export async function initiatePaymentSimulation(pool, config, id, { scenario = 'success', checkoutKey }, clientIp = '127.0.0.1', dispatchFn = dispatchPaymentSimulator) {
  const tx = await transaction(pool, async db => {
    const locked = await db.query(`SELECT t.*, pcs.checkout_key, pcs.simulation_state
      FROM payment_transactions t
      JOIN public_checkout_sessions pcs ON pcs.transaction_id = t.id
      WHERE t.id = $1 FOR UPDATE OF t`, [id]);
    if (!locked.rowCount) fail(404, 'TRANSACTION_NOT_FOUND', 'Checkout transaction not found.');
    const row = locked.rows[0];
    if (typeof checkoutKey !== 'string' || !checkoutKey || row.checkout_key !== checkoutKey) {
      fail(403, 'CHECKOUT_ACCESS_DENIED', 'Invalid checkout key.');
    }
    if (!row.is_simulated) fail(409, 'SIMULATION_ONLY', 'Only simulated transactions can use this gateway.');
    if (row.payment_status === 'paid') return { alreadyPaid: true, row };
    if (row.payment_status !== 'pending' && row.payment_status !== 'failed') {
      fail(409, 'INVALID_PAYMENT_STATE', `Cannot simulate payment in '${row.payment_status}' state.`);
    }

    await db.query(`UPDATE public_checkout_sessions SET simulation_state='processing', simulation_scenario=$2, updated_at=NOW() WHERE transaction_id=$1`, [id, scenario]);
    return { alreadyPaid: false, row };
  });

  if (tx.alreadyPaid) {
    return { ok: true, status: 'paid', replayed: true };
  }

  const payload = {
    transaction_id: id,
    event: 'payment.simulation.requested',
    scenario,
    amount_idr: tx.row.amount_idr,
    delay_ms: config.PAYMENT_SIMULATOR_DELAY_MS,
    client_ip: clientIp,
    timestamp: new Date().toISOString()
  };

  // Dispatch asynchronously to n8n payment simulator or local background handler
  let dispatched = false;
  try {
    const res = await dispatchFn(config, payload);
    dispatched = res?.dispatched ?? false;
  } catch {
    dispatched = false;
  }

  // If n8n simulator is not enabled or failed to dispatch, execute the simulated delay & callback locally
  if (!dispatched) {
    setTimeout(async () => {
      try {
        const targetStatus = scenario === 'success' ? 'paid' : scenario === 'cancelled' ? 'cancelled' : 'failed';
        await handlePaymentNotification(pool, config, {
          transaction_id: id,
          event: `payment.simulated.${targetStatus}`,
          status: targetStatus,
          scenario,
          failure_reason: scenario !== 'success' ? `simulated_${scenario}` : undefined,
          simulated_at: new Date().toISOString()
        }, issueToken);
      } catch (err) {
        console.error('Async simulated payment error:', err.message);
      }
    }, config.PAYMENT_SIMULATOR_DELAY_MS || 2000).unref();
  }

  return { ok: true, status: 'processing', scenario };
}

// ---------------- Payment Notification Webhook & Auto Token ----------------

export async function handlePaymentNotification(pool, config, notification, tokenIssuer = issueToken) {
  const transactionId = notification.transaction_id;
  const status = notification.status;
  const scenario = notification.scenario || (status === 'paid' ? 'success' : 'failed');
  const serviceUserId = config.SERVICE_USER_ID || '00000000-0000-4000-8000-000000000001';

  let shouldIssueToken = false;
  const result = await transaction(pool, async db => {
    const locked = await db.query(`SELECT * FROM payment_transactions WHERE id=$1 FOR UPDATE`, [transactionId]);
    if (!locked.rowCount) fail(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.');
    const t = locked.rows[0];

    // Record simulation audit event
    await db.query(`INSERT INTO payment_simulation_events(transaction_id, event_type, scenario, status, payload)
      VALUES($1, $2, $3, $4, $5)`,
      [transactionId, notification.event || 'payment.simulated', scenario, status, JSON.stringify(notification)]);

    if (t.payment_status === status && (status !== 'pending')) {
      return { ok: true, replayed: true, status: t.payment_status };
    }

    if (status === 'paid') {
      await db.query("UPDATE payment_transactions SET payment_status='paid', is_simulated=TRUE, paid_at=NOW() WHERE id=$1", [transactionId]);
      await db.query("UPDATE public_checkout_sessions SET simulation_state='completed', updated_at=NOW() WHERE transaction_id=$1", [transactionId]);
      await db.query(`INSERT INTO operator_payment_audit(transaction_id, actor_id, action, previous_status, new_status, is_simulated, request_id, actor_ip)
        VALUES($1, $2, 'simulation_gateway_paid', $3, 'paid', TRUE, $4, $5)`,
        [transactionId, serviceUserId, t.payment_status, randomUUID(), '127.0.0.1']);
      shouldIssueToken = true;
    } else if (status === 'failed') {
      await db.query("UPDATE payment_transactions SET payment_status='failed' WHERE id=$1", [transactionId]);
      await db.query("UPDATE public_checkout_sessions SET simulation_state='failed', updated_at=NOW() WHERE transaction_id=$1", [transactionId]);
      await db.query(`INSERT INTO operator_payment_audit(transaction_id, actor_id, action, previous_status, new_status, is_simulated, request_id, actor_ip)
        VALUES($1, $2, 'simulation_gateway_failed', $3, 'failed', TRUE, $4, $5)`,
        [transactionId, serviceUserId, t.payment_status, randomUUID(), '127.0.0.1']);
    } else if (status === 'cancelled') {
      await db.query("UPDATE payment_transactions SET payment_status='cancelled', cancelled_at=NOW() WHERE id=$1", [transactionId]);
      await db.query("UPDATE public_checkout_sessions SET simulation_state='cancelled', updated_at=NOW() WHERE transaction_id=$1", [transactionId]);
      await db.query(`INSERT INTO operator_payment_audit(transaction_id, actor_id, action, previous_status, new_status, is_simulated, request_id, actor_ip)
        VALUES($1, $2, 'simulation_gateway_cancelled', $3, 'cancelled', TRUE, $4, $5)`,
        [transactionId, serviceUserId, t.payment_status, randomUUID(), '127.0.0.1']);
    }

    return { ok: true, status, transactionId };
  });

  if (shouldIssueToken && tokenIssuer) {
    try {
      await tokenIssuer(pool, config, serviceUserId, transactionId);
    } catch (tokenErr) {
      console.error(`Automatic token issuance failed for tx ${transactionId}:`, tokenErr.message);
    }
  }

  return result;
}

// ---------------- Public Session Verification ----------------

export async function getPublicSession(db, sessionId, checkoutKeyOrToken, options = {}) {
  const session = await verifySessionAccess(db, sessionId, checkoutKeyOrToken, options);

  return {
    id: session.id,
    status: session.status,
    photo_limit: session.photo_limit,
    photos_taken: session.photos_taken,
    token_expires_at: session.token_expires_at,
    package_name: session.package_name,
    session_duration_minutes: session.session_duration_minutes
  };
}

// ---------------- Existing Operator Support & Dashboard ----------------

export async function confirmSimulation(pool, operatorId, id, request) {
  return transaction(pool, async db => {
    const locked = await db.query(`SELECT t.* FROM payment_transactions t
      WHERE t.id=$1 FOR UPDATE OF t`, [id]);
    if (!locked.rowCount) fail(404, 'TRANSACTION_NOT_FOUND', 'Phase 1 transaction not found.');
    const t = locked.rows[0];
    if (!t.is_simulated || t.payment_method !== 'qris') fail(409, 'SIMULATION_ONLY', 'Only Phase 1 QRIS simulation transactions can be confirmed.');
    if (t.payment_status === 'paid') return { transaction: await getTransaction(db, id, operatorId), replayed: true };
    if (t.payment_status !== 'pending') fail(409, 'INVALID_PAYMENT_STATE', 'Only pending transactions can be confirmed.');
    await db.query("UPDATE payment_transactions SET payment_status='paid',is_simulated=TRUE,paid_at=NOW() WHERE id=$1", [id]);
    await db.query(`INSERT INTO operator_payment_audit(transaction_id,actor_id,action,previous_status,new_status,is_simulated,request_id,actor_ip)
      VALUES($1,$2,'simulation_payment_confirmed',$3,'paid',TRUE,$4,$5)`, [id, operatorId, t.payment_status, request.id, request.ip]);
    return { transaction: await getTransaction(db, id, operatorId), replayed: false };
  });
}

export async function updatePackage(pool, id, body) {
  return transaction(pool, async db => {
    const existing = await db.query('SELECT * FROM photo_packages WHERE id=$1 FOR UPDATE', [id]);
    if (!existing.rowCount) fail(404, 'PACKAGE_NOT_FOUND', 'Package not found.');
    const p = existing.rows[0];
    const termsChanged = ['price_idr', 'photo_limit', 'session_duration_minutes'].some(k => body[k] !== undefined && String(body[k]) !== String(p[k]));
    if (termsChanged) {
      const used = await db.query('SELECT 1 FROM payment_transactions WHERE package_id=$1 LIMIT 1', [id]);
      if (used.rowCount) fail(409, 'PACKAGE_TERMS_LOCKED', 'This package has transactions. Create a new package to change its price or session limits.');
    }
    const next = { ...p, ...body };
    return (await db.query(`UPDATE photo_packages SET name=$2,price_idr=$3,photo_limit=$4,session_duration_minutes=$5,is_active=$6 WHERE id=$1 RETURNING *`, [id, next.name, next.price_idr, next.photo_limit, next.session_duration_minutes, next.is_active])).rows[0];
  });
}

export async function dashboard(pool, operatorId) {
  const result = await pool.query(`SELECT
    COALESCE(SUM(amount_idr) FILTER (WHERE payment_status='paid' AND is_simulated=FALSE AND payment_method!='free'),0)::TEXT AS "realRevenueIdr",
    COALESCE(SUM(amount_idr) FILTER (WHERE payment_status='paid' AND is_simulated=TRUE),0)::TEXT AS "simulatedRevenueIdr",
    COUNT(*) FILTER (WHERE payment_status='pending')::INT AS "pendingTransactions",
    (SELECT COUNT(*)::INT FROM photobooth_sessions) AS "issuedTokens",
    (SELECT COUNT(*)::INT FROM photobooth_sessions WHERE status IN ('pending', 'active') AND token_expires_at > NOW()) AS "activeSessions",
    (SELECT COUNT(*)::INT FROM free_photobooth_sessions) AS "totalFreeSessions",
    (SELECT COUNT(*)::INT FROM free_photobooth_sessions WHERE status='completed' OR session_id IN (SELECT session_id FROM session_photostrips WHERE status='composed')) AS "completedFreeSessions",
    (SELECT COUNT(*)::INT FROM session_photos WHERE status='saved') AS "totalStoredPhotos",
    (SELECT COUNT(*)::INT FROM session_photostrips WHERE status='composed') AS "totalPhotostrips",
    (SELECT COUNT(*)::INT FROM free_session_email_deliveries WHERE status='sent') AS "emailsSent",
    (SELECT COUNT(*)::INT FROM free_session_email_deliveries WHERE status='pending' OR (status='sent' AND n8n_response->>'confirmation' IS DISTINCT FROM 'provider_accepted')) AS "emailsUnconfirmed",
    (SELECT COUNT(*)::INT FROM free_session_email_deliveries WHERE status='failed') AS "emailsFailed"
    FROM payment_transactions`);

  // Popular frames
  const popularFramesResult = await pool.query(`
    SELECT frame_design, COUNT(*)::INT AS count
    FROM free_photobooth_sessions
    GROUP BY frame_design
    ORDER BY count DESC
  `);

  // Recent free sessions
  const recentFreeSessions = await pool.query(`
    SELECT fs.id, fs.frame_design, fs.status, fs.created_at, fs.expires_at,
           COUNT(sp.id)::INT AS photos_saved,
           ps.status AS strip_status
    FROM free_photobooth_sessions fs
    LEFT JOIN photobooth_sessions s ON s.id = fs.session_id
    LEFT JOIN session_photos sp ON sp.session_id = s.id AND sp.status = 'saved'
    LEFT JOIN session_photostrips ps ON ps.session_id = s.id
    GROUP BY fs.id, fs.frame_design, fs.status, fs.created_at, fs.expires_at, ps.status
    ORDER BY fs.created_at DESC
    LIMIT 10
  `);

  return {
    stats: result.rows[0],
    popularFrames: popularFramesResult.rows,
    recentFreeSessions: recentFreeSessions.rows,
    recentTransactions: (await listTransactions(pool, operatorId)).slice(0, 10)
  };
}
