import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { cleanExpiredPhotoAssets } from '../src/photo-retention.js';

function parseArgs(args) {
  const options = { apply: false, batchSize: 100 };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--apply') options.apply = true;
    else if (args[index] === '--batch-size' && /^\d+$/.test(args[index + 1] || '')) options.batchSize = Number(args[++index]);
    else throw new Error('Usage: npm run cleanup:expired -- [--batch-size 1..500] [--apply]');
  }
  return options;
}

let pool;
try {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (options.apply && (config.NODE_ENV !== 'production' || config.PHOTO_STORAGE_DRIVER !== 'r2' || !config.PHOTO_CLEANUP_ENABLED)) {
    throw new Error('Apply requires production R2 storage and PHOTO_CLEANUP_ENABLED=true.');
  }
  pool = createPool(config);
  const report = await cleanExpiredPhotoAssets(pool, {
    galleryTtlHours: config.PHOTO_GALLERY_TTL_HOURS,
    batchSize: options.batchSize,
    apply: options.apply,
  });
  console.log(JSON.stringify(report));
  if (report.failed) process.exitCode = 2;
} catch (error) {
  console.error(`Photo cleanup stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
