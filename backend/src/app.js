import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZodError } from 'zod';
import { csrfProtection, requireOperator, login, newCsrf, saveSession, destroySession } from './auth.js';
import {
  loginSchema, packageSchema, packagePatchSchema, transactionSchema,
  confirmationSchema, uuid, publicTransactionSchema, simulatePaymentSchema,
  paymentWebhookSchema, photoUploadSchema, photostripSchema,
  freeSessionSchema, emailDeliverySchema
} from './validation.js';
import { AppError, fail } from './errors.js';
import {
  createTransaction, confirmSimulation, dashboard, getTransaction,
  listTransactions, updatePackage, getPublicPackages, createPublicTransaction,
  getPublicTransaction, initiatePaymentSimulation, handlePaymentNotification,
  getPublicSession
} from './services.js';
import { issueToken } from './n8n.js';
import { verifySignature } from './security.js';
import { uploadPhoto, getSessionGallery, getPhotoFile, getStripFile, composePhotostrip, verifySessionAccess } from './photos.js';
import { createGalleryShare, getSharedGallery, getSharedPhotoFile, getSharedStripFile } from './gallery-sharing.js';
import { createFreeSession, getFreeSession, sendPhotoEmail, getEmailDeliveryStatus } from './free-sessions.js';
import { runQualityControlCheck, getQualityControlStatus, retryFailedEmail, recordQualityControlIncident, diagnoseIncident } from './qc.js';
import QRCode from 'qrcode';
import { MAX_UPLOAD_BYTES } from './storage.js';

