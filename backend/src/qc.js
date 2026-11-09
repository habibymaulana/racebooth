import { fail } from './errors.js';
import { transaction } from './db.js';
import { openStoredFile } from './storage.js';
import { sendPhotoEmail } from './free-sessions.js';

const setupInstructions = [
  'Hermes Agent has not been connected to this application.',
  'After installation approval, follow the official quickstart and run hermes model.',
  'Configure an isolated Hermes API server, then set server-only HERMES_ENDPOINT and HERMES_API_KEY.',
  'See docs/hermes-setup.md. Operator-requested diagnoses require a verified, tool-restricted runtime.'
];

function safeBaseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
  return url;
}

async function getJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error' });
  if (!response.ok) throw new Error('Endpoint unavailable');
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('Unexpected response');
  return JSON.parse(text);
}

/** Probe the official Hermes API identity/readiness, without invoking a model or tools. */
export async function checkHermesAvailability(config = {}, fetchImpl = fetch) {
  if (!config.HERMES_ENDPOINT) return {
    configured: false, connected: false, status: 'unconfigured', modelVerified: false,
    message: 'No Hermes API endpoint is configured. Installation and model availability are unverified in this runtime.',
    setupInstructions
  };
  if (!config.HERMES_API_KEY) return {
    configured: false, connected: false, status: 'unconfigured', modelVerified: false,
    message: 'Hermes endpoint is set, but its server-only API key is missing.', setupInstructions
  };
  try {
    const base = safeBaseUrl(config.HERMES_ENDPOINT);
    const root = base.href.replace(/\/$/, '');
    const options = { headers: { Authorization: `Bearer ${config.HERMES_API_KEY}` }, signal: AbortSignal.timeout(config.HERMES_TIMEOUT_MS ?? 5000) };
    const identity = await getJson(`${root}/v1/capabilities`, options, fetchImpl);
    if (identity.platform !== 'hermes-agent' || identity.object !== 'hermes.api_server.capabilities') return {
      configured: true, connected: false, status: 'unverified', modelVerified: false,
      message: 'The configured endpoint did not identify itself as the Nous Research Hermes Agent API.'
    };
    const readiness = await getJson(`${root}/health/detailed`, options, fetchImpl);
    // Readiness is reported by Hermes. A successful HTTP status alone is not readiness.
    const ready = readiness.status === 'ok' && readiness.readiness?.status === 'ok';
    return {
      configured: true, connected: true, status: ready ? 'ready' : 'degraded', modelVerified: false,
      message: ready ? 'Hermes identity and readiness are verified. Model inference requires a separate successful diagnosis.' : 'Hermes identity is verified, but detailed readiness is not ready. Inspect Hermes locally.',
      readinessStatus: typeof readiness.readiness?.status === 'string' ? readiness.readiness.status.slice(0, 40) : 'unknown',
      setupInstructions
    };
  } catch {
    return { configured: true, connected: false, status: 'unreachable', modelVerified: false,
      message: 'The configured Hermes API could not be verified. Check its gateway, credentials, and readiness locally.', setupInstructions };
  }
}

/** Persist a sanitized incident once while it remains open, including concurrent requests. */
export async function recordQualityControlIncident(pool, incident) {
  const { category, severity = 'warning', title, description, recommendation = null, entity_id = null } = incident;
  return transaction(pool, async db => {
    const key = JSON.stringify([category, title, entity_id]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`racebooth-qc:${key}`]);
    const existing = await db.query(
      "SELECT id FROM qc_incidents WHERE category=$1 AND title=$2 AND entity_id IS NOT DISTINCT FROM $3 AND status='open' LIMIT 1",
      [category, title, entity_id]
    );
    if (existing.rowCount) {
      await db.query('UPDATE qc_incidents SET severity=$2,description=$3,recommendation=$4 WHERE id=$1', [existing.rows[0].id, severity, description, recommendation]);
      return existing.rows[0].id;
    }
    const result = await db.query(
      "INSERT INTO qc_incidents(category,severity,title,description,recommendation,entity_id,status) VALUES($1,$2,$3,$4,$5,$6,'open') RETURNING id",
      [category, severity, title, description, recommendation, entity_id]
    );
    return result.rows[0].id;
  });
}

