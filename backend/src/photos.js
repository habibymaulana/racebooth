import { createHash, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { fail } from './errors.js';
import { FRAME_LAYOUT, FRAME_DESIGNS, renderFrameSvg } from '../../shared/frame-designs.js';
import { normalizeImage, savePhotoFile, saveStripFile, readStoredFile, openStoredFile, createPrivateBlobReadUrl, getStorageDriver, removeUncommittedFile, PHOTO_FILTERS } from './storage.js';

const digest = value => createHash('sha256').update(value).digest();

const backgrounds = {
  // Legacy solid-color backgrounds (preserved)
  white: '#fffdf8', black: '#191f1d', pink: '#f5dce4', yellow: '#f8edb9', mint: '#d9eadf', lavender: '#e6dff3',
  // racebooth. original frame designs
  blueberry: '#bcd4f0', 'pink-diary': '#fce4ec', 'retro-bloom': '#d4e8df',
  'midnight-film': '#1a2240', 'sunny-picnic': '#fdf3c7', 'sweet-memories': '#e8def0',
  'doodle-booth': '#e8dfce', 'retro-checker': '#fbf7ee', 'denim-memories': '#354e6e',
  'polka-party': '#fffdf8', 'heart-collage': '#fae4eb', 'vintage-film': '#22201e'
};

// Frame design aesthetics for photostrip composition
const frameStyles = {
  blueberry:       { fg: '#2d4f7a', accent: '#7ba7d4', tag: 'Blueberry Scrapbook' },
  'pink-diary':    { fg: '#7a2d5a', accent: '#e8a0bf', tag: 'Pink Diary' },
  'retro-bloom':   { fg: '#2d5a3d', accent: '#6aaa8f', tag: 'Retro Bloom' },
  'midnight-film': { fg: '#c8d4f0', accent: '#7b8ece', tag: 'Midnight Film' },
  'sunny-picnic':  { fg: '#7a5f0a', accent: '#e8c84a', tag: 'Sunny Picnic' },
  'sweet-memories':{ fg: '#5a3d7a', accent: '#a890c8', tag: 'Sweet Memories' },
  'doodle-booth':  { fg: '#241f1c', accent: '#8c765c', tag: 'Doodle Booth' },
  'retro-checker': { fg: '#8a2420', accent: '#d33f39', tag: 'Retro Checker' },
  'denim-memories':{ fg: '#e5eef9', accent: '#89aed4', tag: 'Denim Memories' },
  'polka-party':   { fg: '#262220', accent: '#e76f51', tag: 'Polka Party' },
  'heart-collage': { fg: '#6b203c', accent: '#d85f85', tag: 'Heart Collage' },
  'vintage-film':  { fg: '#f0e6d6', accent: '#c49a6c', tag: 'Vintage Film' },
  // Legacy
  white:   { fg: '#254339', accent: '#71b3a4', tag: 'Classic' },
  black:   { fg: '#f8f5ed', accent: '#a0c0b0', tag: 'Midnight' },
  pink:    { fg: '#5a2d3d', accent: '#c86080', tag: 'Blush' },
  yellow:  { fg: '#5a4a0a', accent: '#c8a830', tag: 'Sunshine' },
  mint:    { fg: '#1a4030', accent: '#4a9070', tag: 'Mint' },
  lavender:{ fg: '#3d2d5a', accent: '#8070b0', tag: 'Lavender' },
};

function matchesCapability(supplied, session) {
  if (typeof supplied !== 'string' || supplied.length < 16 || supplied.length > 256) return false;
  const suppliedHash = digest(supplied);
  const checkoutMatches = typeof session.checkout_key === 'string' && timingSafeEqual(suppliedHash, digest(session.checkout_key));
  const tokenMatches = typeof session.access_token_hash === 'string' && /^[a-f0-9]{64}$/i.test(session.access_token_hash) && timingSafeEqual(suppliedHash, Buffer.from(session.access_token_hash, 'hex'));
  return checkoutMatches || tokenMatches;
}

function authorizeSession(session, credential, options = {}) {
  if (!session) fail(404, 'SESSION_NOT_FOUND', 'Photobooth session not found.');
  if (!matchesCapability(credential, session)) fail(403, 'SESSION_ACCESS_DENIED', 'Invalid access credentials for this session.');
  if (session.payment_status !== 'paid' || !session.paid_at || session.cancelled_at || session.refunded_at || session.status === 'cancelled') fail(403, 'SESSION_REVOKED', 'This session is no longer authorized.');
  const captureExpiresAt = new Date(session.token_expires_at).getTime();
  if (!Number.isFinite(captureExpiresAt)) fail(410, 'SESSION_EXPIRED', 'This session has expired.');
  const ttl = options.galleryTtlHours ?? 24;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 168) throw new Error('Invalid gallery retention configuration');
  if (Date.now() >= captureExpiresAt + ttl * 3600000) fail(410, 'GALLERY_EXPIRED', 'This gallery link has expired.');
  if (options.capture) {
    if (Date.now() >= captureExpiresAt) fail(410, 'SESSION_EXPIRED', 'This capture session has expired. Your saved photos remain in the gallery for a limited time.');
    if (!['pending', 'active'].includes(session.status)) fail(409, 'SESSION_NOT_ACTIVE', 'This session is no longer accepting photos.');
  }
  return session;
}

