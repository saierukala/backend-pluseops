import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

// Phase 35: encryption at rest for secrets the API must read back (a shop's Razorpay key secret), unlike passwords,
// which are hashed. AES-256-GCM, so a tampered value fails to decrypt instead of decrypting to garbage.
// Stored form: v1:<iv>:<auth tag>:<ciphertext>, each base64.

const VERSION = 'v1';

function key() {
  if (env.CREDENTIALS_ENCRYPTION_KEY) return crypto.createHash('sha256').update(env.CREDENTIALS_ENCRYPTION_KEY).digest();
  if (env.NODE_ENV === 'production') {
    throw new AppError('Storing credentials is not available: CREDENTIALS_ENCRYPTION_KEY is not configured', { statusCode: 503, code: 'CREDENTIALS_ENCRYPTION_NOT_CONFIGURED' });
  }
  const base = env.JWT_ACCESS_SECRET || 'test-credentials-key-min-32-chars-long-for-testing';
  return crypto.createHmac('sha256', base).update('pulseops:credentials-encryption').digest();
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Returns null when the value can't be read (other key, tampered), so callers treat it as "not configured". */
export function decryptSecret(stored) {
  if (!stored) return null;
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof AppError) throw err;
    return null;
  }
}
