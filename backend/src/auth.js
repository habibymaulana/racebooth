import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fail } from './errors.js';
import { hashPassword, verifyPassword } from './security.js';

export const saveSession = req => new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve()));
export const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
export const destroySession = req => new Promise((resolve, reject) => req.session.destroy(e => e ? reject(e) : resolve()));
export const newCsrf = () => randomBytes(32).toString('base64url');

export function csrfProtection(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && !config.APP_ORIGINS.includes(origin)) fail(403, 'ORIGIN_REJECTED', 'This browser origin is not allowed.');
    const supplied = req.get('x-csrf-token');
    const expected = req.session.csrfToken;
    if (typeof supplied !== 'string' || typeof expected !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      fail(403, 'CSRF_REJECTED', 'Refresh the page and try again.');
    }
    next();
  };
}
export function requireOperator(pool, config) {
  return async (req, res, next) => {
    if (!req.session.userId || !req.session.authenticatedAt) fail(401, 'AUTH_REQUIRED', 'Log in to continue.');
    if (Date.now() - req.session.authenticatedAt > config.SESSION_MAX_AGE_HOURS * 3600000) {
      await destroySession(req); fail(401, 'SESSION_EXPIRED', 'Your session expired. Log in again.');
    }
    const result = await pool.query('SELECT id,full_name,email,role,is_active FROM app_users WHERE id=$1', [req.session.userId]);
    const user = result.rows[0];
    if (!user || !user.is_active) { await destroySession(req); fail(401, 'AUTH_REQUIRED', 'Log in to continue.'); }
    if (!['operator', 'supervisor', 'admin'].includes(user.role)) fail(403, 'OPERATOR_REQUIRED', 'An active workspace account is required.');
    req.user = { id: user.id, fullName: user.full_name, email: user.email, role: user.role };
    next();
  };
}

export function requirePackageAdmin(req, res, next) {
  if (req.user?.role !== 'admin') fail(403, 'PACKAGE_ADMIN_REQUIRED', 'An authorized administrator is required to manage packages.');
  next();
}

// Dummy scrypt computation keeps unknown-account authentication on the same slow path.
let dummyHash;
export async function login(pool, req, body) {
  const key = createHash('sha256').update(`${body.email}|${req.ip}`).digest('hex');
  const limit = await pool.query(`INSERT INTO operator_login_limits(key_hash,attempts,window_start) VALUES($1,1,NOW())
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN operator_login_limits.window_start < NOW()-INTERVAL '15 minutes' THEN 1 ELSE operator_login_limits.attempts+1 END,
      window_start=CASE WHEN operator_login_limits.window_start < NOW()-INTERVAL '15 minutes' THEN NOW() ELSE operator_login_limits.window_start END
    RETURNING attempts`, [key]);
  if (limit.rows[0].attempts > 8) fail(429, 'LOGIN_THROTTLED', 'Too many login attempts. Try again in 15 minutes.');
  const result = await pool.query('SELECT id,password_hash,role,is_active FROM app_users WHERE lower(email)=$1 ORDER BY created_at LIMIT 2', [body.email]);
  const user = result.rowCount === 1 ? result.rows[0] : undefined;
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  const valid = await verifyPassword(body.password, user?.password_hash || await dummyHash);
  if (!valid || !user?.is_active || !['operator', 'supervisor', 'admin'].includes(user.role)) fail(401, 'INVALID_CREDENTIALS', 'Invalid operator email or password.');
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.authenticatedAt = Date.now();
  req.session.csrfToken = newCsrf();
  await saveSession(req);
  await pool.query('UPDATE operator_login_limits SET attempts=0,window_start=NOW() WHERE key_hash=$1', [key]);
  return user;
}
