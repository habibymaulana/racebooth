import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fail } from './errors.js';
import { renderArtFilter } from './art-filters.js';
import { parseR2Config } from './r2-config.js';

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24 * 1000 * 1000;
export const PHOTO_FILTERS = new Set([
  'original', 'bw', 'vintage', 'warm', 'cool', 'sepia', 'contrast', 'glow',
  'pencil-sketch', 'comic-pop', 'doodle-art', 'retro-print', 'dreamy-illustration', 'magazine-cutout'
]);
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultRoot = fileURLToPath(new URL('../../storage/', import.meta.url));
let r2ResourcesPromise;

// Module-relative local default; Docker supplies its persistent private volume path.
export function getStorageRoot() { return resolve(process.env.PHOTO_STORAGE_PATH || defaultRoot); }
export function getStorageDriver() { return process.env.PHOTO_STORAGE_DRIVER || 'local'; }

export function validateStorageKey(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath || storagePath.includes('\0') || storagePath.includes('\\') || storagePath.startsWith('/')) {
    fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
  }
  const segments = storagePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
  return storagePath;
}

async function getR2Resources() {
  if (!r2ResourcesPromise) {
    r2ResourcesPromise = (async () => {
      const config = parseR2Config(process.env);
      const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials: config.credentials, maxAttempts: 3 });
      return { client, bucket: config.bucket, GetObjectCommand, PutObjectCommand, DeleteObjectCommand };
    })().catch(error => {
      r2ResourcesPromise = undefined;
      if (error.message === 'Cloudflare R2 storage configuration is incomplete or invalid.') throw error;
      throw new Error('Cloudflare R2 storage could not be initialized.');
    });
  }
  return r2ResourcesPromise;
}

export function validateImageBuffer(buffer, claimedMime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) fail(400, 'IMAGE_INVALID', 'The image is empty or incomplete.');
  if (buffer.length > MAX_UPLOAD_BYTES) fail(413, 'IMAGE_TOO_LARGE', 'Each photo must be 12 MB or smaller.');
  let detected;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) detected = 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') detected = 'image/webp';
  if (!detected) fail(415, 'IMAGE_UNSUPPORTED', 'Upload a real JPEG, PNG, or WebP image.');
  if (claimedMime && (!allowedTypes.has(claimedMime) || claimedMime !== detected)) fail(415, 'IMAGE_MIME_MISMATCH', 'The image content does not match its declared type.');
  return detected;
}

// Decode and re-encode instead of trusting an extension or signature bytes.
export async function normalizeImage(buffer, claimedMime, filter = 'original') {
  validateImageBuffer(buffer, claimedMime);
  if (!PHOTO_FILTERS.has(filter)) fail(400, 'FILTER_INVALID', 'Choose a supported photo filter.');
  try {
    const source = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning', sequentialRead: true, animated: false });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1 || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      fail(400, 'IMAGE_INVALID', 'Upload a single image of 24 megapixels or less.');
    }
    let image = source.rotate().resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).toColourspace('srgb');
    switch (filter) {
      case 'bw': image = image.grayscale(); break;
      case 'vintage': image = image.modulate({ saturation: 0.65, brightness: 1.04 }).recomb([[1.06, 0.03, 0], [0, 1, 0], [0, 0, 0.84]]); break;
      case 'warm': image = image.recomb([[1.09, 0, 0], [0, 1.02, 0], [0, 0, 0.88]]); break;
      case 'cool': image = image.recomb([[0.9, 0, 0], [0, 1.01, 0], [0, 0, 1.12]]); break;
      case 'sepia': image = image.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]); break;
      case 'contrast': image = image.linear(1.2, -25.5); break;
      case 'glow': image = image.modulate({ brightness: 1.13, saturation: 0.9 }).blur(0.3); break;
      case 'pencil-sketch':
      case 'comic-pop': case 'doodle-art': case 'retro-print':
      case 'dreamy-illustration': case 'magazine-cutout': {
        image = await renderArtFilter(await image.png().toBuffer(), filter);
        break;
      }
    }
    const result = await image.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
    if (result.data.length > MAX_UPLOAD_BYTES) fail(413, 'IMAGE_TOO_LARGE', 'The decoded image is too large to store.');
    return { buffer: result.data, width: result.info.width, height: result.info.height, mimeType: 'image/jpeg' };
  } catch (error) {
    if (error.status) throw error;
    fail(400, 'IMAGE_INVALID', 'The image could not be decoded. Upload a complete image of 24 megapixels or less.');
  }
}

export function resolveStoragePath(storagePath) {
  validateStorageKey(storagePath);
  if (isAbsolute(storagePath) || /^[a-z]:/i.test(storagePath)) fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
  const root = getStorageRoot(); const absolute = resolve(root, storagePath); const inside = relative(root, absolute);
  if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
  return absolute;
}

