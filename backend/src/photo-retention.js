import { deleteStoredFile } from './storage.js';

const MAX_BATCH_SIZE = 500;

function validateOptions({ galleryTtlHours, batchSize }) {
  if (!Number.isInteger(galleryTtlHours) || galleryTtlHours < 1 || galleryTtlHours > 168) {
    throw new TypeError('galleryTtlHours must be an integer from 1 to 168.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new TypeError(`batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
  }
}

/**
 * Remove at most one bounded batch of photo assets whose gallery access has expired.
 * Session, account, payment, and email-delivery records are deliberately retained.
 * The default is a report-only pass; applying changes must be explicit.
 */
export async function cleanExpiredPhotoAssets(db, {
  galleryTtlHours = 24,
  batchSize = 100,
  apply = false,
  removeFile = deleteStoredFile,
} = {}) {
  validateOptions({ galleryTtlHours, batchSize });
  if (!db || typeof db.query !== 'function') throw new TypeError('A PostgreSQL-compatible query interface is required.');

  const result = await db.query(`
    SELECT kind, asset_id, storage_path
    FROM (
      SELECT 'photo'::text AS kind, p.id AS asset_id, p.storage_path,
        s.token_expires_at + make_interval(hours => $1::integer) AS gallery_expires_at
      FROM session_photos p JOIN photobooth_sessions s ON s.id = p.session_id
      UNION ALL
      SELECT 'photostrip'::text AS kind, p.id AS asset_id, p.storage_path,
        s.token_expires_at + make_interval(hours => $1::integer) AS gallery_expires_at
      FROM session_photostrips p JOIN photobooth_sessions s ON s.id = p.session_id
    ) expired_assets
    WHERE gallery_expires_at <= NOW()
    ORDER BY gallery_expires_at ASC, asset_id ASC
    LIMIT $2::integer
  `, [galleryTtlHours, batchSize + 1]);

  const candidates = result.rows.slice(0, batchSize);
  const report = { dryRun: !apply, scanned: candidates.length, deletedFiles: 0, deletedRecords: 0, failed: 0, hasMore: result.rows.length > batchSize };
  if (!apply) return report;

  for (const candidate of candidates) {
    try {
      if (candidate.storage_path && await removeFile(candidate.storage_path)) report.deletedFiles += 1;
      let deleted;
      if (candidate.kind === 'photo') {
        deleted = await db.query(`
          DELETE FROM session_photos p USING photobooth_sessions s
          WHERE p.id=$1 AND p.storage_path IS NOT DISTINCT FROM $2 AND s.id=p.session_id
            AND s.token_expires_at + make_interval(hours => $3::integer) <= NOW()
        `, [candidate.asset_id, candidate.storage_path, galleryTtlHours]);
      } else if (candidate.kind === 'photostrip') {
        deleted = await db.query(`
          DELETE FROM session_photostrips p USING photobooth_sessions s
          WHERE p.id=$1 AND p.storage_path IS NOT DISTINCT FROM $2 AND s.id=p.session_id
            AND s.token_expires_at + make_interval(hours => $3::integer) <= NOW()
        `, [candidate.asset_id, candidate.storage_path, galleryTtlHours]);
      } else {
        throw new Error('Unexpected stored asset type.');
      }
      if (deleted.rowCount) {
        report.deletedRecords += deleted.rowCount;
      }
    } catch {
      // Keep the asset row when object storage fails so a later run can retry safely.
      report.failed += 1;
    }
  }
  return report;
}

export const PHOTO_CLEANUP_MAX_BATCH_SIZE = MAX_BATCH_SIZE;
