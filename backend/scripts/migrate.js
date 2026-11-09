import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createPool, transaction } from '../src/db.js';

const pool = createPool(loadConfig());
const migrations = [
  { name: '02-phase1-support', path: '../../database/migrations/02-phase1-support.sql' },
  { name: '03-automated-payment-and-public', path: '../../database/migrations/03-automated-payment-and-public.sql' },
  { name: '04-camera-and-photos', path: '../../database/migrations/04-camera-and-photos.sql' },
  { name: '05-free-sessions', path: '../../database/migrations/05-free-sessions.sql' },
  { name: '06-qc-monitoring', path: '../../database/migrations/06-qc-monitoring.sql' },
  { name: '07-qc-check-details', path: '../../database/migrations/07-qc-check-details.sql' },
  { name: '08-expand-frames', path: '../../database/migrations/08-expand-frames.sql' },
  { name: '09-expand-filters', path: '../../database/migrations/09-expand-filters.sql' },
  { name: '10-photostrip-editing', path: '../../database/migrations/10-photostrip-editing.sql' },
  { name: '11-qc-diagnoses', path: '../../database/migrations/11-qc-diagnoses.sql' },
  { name: '12-simulated-payment-tracking', path: '../../database/migrations/12-simulated-payment-tracking.sql' }
];

try {
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('photobooth-schema-migrations', 0))");
    const columns = await db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1)",
      [['app_users', 'photo_packages', 'payment_transactions', 'photobooth_sessions']]
    );
    for (const table of ['app_users', 'photo_packages', 'payment_transactions', 'photobooth_sessions']) {
      if (!columns.rows.some(r => r.table_name === table)) {
        throw new Error(`Missing existing table: ${table}. This migration does not create the original schema.`);
      }
    }
    await db.query(
      'CREATE TABLE IF NOT EXISTS operator_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );

    for (const mig of migrations) {
      const exists = await db.query('SELECT name FROM operator_schema_migrations WHERE name=$1', [mig.name]);
      if (exists.rowCount) {
        console.log(`Migration ${mig.name} already applied.`);
        continue;
      }
      const file = fileURLToPath(new URL(mig.path, import.meta.url));
      // Historical 05/06 also support direct psql execution. Keep this runner's
      // single transaction authoritative, including its advisory schema lock.
      const sql = (await readFile(file, 'utf8')).replace(/^\s*BEGIN;\s*$/gmi, '').replace(/^\s*COMMIT;\s*$/gmi, '');
      await db.query(sql);
      await db.query('INSERT INTO operator_schema_migrations(name) VALUES($1) ON CONFLICT(name) DO NOTHING', [mig.name]);
      console.log(`Applied additive migration: ${mig.name}`);
    }
  });
} catch (error) {
  console.error(`Migration failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