export async function verifySessionAccess(db, sessionId, credential, options = {}) {
  const result = await db.query(`SELECT s.id,s.status,s.photo_limit,s.photos_taken,s.token_expires_at,s.access_token_hash,
    s.created_at,p.name AS package_name,p.session_duration_minutes,t.payment_status,t.paid_at,t.cancelled_at,t.refunded_at,pcs.checkout_key,
    fs.id AS free_session_id,pcs.flow_type,COALESCE(fs.frame_design,pcs.frame_design) AS frame_design,
    (fs.id IS NOT NULL OR pcs.flow_type='visitor') AS public_booth_flow
    FROM photobooth_sessions s JOIN payment_transactions t ON t.id=s.transaction_id
    JOIN photo_packages p ON p.id=s.package_id
    LEFT JOIN public_checkout_sessions pcs ON pcs.transaction_id=t.id
    LEFT JOIN free_photobooth_sessions fs ON fs.session_id=s.id WHERE s.id=$1 ${options.lock ? 'FOR UPDATE OF s,t' : ''}`, [sessionId]);
  return authorizeSession(result.rows[0], credential, options);
}

const publicPhoto = row => ({ id: row.id, sequence: row.sequence, filter: row.filter, status: row.status,
  file_size_bytes: row.file_size_bytes, width_px: row.width_px, height_px: row.height_px, created_at: row.created_at });
const publicStrip = row => row ? ({ id: row.id, status: row.status, background: row.background,
  selected_filter: row.selected_filter || 'original', is_finalized: row.is_finalized !== false,
  edit_revision: Number(row.edit_revision || 0), file_size_bytes: row.file_size_bytes, created_at: row.created_at }) : null;

async function withLockedSession(pool, sessionId, credential, options, callback) {
  const db = await pool.connect(); let commitAttempted = false; let newFile; let connectionError;
  try {
    await db.query('BEGIN');
    const session = await verifySessionAccess(db, sessionId, credential, { ...options, lock: true });
    const result = await callback(db, session, path => { newFile = path; });
    commitAttempted = true; await db.query('COMMIT'); return result;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch (rollbackError) { connectionError = rollbackError; }
    // A lost COMMIT acknowledgement is ambiguous: keep the private file so a
    // committed row never points at a deleted file. Orphans are never served.
    if (newFile && !commitAttempted) await removeUncommittedFile(newFile);
    throw error;
  } finally { db.release(connectionError); }
}

