import crypto from 'node:crypto';
import { env } from '../../config/env.js';

export function computeSignature(payloadString, secret) {
  return crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
}

export function verifyWebhookSignature(rawBody, signature, secret = env.PAYMENT_WEBHOOK_SECRET) {
  if (!signature) return false;
  if (!secret) return false;
  // rawBody can be object or string; normalize to JSON string
  let payloadStr;
  if (typeof rawBody === 'string') payloadStr = rawBody;
  else if (Buffer.isBuffer(rawBody)) payloadStr = rawBody.toString('utf8');
  else payloadStr = JSON.stringify(rawBody);
  const expected = computeSignature(payloadStr, secret);
  // Also try alternative: if signature was computed over JSON.stringify with sorted keys? For mock we accept hex match with timing safe
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    // fallback simple string compare with timing safe if hex parse fails
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

export function getWebhookSecret() {
  return env.PAYMENT_WEBHOOK_SECRET;
}
