import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseR2Config } from './r2-config.js';

const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PGHOST: z.string().min(1), PGPORT: z.coerce.number().int().default(5432),
  PGDATABASE: z.string().min(1), PGUSER: z.string().min(1), PGPASSWORD: z.string().min(1),
  PGSSL: bool.default(false), PGSSLROOTCERT: z.string().default(''),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SESSION_SECRET: z.string().min(48), TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  COOKIE_SECURE: bool.default(false), SESSION_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  APP_ORIGINS: z.string().min(1).transform(v => v.split(',').map(s => new URL(s.trim()).origin)),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PHOTO_GALLERY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PHOTO_SHARE_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  PHOTO_STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  PHOTO_STORAGE_PATH: z.string().default(''),
  R2_ACCOUNT_ID: z.string().default(''), R2_BUCKET: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''), R2_SECRET_ACCESS_KEY: z.string().default(''),
  PHOTO_CLEANUP_ENABLED: bool.default(false),
  PHOTO_CLEANUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PUBLIC_APP_ORIGIN: z.string().default(''),
  SERVICE_USER_ID: z.string().default('00000000-0000-4000-8000-000000000001'),
  PAYMENT_SIMULATOR_SECRET: z.string().default(''),
  PAYMENT_SIMULATOR_URL: z.string().default('http://n8n:5678/webhook/photobooth/payment/simulate'),
  PAYMENT_SIMULATOR_DELAY_MS: z.coerce.number().int().min(100).max(30000).default(2500),
  N8N_SIMULATOR_ENABLED: bool.default(false),
  N8N_ENABLED: bool.default(false), N8N_WEBHOOK_URL: z.url().optional(),
  N8N_JWT_SECRET: z.string().default(''), N8N_JWT_SUBJECT: z.string().default(''),
  N8N_JWT_ISSUER: z.string().default(''), N8N_JWT_AUDIENCE: z.string().default(''),
  N8N_JWT_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
  N8N_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(15000),
  N8N_EMAIL_ENABLED: bool.default(false),
  N8N_EMAIL_WEBHOOK_URL: z.string().default(''),
  N8N_EMAIL_WEBHOOK_SECRET: z.string().default(''),
  N8N_EMAIL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(20000),
  N8N_EMAIL_RATE_LIMIT_PER_SESSION: z.coerce.number().int().min(1).max(5).default(1),
  FREE_SESSION_DURATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  FREE_SESSION_PHOTO_LIMIT: z.coerce.number().int().min(4).max(4).default(4),
  FREE_SESSION_RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(20).default(5),
  HERMES_ENDPOINT: z.string().default(''),
  HERMES_API_KEY: z.string().default(''),
  HERMES_API_KEY_FILE: z.string().default(''),
  HERMES_PROVIDER: z.string().regex(/^[a-z0-9_-]*$/i).max(32).default(''),
  HERMES_MODEL: z.string().regex(/^[\w./:-]*$/).max(100).default(''),
  HERMES_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),
  HERMES_INFERENCE_ENABLED: bool.default(false),
  HERMES_INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(60000),
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const c = result.data;
  // A missing optional Hermes secret must not prevent the booth from starting.
  if (!c.HERMES_API_KEY && c.HERMES_API_KEY_FILE) {
    try { c.HERMES_API_KEY = readFileSync(c.HERMES_API_KEY_FILE, 'utf8').trim().slice(0, 1024); }
    catch { c.HERMES_API_KEY = ''; }
  }
  if (c.PUBLIC_APP_ORIGIN && (!c.APP_ORIGINS.includes(c.PUBLIC_APP_ORIGIN) || new URL(c.PUBLIC_APP_ORIGIN).origin !== c.PUBLIC_APP_ORIGIN)) throw new Error('PUBLIC_APP_ORIGIN must be an exact configured APP_ORIGINS origin.');
  if (c.NODE_ENV === 'production') {
    if (!c.COOKIE_SECURE) throw new Error('Production requires COOKIE_SECURE=true and HTTPS.');
    if (!c.PGSSL) throw new Error('Production requires PGSSL=true for PostgreSQL TLS.');
    if (c.TRUST_PROXY_HOPS < 1) throw new Error('Production requires TRUST_PROXY_HOPS to match the trusted HTTPS proxy chain.');
    if (c.APP_ORIGINS.some(origin => new URL(origin).protocol !== 'https:')) throw new Error('Production APP_ORIGINS must use HTTPS.');
    if (!c.PUBLIC_APP_ORIGIN || new URL(c.PUBLIC_APP_ORIGIN).protocol !== 'https:') throw new Error('Production requires an HTTPS PUBLIC_APP_ORIGIN for gallery and QR links.');
    if (c.PHOTO_STORAGE_DRIVER !== 'r2') throw new Error('Production requires PHOTO_STORAGE_DRIVER=r2 for private durable photo storage.');
    if (c.N8N_SIMULATOR_ENABLED) throw new Error('Production requires N8N_SIMULATOR_ENABLED=false for free-only V1.');
  }
  if (c.PHOTO_STORAGE_DRIVER === 'local' && c.PHOTO_STORAGE_PATH && !isAbsolute(c.PHOTO_STORAGE_PATH)) throw new Error('PHOTO_STORAGE_PATH must be absolute when set.');
  if (c.PHOTO_STORAGE_DRIVER === 'r2') parseR2Config(c);
  if (c.PHOTO_CLEANUP_ENABLED && (c.NODE_ENV !== 'production' || c.PHOTO_STORAGE_DRIVER !== 'r2')) {
    throw new Error('Photo cleanup can be enabled only in production with private R2 storage.');
  }
  if (c.N8N_ENABLED && (!c.N8N_WEBHOOK_URL || c.N8N_JWT_SECRET.length < 32 || !c.N8N_JWT_SUBJECT || !c.N8N_JWT_ISSUER || !c.N8N_JWT_AUDIENCE)) {
    throw new Error('Enabled n8n requires a strong JWT secret, URL, subject, issuer, and audience.');
  }
  if (c.N8N_ENABLED && c.N8N_JWT_SUBJECT !== '{operator_id}') throw new Error('N8N_JWT_SUBJECT must be {operator_id}: WF-01 requires the authenticated operator UUID as sub.');
  if (c.N8N_ENABLED) {
    const url = new URL(c.N8N_WEBHOOK_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid n8n webhook URL.');
    if (c.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production n8n webhook URLs must use HTTPS.');
  }
  for (const value of [c.N8N_EMAIL_WEBHOOK_URL, c.HERMES_ENDPOINT].filter(Boolean)) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid integration endpoint URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid integration endpoint URL.');
  }
  if (c.N8N_EMAIL_ENABLED && (!c.N8N_EMAIL_WEBHOOK_URL || c.N8N_EMAIL_WEBHOOK_SECRET.length < 32 || !c.PUBLIC_APP_ORIGIN)) {
    throw new Error('Enabled email requires a webhook URL, a secret of at least 32 characters, and PUBLIC_APP_ORIGIN.');
  }
  if (c.NODE_ENV === 'production' && c.N8N_EMAIL_ENABLED && new URL(c.N8N_EMAIL_WEBHOOK_URL).protocol !== 'https:') throw new Error('Production email webhook URLs must use HTTPS.');
  c.paymentSimulatorSecret = c.PAYMENT_SIMULATOR_SECRET || c.SESSION_SECRET;
  c.pg = {
    host: c.PGHOST, port: c.PGPORT, database: c.PGDATABASE, user: c.PGUSER, password: c.PGPASSWORD,
    max: c.DATABASE_POOL_MAX, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    ssl: c.PGSSL ? { rejectUnauthorized: true, ...(c.PGSSLROOTCERT ? { ca: readFileSync(c.PGSSLROOTCERT, 'utf8') } : {}) } : false
  };
  return c;
}