export function createApp({ pool, config, tokenIssuer = issueToken, sessionStore }) {
  const app = express();
  const simulatorOnly = (req, res, next) => config.NODE_ENV === 'production'
    ? res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } })
    : next();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY_HOPS) app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID(); res.set('X-Request-ID', req.requestId);
    res.set('Cache-Control', 'no-store'); next();
  });
  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1'); res.json({ status: 'ok' });
  });
  app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, validate: { xForwardedForHeader: false }, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } } }));
  app.use(express.json({ limit: '16kb', strict: true }));

  // ---------------- Public Visitor & Webhook Routes (No CSRF/Session required) ----------------

  // Webhook for n8n Payment Simulator notifications
  app.post('/api/webhooks/payment-notification', simulatorOnly, async (req, res) => {
    const signature = req.get('x-simulation-signature') || '';
    const rawBody = JSON.stringify(req.body);
    const valid = verifySignature(rawBody, signature, config.paymentSimulatorSecret);
    if (!valid) {
      fail(401, 'INVALID_SIGNATURE', 'Invalid payment simulator webhook signature.');
    }
    const notification = paymentWebhookSchema.parse(req.body);
    const result = await handlePaymentNotification(pool, config, notification, tokenIssuer);
    res.json(result);
  });

  // Public visitor photobooth endpoints
  app.get('/api/public/packages', async (req, res) => {
    res.json({ packages: await getPublicPackages(pool) });
  });

  app.post('/api/public/transactions', simulatorOnly, async (req, res) => {
    const input = publicTransactionSchema.parse(req.body);
    const result = await createPublicTransaction(pool, config, input, req.ip);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  app.get('/api/public/transactions/:id', async (req, res) => {
    const checkoutKey = req.query.checkoutKey || req.get('x-checkout-key');
    const tx = await getPublicTransaction(pool, uuid.parse(req.params.id), checkoutKey);
    res.json({ transaction: tx });
  });

  app.post('/api/public/transactions/:id/simulate-payment', simulatorOnly, async (req, res) => {
    const input = simulatePaymentSchema.parse(req.body);
    const result = await initiatePaymentSimulation(pool, config, uuid.parse(req.params.id), input, req.ip);
    res.json(result);
  });

  app.get('/api/public/sessions/:id', async (req, res) => {
    const keyOrToken = req.get('x-checkout-key') || req.get('x-session-key') || req.query.key || req.query.token;
    const session = await getPublicSession(pool, uuid.parse(req.params.id), keyOrToken, { galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS ?? 24 });
    res.json({ session });
  });

  // ---- Free Session Routes (racebooth. — no payment required) ----
  const freeSessionsLimiter = rateLimit({ windowMs: 3600000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: { code: 'FREE_SESSION_RATE_LIMITED', message: 'Too many free sessions. Try again later.' } } });

  app.post('/api/public/free-sessions', freeSessionsLimiter, async (req, res) => {
    const input = freeSessionSchema.parse(req.body);
    const result = await createFreeSession(pool, config, { ...input, clientIp: req.ip });
    res.status(201).json(result);
  });

  app.get('/api/public/free-sessions/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const sessionKey = req.get('x-session-key') || req.query.key || '';
    const fs = await getFreeSession(pool, id, sessionKey);
    res.json({ freeSession: fs });
  });

  const emailLimiter = rateLimit({ windowMs: 300000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: { error: { code: 'EMAIL_RATE_LIMITED', message: 'Too many email requests. Wait a few minutes.' } } });

  app.post('/api/public/free-sessions/:id/send-email', emailLimiter, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { recipientEmail } = emailDeliverySchema.parse(req.body);
    const sessionKey = req.get('x-session-key') || req.body.sessionKey || '';
    const result = await sendPhotoEmail(pool, config, { freeSessionId: id, sessionKey, recipientEmail });
    res.json(result);
  });

  app.get('/api/public/free-sessions/:id/email-status', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const sessionKey = req.get('x-session-key') || req.query.key || '';
    const status = await getEmailDeliveryStatus(pool, id, sessionKey, config);
    res.json(status);
  });

  // Images are streamed to Express, never through n8n or a public static directory.
  const photoOptions = { galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS ?? 24 };
  const checkoutCredential = req => req.get('x-checkout-key') || req.get('x-session-key') || '';
  const uploads = rateLimit({ windowMs: 60000, limit: 24, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false }, message: { error: { code: 'UPLOAD_RATE_LIMITED', message: 'Too many photo attempts. Wait a minute before retrying.' } } });
  let admittedUploads = 0;
  async function admitUpload(req, res, next) {
    if (admittedUploads >= 2) fail(429, 'UPLOAD_BUSY', 'The booth is saving another photo. Try again shortly.');
    const id = uuid.parse(req.params.id);
    await verifySessionAccess(pool, id, checkoutCredential(req), photoOptions);
    if (admittedUploads >= 2) fail(429, 'UPLOAD_BUSY', 'The booth is saving another photo. Try again shortly.');
    admittedUploads++;
    let released = false;
    req.releasePhotoUpload = () => { if (!released) { admittedUploads--; released = true; } };
    res.once('close', () => { if (!req.photoProcessing) req.releasePhotoUpload(); });
    next();
  }
  app.post('/api/public/sessions/:id/photos', uploads, admitUpload,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_UPLOAD_BYTES }), async (req, res) => {
      req.photoProcessing = true;
      try {
        const input = photoUploadSchema.parse({ sequence: Number(req.get('x-photo-sequence')), filter: req.get('x-photo-filter') || 'original', checkoutKey: checkoutCredential(req) });
        const result = await uploadPhoto(pool, uuid.parse(req.params.id), input, req.body, { ...photoOptions, claimedMime: req.get('content-type')?.split(';')[0] });
        res.status(result.replayed ? 200 : 201).json(result);
      } finally { req.releasePhotoUpload(); }
    });
  app.get('/api/public/sessions/:id/gallery', async (req, res) => {
    res.json(await getSessionGallery(pool, uuid.parse(req.params.id), checkoutCredential(req), photoOptions));
  });
  app.post('/api/public/sessions/:id/photostrip', async (req, res) => {
    const input = photostripSchema.parse({ ...req.body, finalize: Object.hasOwn(req.body || {}, 'finalize') ? req.body.finalize : true, checkoutKey: checkoutCredential(req) });
    const result = await composePhotostrip(pool, uuid.parse(req.params.id), input, photoOptions);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  async function sendImage(req, res, file) {
    res.set({ 'Content-Type': file.mimeType, 'Content-Length': String(file.size),
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${file.filename}"`,
      'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    try { await pipeline(file.stream, res); }
    catch (error) { if (!res.headersSent) throw error; res.destroy(); }
  }
  app.get('/api/public/sessions/:id/photos/:photoId/file', async (req, res) => {
    await sendImage(req, res, await getPhotoFile(pool, uuid.parse(req.params.id), uuid.parse(req.params.photoId), checkoutCredential(req), photoOptions));
  });
  app.get('/api/public/sessions/:id/photostrip/file', async (req, res) => {
    await sendImage(req, res, await getStripFile(pool, uuid.parse(req.params.id), checkoutCredential(req), photoOptions));
  });

  // ---------------- Public Shared Gallery & QR Endpoints ----------------
  app.post('/api/public/sessions/:id/gallery-share', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const result = await createGalleryShare(pool, config, id, checkoutCredential(req), req.body);
    const origin = config.PUBLIC_APP_ORIGIN || (config.APP_ORIGINS?.find(o => o.startsWith('http')) || `${req.protocol}://${req.get('host')}`);
    const url = `${origin}/photobooth/gallery/${id}#share=${result.shareToken}`;
    const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320, color: { dark: '#20342f', light: '#ffffff' } });
    res.json({ ...result, url, qrDataUrl });
  });

  const bearerToken = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  app.get('/api/public/galleries/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json(await getSharedGallery(pool, config, id, bearerToken(req)));
  });

  app.get('/api/public/galleries/:id/photos/:photoId/file', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const photoId = uuid.parse(req.params.photoId);
    await sendImage(req, res, await getSharedPhotoFile(pool, config, id, photoId, bearerToken(req)));
  });

  app.get('/api/public/galleries/:id/photostrip/file', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await sendImage(req, res, await getSharedStripFile(pool, config, id, bearerToken(req)));
  });

  // ---------------- Operator Authentication & Session Setup ----------------

  const PgStore = connectPgSimple(session);
  app.use('/api', session({
    name: config.COOKIE_SECURE ? '__Host-photobooth.sid' : 'photobooth.sid',
    secret: config.SESSION_SECRET,
    store: sessionStore || new PgStore({ pool, tableName: 'operator_http_sessions', createTableIfMissing: false, pruneSessionInterval: 900 }),
    resave: false, saveUninitialized: false, rolling: false,
    cookie: { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', maxAge: config.SESSION_MAX_AGE_HOURS * 3600000 }
  }));
  app.get('/api/auth/csrf', async (req, res) => {
    req.session.csrfToken ||= newCsrf(); await saveSession(req);
    res.json({ csrfToken: req.session.csrfToken });
  });
  app.use('/api', csrfProtection(config));
  const authorized = requireOperator(pool, config);
  app.post('/api/auth/login', rateLimit({ windowMs: 900000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, validate: { xForwardedForHeader: false }, message: { error: { code: 'LOGIN_THROTTLED', message: 'Too many login attempts. Try again in 15 minutes.' } } }), async (req, res, next) => {
    await login(pool, req, loginSchema.parse(req.body));
    await authorized(req, res, next);
  }, (req, res) => res.json({ user: req.user, csrfToken: req.session.csrfToken }));
  app.get('/api/auth/me', authorized, (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/logout', async (req, res) => {
    await destroySession(req);
    res.clearCookie(config.COOKIE_SECURE ? '__Host-photobooth.sid' : 'photobooth.sid', { path: '/', httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict' });
    res.json({ ok: true });
  });

  // ---------------- Operator Protected Routes ----------------

  app.use('/api', authorized);
  app.get('/api/dashboard', async (req, res) => res.json(await dashboard(pool, req.user.id)));
  app.get('/api/packages', async (req, res) => res.json({ packages: (await pool.query('SELECT * FROM photo_packages ORDER BY created_at DESC')).rows }));
  app.post('/api/packages', async (req, res) => {
    const p = packageSchema.parse(req.body);
    const result = await pool.query('INSERT INTO photo_packages(name,price_idr,photo_limit,session_duration_minutes,is_active) VALUES($1,$2,$3,$4,$5) RETURNING *', [p.name, p.price_idr, p.photo_limit, p.session_duration_minutes, p.is_active]);
    res.status(201).json({ package: result.rows[0] });
  });
  app.patch('/api/packages/:id', async (req, res) => res.json({ package: await updatePackage(pool, uuid.parse(req.params.id), packagePatchSchema.parse(req.body)) }));
  app.get('/api/transactions', async (req, res) => res.json({ transactions: await listTransactions(pool, req.user.id) }));
  app.post('/api/transactions', simulatorOnly, async (req, res) => {
    const result = await createTransaction(pool, req.user.id, transactionSchema.parse(req.body));
    res.status(result.replayed ? 200 : 201).json(result);
  });
  app.get('/api/transactions/:id', async (req, res) => res.json({ transaction: await getTransaction(pool, uuid.parse(req.params.id), req.user.id) }));
  app.post('/api/transactions/:id/confirm-simulation', simulatorOnly, async (req, res) => {
    confirmationSchema.parse(req.body);
    res.json(await confirmSimulation(pool, req.user.id, uuid.parse(req.params.id), { id: req.requestId, ip: req.ip }));
  });
  app.post('/api/transactions/:id/token', async (req, res) => {
    res.json(await tokenIssuer(pool, config, req.user.id, uuid.parse(req.params.id)));
  });

  // ---------------- Operator Quality Control & Hermes Monitoring ----------------
  app.get('/api/qc/status', async (req, res) => res.json(await getQualityControlStatus(pool, config)));
  app.post('/api/qc/check', async (req, res) => res.json(await runQualityControlCheck(pool, config, req.user?.email || 'operator')));
  app.post('/api/qc/incidents/:id/diagnose', rateLimit({ windowMs: 3600000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res) => res.json({ diagnosis: await diagnoseIncident(pool, config, uuid.parse(req.params.id)) }));
  app.post('/api/qc/retry-email/:deliveryId', async (req, res) => res.json(await retryFailedEmail(pool, config, uuid.parse(req.params.deliveryId))));

  // ---------------- Error Handling ----------------

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
  app.use(async (error, req, res, next) => {
    if (res.headersSent) return next(error);
    // Persist codes and route templates only: no capabilities, email addresses,
    // raw upstream responses, request bodies, or image data enter QC telemetry.
    const code = /^[A-Z0-9_]{1,60}$/.test(error.code || '') ? error.code : 'REQUEST_FAILED';
    const route = req.route?.path || '';
    let category;
    if (/QUOTA|SEQUENCE_OUT_OF_RANGE/.test(code)) category = 'quota';
    else if (/gallery|galleries|\/file$/.test(route) || /SHARE_|GALLERY_/.test(code)) category = 'api';
    else if (/send-email/.test(route) || /EMAIL_/.test(code)) category = 'email';
    else if (/N8N_|SIMULATOR_/.test(code)) category = 'workflow';
    else if (/\/photos$|\/photostrip$/.test(route)) category = 'storage';
    else if (route === '/api/health') category = 'api';
    if (category) {
      try {
        await recordQualityControlIncident(pool, { category, severity: route === '/api/health' ? 'critical' : 'warning',
          title: `${category} request: ${code}`, description: `A request to ${route || 'the API'} failed with ${code}.`,
          entity_id: /^[a-f0-9-]{36}$/i.test(req.params?.id || '') ? req.params.id : null,
          recommendation: 'Review the request ID in backend logs and the relevant QC check before retrying.' });
      } catch { console.error(JSON.stringify({ event: 'qc_record_failed', requestId: req.requestId })); }
    }
    if (error instanceof ZodError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the submitted fields.', fields: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }, requestId: req.requestId });
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message }, requestId: req.requestId });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request.' } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large.' } });
    console.error(JSON.stringify({ requestId: req.requestId, event: 'request_failed', code: /^[A-Z0-9_]{1,40}$/.test(error.code || '') ? error.code : 'INTERNAL_ERROR' }));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed. Use the request ID when reporting this issue.' }, requestId: req.requestId });
  });
  return app;
}
