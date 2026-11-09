import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { cleanExpiredPhotoAssets } from './photo-retention.js';

let pool;
try {
  const config = loadConfig();
  pool = createPool(config);
  await pool.query('SELECT 1');
  const migration = await pool.query(
    'SELECT name FROM operator_schema_migrations WHERE name = ANY($1)',
    [['02-phase1-support', '03-automated-payment-and-public', '04-camera-and-photos']]
  );
  if (migration.rowCount < 3) throw new Error('Required migrations are missing. Inspect migration tracking before running npm run migrate.');
  const paymentMarker = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='is_simulated'");
  if (!paymentMarker.rowCount) throw new Error('Required payment tracking column is missing. Inspect migration tracking before running npm run migrate.');
  const server = createApp({ pool, config }).listen(config.PORT, '0.0.0.0', () =>
    console.log(
      `Photobooth API listening on port ${config.PORT}; n8n ${config.N8N_ENABLED ? 'enabled (verify integration before use)' : 'disabled'}.`
    )
  );
  if (config.PHOTO_CLEANUP_ENABLED) {
    let cleanupRunning = false;
    const runCleanup = async () => {
      if (cleanupRunning) return;
      cleanupRunning = true;
      try {
        const report = await cleanExpiredPhotoAssets(pool, { galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS, batchSize: 100, apply: true });
        console.log(`Photo retention batch: ${JSON.stringify(report)}`);
      } catch {
        console.error('Photo retention batch failed; expired asset records remain available for retry.');
      } finally { cleanupRunning = false; }
    };
    void runCleanup();
    const cleanupTimer = setInterval(runCleanup, config.PHOTO_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000);
    cleanupTimer.unref();
  }
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
} catch (error) {
  console.error(`API startup failed: ${error.code || error.message}`);
  if (pool) await pool.end();
  process.exitCode = 1;
}