export async function uploadPhoto(pool, sessionId, body, buffer, options = {}) {
  const { sequence, checkoutKey, filter = 'original' } = body;
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 1000) fail(400, 'SEQUENCE_INVALID', 'Invalid photo sequence.');
  if (!PHOTO_FILTERS.has(filter)) fail(400, 'FILTER_INVALID', 'Choose a supported photo filter.');
  const access = await verifySessionAccess(pool, sessionId, checkoutKey, options);
  // Public booth captures remain immutable originals; visitors choose an edit
  // after confirming all four. Historical operator sessions keep old behavior.
  const effectiveFilter = access.public_booth_flow ? 'original' : filter;
  const image = await normalizeImage(buffer, options.claimedMime, effectiveFilter);
  const uploaded = await withLockedSession(pool, sessionId, checkoutKey, options, async (db, session, trackFile) => {
    if (sequence > session.photo_limit) fail(422, 'SEQUENCE_OUT_OF_RANGE', `This session allows ${session.photo_limit} accepted photos.`);
    const previous = await db.query('SELECT * FROM session_photos WHERE session_id=$1 AND sequence=$2', [sessionId, sequence]);
    const saved = previous.rows[0];
    if (saved?.status === 'saved') {
      const bytes = await readStoredFile(saved.storage_path);
      if (saved.filter !== effectiveFilter || !timingSafeEqual(digest(bytes), digest(image.buffer))) fail(409, 'PHOTO_SEQUENCE_CONFLICT', 'This photo slot is already saved. Retakes are only available before confirmation.');
      return { photo: publicPhoto(saved), replayed: true };
    }
    authorizeSession(session, checkoutKey, { ...options, capture: true });
    const count = await db.query("SELECT COUNT(*)::INT AS count FROM session_photos WHERE session_id=$1 AND status='saved'", [sessionId]);
    if (count.rows[0].count >= session.photo_limit) fail(409, 'PHOTO_QUOTA_EXCEEDED', 'The accepted photo limit has been reached.');
    const file = await savePhotoFile(sessionId, sequence, image.buffer); trackFile(file.storagePath);
    const result = await db.query(`INSERT INTO session_photos(session_id,sequence,filter,status,storage_path,file_size_bytes,width_px,height_px)
      VALUES($1,$2,$3,'saved',$4,$5,$6,$7)
      ON CONFLICT(session_id,sequence) DO UPDATE SET filter=EXCLUDED.filter,status='saved',storage_path=EXCLUDED.storage_path,
        file_size_bytes=EXCLUDED.file_size_bytes,width_px=EXCLUDED.width_px,height_px=EXCLUDED.height_px,download_token=NULL,updated_at=NOW()
      RETURNING *`, [sessionId, sequence, effectiveFilter, file.storagePath, file.fileSizeBytes, image.width, image.height]);
    if (Date.now() >= new Date(session.token_expires_at).getTime()) fail(410, 'SESSION_EXPIRED', 'The capture session expired before this photo was saved.');
    await db.query("UPDATE photobooth_sessions SET photos_taken=$2,status='active' WHERE id=$1", [sessionId, count.rows[0].count + 1]);
    return { photo: publicPhoto(result.rows[0]), replayed: false, sessionFrame: session.frame_design || null,
      freeSession: Boolean(session.free_session_id), publicBoothFlow: Boolean(session.public_booth_flow) };
  });
  // Composition is automatic for new public booth flows. A failure leaves
  // the four originals safely stored so the client can retry the preview.
  if (uploaded.publicBoothFlow && sequence === access.photo_limit && !uploaded.replayed) {
    try {
      const preview = await composePhotostrip(pool, sessionId, {
        checkoutKey, background: access.frame_design, filter: 'original', finalize: false, editRevision: 0,
      }, options);
      return { ...uploaded, autoComposed: true, strip: preview.strip };
    } catch {
      return { ...uploaded, autoComposed: false };
    }
  }
  return uploaded;
}

export async function getSessionPhotos(db, sessionId, credential, options = {}) {
  await verifySessionAccess(db, sessionId, credential, options);
  return (await db.query('SELECT * FROM session_photos WHERE session_id=$1 ORDER BY sequence', [sessionId])).rows.map(publicPhoto);
}
export async function getSessionGallery(db, sessionId, credential, options = {}) {
  const session = await verifySessionAccess(db, sessionId, credential, options);
  const photos = await db.query("SELECT * FROM session_photos WHERE session_id=$1 AND status='saved' ORDER BY sequence", [sessionId]);
  const strip = await db.query('SELECT * FROM session_photostrips WHERE session_id=$1', [sessionId]);
  return { session: { id: session.id, status: session.status, photo_limit: session.photo_limit, photos_taken: session.photos_taken,
    token_expires_at: session.token_expires_at, gallery_expires_at: new Date(new Date(session.token_expires_at).getTime() + (options.galleryTtlHours ?? 24) * 3600000).toISOString(), package_name: session.package_name,
    free_session_id: session.free_session_id || null, frame_design: session.frame_design || null },
    photos: photos.rows.map(publicPhoto), strip: publicStrip(strip.rows[0]) };
}
export async function getPhotoFile(db, sessionId, photoId, credential, options = {}) {
  const session = await verifySessionAccess(db, sessionId, credential, options);
  const result = await db.query("SELECT storage_path,sequence,file_size_bytes FROM session_photos WHERE id=$1 AND session_id=$2 AND status='saved'", [photoId, sessionId]);
  if (!result.rowCount) fail(404, 'PHOTO_NOT_FOUND', 'Photo not found in this session.');
  if (getStorageDriver() === 'vercel-blob') {
    // Keep binary downloads on the authenticated API response. The preview
    // path uses a short-lived private Blob URL so <img> needs no bearer token.
    if (options.download) return { ...await openStoredFile(result.rows[0].storage_path), filename: `racebooth-photo-${String(result.rows[0].sequence).padStart(2, '0')}.jpg` };
    const galleryExpiry = new Date(session.token_expires_at).getTime() + (options.galleryTtlHours ?? 24) * 3600000;
    const accessExpiresAt = Math.min(galleryExpiry, options.accessExpiresAt ?? Number.POSITIVE_INFINITY);
    const signed = await createPrivateBlobReadUrl(result.rows[0].storage_path, { accessExpiresAt });
    return { signedUrl: signed.url, expiresAt: signed.expiresAt, size: result.rows[0].file_size_bytes,
      mimeType: 'image/jpeg', filename: `racebooth-photo-${String(result.rows[0].sequence).padStart(2, '0')}.jpg` };
  }
  return { ...await openStoredFile(result.rows[0].storage_path), filename: `racebooth-photo-${String(result.rows[0].sequence).padStart(2, '0')}.jpg` };
}
export async function getStripFile(db, sessionId, credential, options = {}) {
  const session = await verifySessionAccess(db, sessionId, credential, options);
  const result = await db.query("SELECT storage_path,file_size_bytes FROM session_photostrips WHERE session_id=$1 AND status='composed'", [sessionId]);
  if (!result.rowCount) fail(404, 'STRIP_NOT_READY', 'The photostrip has not been composed yet.');
  if (getStorageDriver() === 'vercel-blob') {
    if (options.download) return { ...await openStoredFile(result.rows[0].storage_path), filename: 'racebooth-photostrip.jpg' };
    const galleryExpiry = new Date(session.token_expires_at).getTime() + (options.galleryTtlHours ?? 24) * 3600000;
    const accessExpiresAt = Math.min(galleryExpiry, options.accessExpiresAt ?? Number.POSITIVE_INFINITY);
    const signed = await createPrivateBlobReadUrl(result.rows[0].storage_path, { accessExpiresAt });
    return { signedUrl: signed.url, expiresAt: signed.expiresAt, size: result.rows[0].file_size_bytes,
      mimeType: 'image/jpeg', filename: 'racebooth-photostrip.jpg' };
  }
  return { ...await openStoredFile(result.rows[0].storage_path), filename: 'racebooth-photostrip.jpg' };
}

