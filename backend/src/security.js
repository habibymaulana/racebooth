import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
const scrypt = promisify(scryptCallback);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(32).toString('hex');
  const key = await scrypt(password, salt, 64, options);
  return `scrypt$32768$8$1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  if (/^\$2[aby]\$(1[0-9]|2[0-0])\$/.test(encoded)) return bcrypt.compare(password, encoded);
  const [name, n, r, p, salt, hash, extra] = encoded.split('$');
  if (name !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !/^[a-f0-9]{64}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hash || '') || extra) return false;
  const key = await scrypt(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}

export const tokenHash = token => createHash('sha256').update(token).digest('hex');

export function encryptToken(token, key, transactionId) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

export function decryptToken(value, key, transactionId) {
  const [nonce, tag, encrypted] = value.split('.').map(s => Buffer.from(s, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(transactionId)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

export function signPayload(payload, secret) {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac('sha256', secret).update(content).digest('hex');
}

export function verifySignature(payload, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = signPayload(payload, secret);
  return timingSafeEqual(Buffer.from(signature.toLowerCase(), 'hex'), Buffer.from(expected.toLowerCase(), 'hex'));
}
