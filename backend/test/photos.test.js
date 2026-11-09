import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { drawCameraFrame } from '../../shared/camera-capture.js';
import {
  normalizeImage, validateImageBuffer, getStorageRoot, resolveStoragePath,
  savePhotoFile, readStoredFile, openStoredFile,
} from '../src/storage.js';

async function image({ width = 120, height = 80, format = 'png', color = { r: 210, g: 100, b: 30 } } = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer();
}

test('photo input decodes JPEG, PNG, and WebP into bounded metadata-free JPEG files', async () => {
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = await image({ format });
    const result = await normalizeImage(bytes, `image/${format}`, 'original');
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(result.width, 120); assert.equal(result.height, 80);
    const metadata = await sharp(result.buffer).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
    assert.equal(result.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), true);
  }
});

test('EXIF orientation is normalized before storage without flipping an ordinary camera frame', async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="60" height="80" fill="#f00"/><rect x="60" width="60" height="80" fill="#00f"/></svg>');
  const normal = await sharp(source).jpeg().toBuffer();
  const saved = await normalizeImage(normal, 'image/jpeg');
  const left = await sharp(saved.buffer).extract({ left: 20, top: 40, width: 1, height: 1 }).raw().toBuffer();
  const right = await sharp(saved.buffer).extract({ left: 100, top: 40, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(left[0] > left[2] && right[2] > right[0]);
  const rotated = await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const normalized = await normalizeImage(rotated, 'image/jpeg');
  assert.equal(normalized.width, 80); assert.equal(normalized.height, 120);
  assert.equal((await sharp(normalized.buffer).metadata()).orientation, undefined);
});

test('camera canvas capture applies the selected selfie mirror exactly once', () => {
  const callsFor = mirrorHorizontal => {
    const calls = [];
    const context = {
      setTransform: (...args) => calls.push(['setTransform', ...args]),
      translate: (...args) => calls.push(['translate', ...args]),
      scale: (...args) => calls.push(['scale', ...args]),
      drawImage: (...args) => calls.push(['drawImage', ...args]),
    };
    drawCameraFrame(context, { videoWidth: 1280, videoHeight: 720 }, 1280, 720, { mirrorHorizontal });
    return calls;
  };
  const video = { videoWidth: 1280, videoHeight: 720 };
  assert.deepEqual(callsFor(false), [
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['drawImage', video, 0, 0, 1280, 720],
  ]);
  assert.deepEqual(callsFor(true), [
    ['setTransform', 1, 0, 0, 1, 0, 0],
    ['translate', 1280, 0],
    ['scale', -1, 1],
    ['drawImage', { videoWidth: 1280, videoHeight: 720 }, 0, 0, 1280, 720],
  ]);
});

test('spoofed signatures, invalid data, unsupported MIME, and excessive images are rejected', async () => {
  const validPng = await image();
  for (const invalid of [
    Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(100)]),
    Buffer.from('RIFF0000NOTWnot-a-webp-image'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.alloc(100)]),
  ]) await assert.rejects(normalizeImage(invalid));
  await assert.rejects(normalizeImage(validPng, 'text/plain'));
  await assert.rejects(normalizeImage(validPng, 'image/jpeg'));
  assert.throws(() => validateImageBuffer(Buffer.alloc(12 * 1024 * 1024 + 1)));
  const oversizedPixels = await image({ width: 6000, height: 5000 });
  await assert.rejects(normalizeImage(oversizedPixels, 'image/png'));
});

test('accepted filters change actual pixels and black-and-white is achromatic', async () => {
  const original = await image();
  const baseline = await normalizeImage(original, 'image/png', 'original');
  const grayscale = await normalizeImage(original, 'image/png', 'bw');
  const { data, info } = await sharp(grayscale.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const values = [...data.subarray(0, info.channels)];
  assert.ok(Math.max(...values) - Math.min(...values) <= 3, 'black-and-white must affect image pixels');
  assert.notDeepEqual(grayscale.buffer, baseline.buffer);
  for (const filter of [
    'vintage', 'warm', 'cool', 'sepia', 'contrast', 'glow',
    'pencil-sketch', 'comic-pop', 'doodle-art', 'retro-print', 'dreamy-illustration', 'magazine-cutout'
  ]) {
    const result = await normalizeImage(original, 'image/png', filter);
    assert.notDeepEqual(result.buffer, baseline.buffer, `${filter} must alter image pixels`);
    assert.equal((await sharp(result.buffer).metadata()).format, 'jpeg');
  }
  await assert.rejects(normalizeImage(original, 'image/png', 'arbitrary-filter'));
});

test('artistic styles produce distinct pixel treatments from a detailed asymmetric original', async () => {
  const width = 160, height = 100;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    data[i] = (x * 2 + y) % 256; data[i + 1] = (y * 3 + (x > 70 ? 90 : 0)) % 256; data[i + 2] = (x + y * 2) % 256;
  }
  const source = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const filters = ['original', 'pencil-sketch', 'comic-pop', 'doodle-art', 'retro-print', 'dreamy-illustration', 'magazine-cutout'];
  const results = [];
  for (const name of filters) {
    const output = await normalizeImage(source, 'image/png', name);
    assert.equal(output.width, width); assert.equal(output.height, height);
    results.push(await sharp(output.buffer).removeAlpha().raw().toBuffer());
  }
  for (let i = 1; i < results.length; i++) {
    for (let j = 0; j < i; j++) {
      let difference = 0;
      for (let k = 0; k < results[i].length; k++) difference += Math.abs(results[i][k] - results[j][k]);
      assert.ok(difference / results[i].length > 5, `${filters[i]} must visibly differ from ${filters[j]}`);
    }
  }
});

test('private storage uses bounded relative paths, complete immutable files, and real downloadable bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumi-storage-unit-'));
  const previousRoot = process.env.PHOTO_STORAGE_PATH;
  process.env.PHOTO_STORAGE_PATH = root;
  try {
    assert.equal(getStorageRoot(), root);
    for (const path of ['../outside.jpg', '../../etc/passwd', '/etc/passwd', '', '.', 'sessions/../../outside.jpg']) {
      assert.throws(() => resolveStoragePath(path), `reject unsafe storage path ${path}`);
    }
    const buffer = (await normalizeImage(await image(), 'image/png')).buffer;
    const stored = await savePhotoFile(randomUUID(), 1, buffer);
    assert.equal(stored.storagePath.startsWith('/'), false);
    assert.equal(stored.fileSizeBytes, buffer.length);
    assert.deepEqual(await readFile(resolveStoragePath(stored.storagePath)), buffer);
    assert.deepEqual(await readStoredFile(stored.storagePath), buffer);
    const download = await openStoredFile(stored.storagePath);
    assert.equal(download.mimeType, 'image/jpeg'); assert.equal(download.size, buffer.length);
    const chunks = []; for await (const chunk of download.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), buffer);
    await assert.rejects(savePhotoFile('../escape', 1, buffer));
    await assert.rejects(savePhotoFile(randomUUID(), 0, buffer));
    const outside = join(root, '..', `${randomUUID()}.jpg`);
    const link = join(root, 'private-link.jpg');
    await symlink(outside, link);
    await assert.rejects(readStoredFile('private-link.jpg'));
  } finally {
    if (previousRoot === undefined) delete process.env.PHOTO_STORAGE_PATH;
    else process.env.PHOTO_STORAGE_PATH = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