export async function composePhotostrip(pool, sessionId, body, options = {}) {
  const { checkoutKey, background: requestedBackground, filter = 'original', editRevision = 0 } = body;
  const finalize = body.finalize === undefined ? true : Boolean(body.finalize);
  if (!PHOTO_FILTERS.has(filter)) fail(400, 'FILTER_INVALID', 'Choose a supported photostrip filter.');
  return withLockedSession(pool, sessionId, checkoutKey, options, async (db, session, trackFile) => {
    const existing = (await db.query('SELECT * FROM session_photostrips WHERE session_id=$1', [sessionId])).rows[0];
    if (session.public_booth_flow && requestedBackground && requestedBackground !== session.frame_design) {
      fail(409, 'FRAME_LOCKED', 'This session frame was selected before capture and cannot be changed.');
    }
    const background = session.public_booth_flow
      ? session.frame_design
      : (requestedBackground || existing?.background || 'white');
    if (!Object.hasOwn(backgrounds, background)) fail(400, 'BACKGROUND_INVALID', 'Choose a supported photostrip background.');
    if (session.public_booth_flow && background !== session.frame_design) fail(409, 'FRAME_LOCKED', 'This session frame was selected before capture and cannot be changed.');
    if (existing?.status === 'composed') {
      if (existing.background !== background) {
        fail(409, session.public_booth_flow ? 'FRAME_LOCKED' : 'STRIP_ALREADY_COMPOSED', session.public_booth_flow
          ? 'This session frame was selected before capture and cannot be changed.'
          : 'This session already has a composed photostrip.');
      }
      if (existing.is_finalized && (existing.selected_filter || 'original') !== filter) fail(409, 'RESULT_LOCKED', 'This result has already been shared or finalized. Start a new session to choose another look.');
      const previousRevision = Number(existing.edit_revision || 0);
      const sameFilter = (existing.selected_filter || 'original') === filter;
      const stale = Number(editRevision) < previousRevision || (Number(editRevision) === previousRevision && !sameFilter);
      if (stale || (sameFilter && (!finalize || existing.is_finalized))) {
        await readStoredFile(existing.storage_path);
        if (!stale && !existing.is_finalized && Number(editRevision) > previousRevision) {
          const updated = await db.query('UPDATE session_photostrips SET edit_revision=$2,updated_at=NOW() WHERE session_id=$1 RETURNING *', [sessionId, editRevision]);
          return { strip: publicStrip(updated.rows[0]), replayed: true, stale: false };
        }
        return { strip: publicStrip(existing), replayed: true, stale };
      }
    }
    authorizeSession(session, checkoutKey, { ...options, capture: session.status !== 'completed' });
    const photos = (await db.query("SELECT * FROM session_photos WHERE session_id=$1 AND status='saved' ORDER BY sequence", [sessionId])).rows;
    if (photos.length !== session.photo_limit || photos.some((p, i) => p.sequence !== i + 1)) fail(422, 'PHOTOS_INCOMPLETE', `Confirm all ${session.photo_limit} photos before composing the photostrip.`);
    if (photos.length > 20) fail(422, 'STRIP_LIMIT_UNSUPPORTED', 'Photostrips support up to 20 photos. Individual photos remain available in the gallery.');
    const decorative = Object.hasOwn(FRAME_DESIGNS, background);
    const width = 720; const margin = decorative ? FRAME_LAYOUT.margin : 32;
    const photoWidth = decorative ? FRAME_LAYOUT.photoWidth : width - margin * 2;
    const photoHeight = decorative ? FRAME_LAYOUT.photoHeight : 438;
    const top = decorative ? FRAME_LAYOUT.top : margin;
    const gap = decorative ? FRAME_LAYOUT.gap : margin;
    const footer = decorative ? FRAME_LAYOUT.footer : 96;
    const height = top + photos.length * photoHeight + (photos.length - 1) * gap + footer + (decorative ? 0 : margin);
    const layers = [];
    if (decorative) layers.push({ input: Buffer.from(renderFrameSvg(background, photos.length)), left: 0, top: 0 });
    for (let i = 0; i < photos.length; i++) {
      const bytes = await readStoredFile(photos[i].storage_path);
      const filtered = await normalizeImage(bytes, 'image/jpeg', filter);
      // Fill each photo slot. The shared frame geometry matches the 16:9 camera
      // output, so camera captures need only a negligible subpixel crop; the
      // attention strategy keeps the focal point centered for other devices.
      const image = await sharp(filtered.buffer).resize(photoWidth, photoHeight, { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 94 }).toBuffer();
      layers.push({ input: image, left: margin, top: top + i * (photoHeight + gap) });
    }
    // Frame-aware footer: use racebooth branding with frame-specific colors
    const style = frameStyles[background] || frameStyles.white;
    const fg = style.fg;
    const accent = style.accent;
    const frameTag = style.tag;
    const label = Buffer.from(`<svg width="720" height="96" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="96" fill="${backgrounds[background]}"/>
      <text x="360" y="38" text-anchor="middle" font-family="'Nunito',sans-serif" font-size="28" font-weight="800" fill="${fg}">racebooth.</text>
      <text x="360" y="62" text-anchor="middle" font-family="sans-serif" font-size="11" letter-spacing="3" fill="${accent}">${frameTag.toUpperCase()}</text>
      <text x="360" y="82" text-anchor="middle" font-family="sans-serif" font-size="10" letter-spacing="2" fill="${fg}88">Capture the moment. Keep the memory.</text>
    </svg>`);
    if (!decorative) layers.push({ input: label, left: 0, top: height - footer });
    const composed = await sharp({ create: { width, height, channels: 3, background: backgrounds[background] } }).composite(layers).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
    const file = await saveStripFile(sessionId, composed); trackFile(file.storagePath);
    if (Date.now() >= new Date(session.token_expires_at).getTime()) fail(410, 'SESSION_EXPIRED', 'The capture session expired before the photostrip was saved.');
    const saved = await db.query(`INSERT INTO session_photostrips(session_id,status,background,selected_filter,is_finalized,edit_revision,storage_path,file_size_bytes)
      VALUES($1,'composed',$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id) DO UPDATE SET status='composed',background=EXCLUDED.background,
        selected_filter=EXCLUDED.selected_filter,is_finalized=EXCLUDED.is_finalized,edit_revision=EXCLUDED.edit_revision,
        storage_path=EXCLUDED.storage_path,file_size_bytes=EXCLUDED.file_size_bytes,download_token=NULL,updated_at=NOW() RETURNING *`,
      [sessionId, background, filter, Boolean(finalize), Number(editRevision), file.storagePath, file.fileSizeBytes]);
    await db.query("UPDATE photobooth_sessions SET status='completed',photos_taken=$2 WHERE id=$1", [sessionId, photos.length]);
    await db.query("UPDATE free_photobooth_sessions SET status='completed',frame_design=COALESCE($2,frame_design) WHERE session_id=$1", [sessionId, decorative ? background : null]);
    return { strip: publicStrip(saved.rows[0]), replayed: false };
  });
}

// Compatibility with the interrupted code; arbitrary client strip images are not accepted.
export const savePhotostrip = composePhotostrip;