async function writeImmutableImage(sessionId, prefix, buffer) {
  if (!uuidPattern.test(sessionId)) fail(400, 'SESSION_INVALID', 'Invalid session identifier.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) fail(400, 'IMAGE_INVALID', 'Invalid stored image.');
  const relativeDirectory = `sessions/${sessionId.toLowerCase()}`;
  const name = `${prefix}-${randomUUID()}.jpg`;
  const storagePath = `${relativeDirectory}/${name}`;
  if (getStorageDriver() === 'r2') {
    const { client, bucket, PutObjectCommand } = await getR2Resources();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: validateStorageKey(storagePath), Body: buffer,
      ContentLength: buffer.length, ContentType: 'image/jpeg', CacheControl: 'private, no-store' }));
    return { storagePath, fileSizeBytes: buffer.length };
  }
  const directory = resolveStoragePath(relativeDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(getStorageRoot()); const actualDirectory = await realpath(directory);
  if (!actualDirectory.startsWith(actualRoot + '/')) fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
  const temporary = join(directory, `.${name}.part`); const destination = join(directory, name);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(buffer); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, destination);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { storagePath, fileSizeBytes: buffer.length };
  } catch (error) {
    await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
  }
}

export async function savePhotoFile(sessionId, sequence, buffer) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 1000) fail(400, 'SEQUENCE_INVALID', 'Invalid photo sequence.');
  return writeImmutableImage(sessionId, `photo-${String(sequence).padStart(3, '0')}`, buffer);
}
export async function saveStripFile(sessionId, buffer) { return writeImmutableImage(sessionId, 'photostrip', buffer); }

async function openPrivateFile(storagePath) {
  const absolute = resolveStoragePath(storagePath); let handle;
  try {
    const root = await realpath(getStorageRoot()); const actualDirectory = await realpath(dirname(absolute));
    if (!actualDirectory.startsWith(root + '/')) fail(400, 'STORAGE_PATH_INVALID', 'Invalid stored image path.');
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPLOAD_BYTES) fail(404, 'PHOTO_FILE_UNAVAILABLE', 'The stored image is unavailable.');
    return { handle, size: stat.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.status) throw error;
    fail(404, 'PHOTO_FILE_UNAVAILABLE', 'The stored image is unavailable.');
  }
}

function mapR2ReadError(error) {
  if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound') {
    fail(404, 'PHOTO_FILE_UNAVAILABLE', 'The stored image is unavailable.');
  }
  fail(503, 'PHOTO_STORAGE_UNAVAILABLE', 'Private photo storage is temporarily unavailable.');
}

export async function readStoredFile(storagePath) {
  if (getStorageDriver() === 'r2') {
    const { client, bucket, GetObjectCommand } = await getR2Resources();
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: validateStorageKey(storagePath) }));
      const size = Number(result.ContentLength);
      if (!result.Body || !Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
        result.Body?.destroy?.(); fail(404, 'PHOTO_FILE_UNAVAILABLE', 'The stored image is unavailable.');
      }
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error.status) throw error;
      mapR2ReadError(error);
    }
  }
  const { handle } = await openPrivateFile(storagePath);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
export async function openStoredFile(storagePath) {
  if (getStorageDriver() === 'r2') {
    const { client, bucket, GetObjectCommand } = await getR2Resources();
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: validateStorageKey(storagePath) }));
      const size = Number(result.ContentLength);
      if (!result.Body || !Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
        result.Body?.destroy?.(); fail(404, 'PHOTO_FILE_UNAVAILABLE', 'The stored image is unavailable.');
      }
      return { stream: result.Body, size, mimeType: 'image/jpeg', filename: 'racebooth-photo.jpg' };
    } catch (error) {
      if (error.status) throw error;
      mapR2ReadError(error);
    }
  }
  const { handle, size } = await openPrivateFile(storagePath);
  return { stream: handle.createReadStream({ autoClose: true }), size, mimeType: 'image/jpeg', filename: 'racebooth-photo.jpg' };
}
export async function deleteStoredFile(storagePath) {
  if (getStorageDriver() === 'r2') {
    const { client, bucket, DeleteObjectCommand } = await getR2Resources();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: validateStorageKey(storagePath) }));
    return true;
  }
  try { await unlink(resolveStoragePath(storagePath)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function removeUncommittedFile(storagePath) { await deleteStoredFile(storagePath).catch(() => {}); }
// Compatibility with migration 04 only; HTTP routes do not expose raw download tokens.
export function generateDownloadToken() { return randomBytes(32).toString('base64url'); }
