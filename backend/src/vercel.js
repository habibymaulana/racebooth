import express from 'express';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';

// Vercel reuses this module between invocations. Keep the pool and Express app
// at module scope; never create a listener or a background timer here.
const config = loadConfig();
if (!config.SERVERLESS_DEPLOYMENT) throw new Error('Serverless deployment mode is not enabled.');
const pool = createPool(config);
let readinessPromise;

async function verifySchema() {
  await pool.query('SELECT 1');
  const required = [
    '02-phase1-support', '03-automated-payment-and-public', '04-camera-and-photos',
    '05-free-sessions', '06-qc-monitoring', '07-qc-check-details', '08-expand-frames',
    '09-expand-filters', '10-photostrip-editing', '11-qc-diagnoses',
    '12-simulated-payment-tracking', '13-serverless-rate-limits', '14-admin-packages-auto-simulation',
  ];
  const migrations = await pool.query(
    'SELECT name FROM operator_schema_migrations WHERE name = ANY($1)', [required]
  );
  if (migrations.rowCount !== required.length) throw new Error('Schema version is incomplete.');
  const paymentMarker = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='is_simulated'");
  if (!paymentMarker.rowCount) throw new Error('Schema marker is missing.');
}

const handler = express();
handler.disable('x-powered-by');
handler.use(async (req, res, next) => {
  try {
    if (!readinessPromise) {
      readinessPromise = verifySchema().catch(error => {
        readinessPromise = undefined;
        throw error;
      });
    }
    await readinessPromise;
    next();
  } catch {
    res.set('Cache-Control', 'no-store').status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'The API is temporarily unavailable.' },
    });
  }
});
handler.use(createApp({ pool, config }));

export default handler;