export async function checkN8nConnectivity(config, fetchImpl = fetch) {
  const endpoint = config.N8N_EMAIL_WEBHOOK_URL || config.N8N_WEBHOOK_URL;
  if (!endpoint) return { status: 'unconfigured', message: 'No n8n webhook endpoint is configured; workflow execution and Gmail delivery are unverified.' };
  try {
    const url = safeBaseUrl(endpoint);
    const response = await fetchImpl(`${url.origin}/healthz`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.ok
      ? { status: 'reachable', message: 'n8n health endpoint responded. This does not verify webhook authentication, workflow execution, or Gmail delivery.' }
      : { status: 'unreachable', message: 'n8n health endpoint returned an error. Workflow execution and Gmail delivery remain unverified.' };
  } catch {
    return { status: 'unreachable', message: 'n8n health endpoint could not be reached. No workflow was triggered by this check.' };
  }
}

/** Deterministic diagnostics only. No autonomous remediation or fabricated model diagnoses. */
export async function runQualityControlCheck(pool, config, executedBy = 'operator', dependencies = {}) {
  const started = Date.now();
  const checks = [];
  const incidents = [];
  const addIncident = (category, title, description, extra = {}) => incidents.push({ category, severity: 'warning', title, description, ...extra });
  async function check(name, category, fn) {
    try { checks.push({ name, ...await fn() }); }
    catch { checks.push({ name, status: 'error', message: 'The check could not complete. Its result is unknown.' }); addIncident(category, `${name} check unavailable`, 'The diagnostic query or file inspection failed. Its result is unknown.'); }
  }
  await check('Database connectivity', 'api', async () => {
    const result = await pool.query('SELECT 1 AS ok');
    if (result.rows[0]?.ok !== 1) throw new Error('Ping failed');
    return { status: 'ok', message: 'Database answered SELECT 1 through this backend.' };
  });
  await check('Photo upload records', 'storage', async () => {
    const result = await pool.query("SELECT COUNT(*)::INT AS failed FROM session_photos WHERE status='failed'");
    const failed = result.rows[0].failed;
    if (failed) addIncident('storage', 'Failed photo upload records', `${failed} photo records have failed status. Request-level upload errors are also recorded as incidents.`);
    return { status: failed ? 'warning' : 'ok', failed, message: `${failed} failed photo records. Rejected requests are tracked separately.` };
  });
  await check('Private storage consistency', 'storage', async () => {
    const result = await pool.query(`SELECT id,storage_path,file_size_bytes,kind,COUNT(*) OVER()::INT AS total FROM (
      SELECT id,storage_path,file_size_bytes,created_at,'photo' AS kind FROM session_photos WHERE status='saved'
      UNION ALL SELECT id,storage_path,file_size_bytes,created_at,'photostrip' AS kind FROM session_photostrips WHERE status='composed'
    ) files ORDER BY created_at DESC LIMIT 500`);
    let inconsistent = 0;
    for (const row of result.rows) {
      let file;
      try {
        file = await (dependencies.openStoredFile || openStoredFile)(row.storage_path);
        if (file.size !== row.file_size_bytes) throw new Error('Size mismatch');
      } catch {
        inconsistent++;
        addIncident('storage', 'Stored image unavailable or inconsistent', `A saved ${row.kind} cannot be opened safely or its size differs from its database record.`, { severity: 'critical', entity_id: row.id, recommendation: 'Inspect storage and backups manually. No files are removed by QC.' });
      } finally {
        if (file?.stream && !file.stream.closed) await new Promise(resolve => { file.stream.once('close', resolve); file.stream.destroy(); });
      }
    }
    const total = result.rows[0]?.total ?? 0;
    return { status: inconsistent ? 'warning' : (total > result.rowCount ? 'partial' : 'ok'), checked: result.rowCount, total, inconsistent,
      message: `Checked ${result.rowCount} of ${total} referenced files (at most the newest 500). Unreferenced files are not deleted or assessed.` };
  });
  await check('Session quota consistency', 'quota', async () => {
    const result = await pool.query(`SELECT s.id,s.photo_limit,s.photos_taken,COUNT(p.id)::INT AS actual_photos,fs.id AS free_id,fs.photo_limit AS free_photo_limit
      FROM photobooth_sessions s LEFT JOIN session_photos p ON p.session_id=s.id AND p.status='saved'
      LEFT JOIN free_photobooth_sessions fs ON fs.session_id=s.id
      GROUP BY s.id,fs.id HAVING COUNT(p.id)>s.photo_limit OR COUNT(p.id)<>s.photos_taken OR (fs.id IS NOT NULL AND (s.photo_limit<>4 OR fs.photo_limit<>4))`);
    for (const row of result.rows) addIncident('quota', 'Session photo quota inconsistency', `Accepted count: ${row.actual_photos}; recorded count: ${row.photos_taken}; authorized limit: ${row.photo_limit}.`, { severity: 'critical', entity_id: row.id });
    return { status: result.rowCount ? 'warning' : 'ok', inconsistent: result.rowCount, message: `${result.rowCount} session count or quota inconsistencies.` };
  });
  await check('Photostrip records', 'storage', async () => {
    const result = await pool.query("SELECT COUNT(*)::INT AS failed FROM session_photostrips WHERE status='failed'");
    const failed = result.rows[0].failed;
    if (failed) addIncident('storage', 'Photostrip composition failures', `${failed} photostrip records have failed status.`);
    return { status: failed ? 'warning' : 'ok', failed, message: `${failed} failed photostrip records.` };
  });
  await check('Email delivery records', 'email', async () => {
    const result = await pool.query(`SELECT id,status FROM free_session_email_deliveries WHERE status='failed' OR (status='pending' AND created_at<NOW()-INTERVAL '2 minutes') ORDER BY created_at DESC LIMIT 100`);
    for (const row of result.rows) addIncident('email', row.status === 'failed' ? 'Photo email delivery failed' : 'Photo email delivery unconfirmed', row.status === 'failed' ? 'A definite delivery failure is recorded. Inspect the delivery and workflow before an operator retry.' : 'A delivery has no confirmed Gmail result. Automatic retries are blocked to prevent duplicate email.', { entity_id: row.id });
    return { status: result.rowCount ? 'warning' : 'ok', affected: result.rowCount, message: `${result.rowCount} failed or stale unconfirmed deliveries among the newest 100 matching records. Gmail inbox receipt is not checked.` };
  });
  await check('Gallery access and workflow incidents', 'api', async () => {
    const result = await pool.query("SELECT category,COUNT(*)::INT AS count FROM qc_incidents WHERE status='open' AND category IN ('api','workflow') GROUP BY category");
    return { status: result.rowCount ? 'warning' : 'ok', recorded: result.rows, message: 'Recorded request and workflow failures. No private gallery is opened by this scan.' };
  });
  const n8n = await checkN8nConnectivity(config, dependencies.fetchImpl || fetch);
  checks.push({ name: 'n8n connectivity', ...n8n });
  if (n8n.status === 'unreachable') addIncident('workflow', 'n8n health endpoint unavailable', n8n.message);
  if (!config.N8N_EMAIL_ENABLED) addIncident('email', 'Photo email integration disabled', 'Photo email dispatch is disabled. The current workflow and Gmail credentials have not been verified by this scan.', { severity: 'info' });
  const hermes = await checkHermesAvailability(config, dependencies.fetchImpl || fetch);
  checks.push({ name: 'Hermes identity and readiness', status: hermes.status, message: hermes.message });
  if (hermes.status !== 'ready') addIncident('system', 'Hermes monitoring unavailable', hermes.message, { severity: 'info' });

  // Failed persistence is an error, never an invented successful run or zero count.
  for (const incident of incidents) await recordQualityControlIncident(pool, incident);
  const durationMs = Date.now() - started;
  const operationalIssues = incidents.filter(incident => incident.severity !== 'info').length;
  const summary = `Executed ${checks.length} checks in ${durationMs}ms; ${operationalIssues} operational findings. Review partial, unknown, and unconfigured checks.`;
  const details = { checks, n8n, hermes, durationMs };
  const run = await pool.query(`INSERT INTO qc_runs(executed_by,checks_run,incidents_found,hermes_status,summary,details)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`, [executedBy, checks.length, incidents.length, hermes.status, summary, JSON.stringify(details)]);
  return { runId: run.rows[0].id, executedAt: run.rows[0].created_at, checksRun: checks.length, incidents, hermes, n8n, checks, durationMs, summary };
}

export async function getQualityControlStatus(pool, config) {
  const incidents = await pool.query(`SELECT i.id,i.category,i.severity,i.title,i.description,i.recommendation,i.entity_id,i.status,i.detected_at,i.resolved_at,
    CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('severity',d.severity,'diagnosis',d.diagnosis,
      'probable_root_cause',d.probable_root_cause,'recommendation',d.recommendation,'model',d.model,'created_at',d.created_at) END AS ai_diagnosis
    FROM qc_incidents i LEFT JOIN LATERAL (SELECT * FROM qc_diagnoses WHERE incident_id=i.id ORDER BY created_at DESC LIMIT 1) d ON TRUE
    ORDER BY i.detected_at DESC LIMIT 50`);
  const run = await pool.query('SELECT id,executed_by,checks_run,incidents_found,hermes_status,summary,details,created_at FROM qc_runs ORDER BY created_at DESC LIMIT 1');
  const counts = await pool.query(`SELECT COUNT(*) FILTER (WHERE severity='critical' AND status='open')::INT AS critical_count,
    COUNT(*) FILTER (WHERE severity='warning' AND status='open')::INT AS warning_count,
    COUNT(*) FILTER (WHERE severity='info' AND status='open')::INT AS info_count,
    COUNT(*) FILTER (WHERE status='resolved')::INT AS resolved_count FROM qc_incidents`);
  const hermes = await checkHermesAvailability(config);
  hermes.inferenceEnabled = Boolean(config.HERMES_INFERENCE_ENABLED);
  hermes.configuredProvider = config.HERMES_PROVIDER || null;
  hermes.configuredModel = config.HERMES_MODEL || null;
  const latestDiagnosis = incidents.rows.map(incident => incident.ai_diagnosis).filter(Boolean)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  hermes.modelVerified = Boolean(latestDiagnosis && config.HERMES_PROVIDER && config.HERMES_MODEL
    && latestDiagnosis.model === `${config.HERMES_PROVIDER}:${config.HERMES_MODEL}`);
  if (latestDiagnosis) hermes.lastDiagnosis = { model: latestDiagnosis.model, created_at: latestDiagnosis.created_at };
  return { hermes, lastRun: run.rows[0] || null, counts: counts.rows[0], incidents: incidents.rows };
}

const incidentTypes = {
  'Failed photo upload records': 'Saved photo upload records have a failed status.',
  'Stored image unavailable or inconsistent': 'A referenced stored image is unavailable or its recorded size differs.',
  'Session photo quota inconsistency': 'A session photo count differs from its permitted or recorded count.',
  'Photostrip composition failures': 'Photostrip records have a failed status.',
  'Photo email delivery failed': 'An email delivery has a definite recorded failure.',
  'Photo email delivery unconfirmed': 'An email delivery has no confirmed provider result.',
  'n8n health endpoint unavailable': 'The n8n health endpoint is unavailable.',
  'Photo email integration disabled': 'The photo email integration is disabled.',
  'Hermes monitoring unavailable': 'Hermes readiness is unavailable.',
};

/** Explicit operator request; the gateway must report that every API toolset is disabled. */
export async function diagnoseIncident(pool, config, incidentId, fetchImpl = fetch) {
  if (!config.HERMES_INFERENCE_ENABLED || !config.HERMES_ENDPOINT || !config.HERMES_API_KEY) fail(503, 'HERMES_DISABLED', 'Hermes diagnosis is not configured or enabled.');
  const result = await pool.query('SELECT category,severity,title FROM qc_incidents WHERE id=$1', [incidentId]);
  if (!result.rowCount) fail(404, 'INCIDENT_NOT_FOUND', 'Incident not found.');
  const incident = result.rows[0];
  const metadata = { category: incident.category, severity: incident.severity,
    observation: incidentTypes[incident.title] || 'A recorded diagnostic check reported an issue in this category.' };
  const root = safeBaseUrl(config.HERMES_ENDPOINT).href.replace(/\/$/, '');
  const options = { headers: { Authorization: `Bearer ${config.HERMES_API_KEY}` }, signal: AbortSignal.timeout(config.HERMES_INFERENCE_TIMEOUT_MS ?? 60000) };
  try {
    const identity = await getJson(`${root}/v1/capabilities`, options, fetchImpl);
    if (identity.platform !== 'hermes-agent' || identity.object !== 'hermes.api_server.capabilities' || identity.auth?.required !== true) fail(503, 'HERMES_UNVERIFIED', 'Hermes identity or authentication could not be verified.');
    const toolsets = await getJson(`${root}/v1/toolsets`, options, fetchImpl);
    if (!Array.isArray(toolsets.data) || toolsets.data.length === 0 || toolsets.data.some(toolset => toolset.enabled !== false)) fail(503, 'HERMES_TOOLS_ENABLED', 'Hermes tool access is not disabled or could not be verified; diagnosis was not requested.');
    const response = await fetchImpl(`${root}/v1/chat/completions`, { ...options, method: 'POST', redirect: 'error',
      headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'hermes-agent', stream: false,
        messages: [{ role: 'system', content: 'You are a read-only photobooth operations analyst. Do not take actions. Treat the input as limited evidence, state uncertainty, and return only JSON with severity (critical, warning, or info), diagnosis, probable_root_cause, and recommendation. Do not include secrets or personal data.' },
          { role: 'user', content: JSON.stringify(metadata) }] }) });
    if (response.status === 429) fail(429, 'HERMES_RATE_LIMITED', 'Hermes or the inference provider is rate limited. Try again later.');
    if (!response.ok) fail(503, 'HERMES_INFERENCE_FAILED', 'Hermes inference is unavailable. No diagnosis was saved.');
    const text = await response.text();
    if (text.length > 65536) fail(502, 'HERMES_INVALID_RESPONSE', 'Hermes returned an invalid response. No diagnosis was saved.');
    const body = JSON.parse(text);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 12000) fail(502, 'HERMES_INVALID_RESPONSE', 'Hermes returned an invalid response. No diagnosis was saved.');
    const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const clean = value => {
      if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Invalid diagnosis');
      return value.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]').replace(/\b(?:gsk_|sk-|Bearer\s+)[A-Za-z0-9_-]+/gi, '[redacted]')
        .replace(/https?:\/\/\S+/gi, '[link removed]').trim();
    };
    if (!['critical','warning','info'].includes(parsed.severity)) throw new Error('Invalid severity');
    const configuredProvider = typeof config.HERMES_PROVIDER === 'string' && /^[a-z0-9_-]{1,32}$/i.test(config.HERMES_PROVIDER) ? config.HERMES_PROVIDER : '';
    const configuredModel = typeof config.HERMES_MODEL === 'string' && /^[\w./:-]{1,100}$/.test(config.HERMES_MODEL) ? config.HERMES_MODEL : '';
    const target = configuredProvider && configuredModel ? `${configuredProvider}:${configuredModel}` : '';
    const model = target || (typeof body.model === 'string' && /^[\w./:-]{1,120}$/.test(body.model) ? body.model : 'hermes-agent');
    const saved = await pool.query(`INSERT INTO qc_diagnoses(incident_id,severity,diagnosis,probable_root_cause,recommendation,model)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,severity,diagnosis,probable_root_cause,recommendation,model,created_at`,
    [incidentId, parsed.severity, clean(parsed.diagnosis), clean(parsed.probable_root_cause), clean(parsed.recommendation), model]);
    return saved.rows[0];
  } catch (error) {
    if (error.status) throw error;
    fail(503, 'HERMES_INFERENCE_FAILED', 'Hermes inference failed or returned an invalid diagnosis. No diagnosis was saved.');
  }
}

/** Explicit operator action only; ambiguous pending/sent deliveries are never reset. */
export async function retryFailedEmail(pool, config, deliveryId) {
  const delivery = await pool.query(`SELECT d.free_session_id,d.recipient_email,fs.session_key FROM free_session_email_deliveries d
    JOIN free_photobooth_sessions fs ON fs.id=d.free_session_id WHERE d.id=$1 AND d.status='failed'`, [deliveryId]);
  if (!delivery.rowCount) fail(409, 'DELIVERY_NOT_RETRYABLE', 'Only a definite failed delivery can be retried. Pending or sent deliveries require manual reconciliation.');
  const row = delivery.rows[0];
  return sendPhotoEmail(pool, config, { freeSessionId: row.free_session_id, sessionKey: row.session_key, recipientEmail: row.recipient_email });
}
