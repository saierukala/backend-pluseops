import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';

// Phase 35: the only code that talks to Razorpay. Plain HTTPS with Basic auth (key id : key secret), no SDK.
// Every call takes the shop's own credentials; there is no platform-wide Razorpay account.
// Docs: https://razorpay.com/docs/api/orders/ · https://razorpay.com/docs/api/refunds/ · https://razorpay.com/docs/webhooks/

export const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;
export const modeOf = (keyId) => (keyId?.startsWith('rzp_live_') ? 'live' : 'test');

// Razorpay wants amounts in the currency's smallest unit; most currencies have 2 decimals.
const MINOR_UNIT_DIGITS = { JPY: 0, KRW: 0, VND: 0, CLP: 0, PYG: 0, UGX: 0, ISK: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export function toMinorUnits(amount, currency) {
  const digits = MINOR_UNIT_DIGITS[String(currency).toUpperCase()] ?? 2;
  // Amounts are Decimal(12,2); rounding absorbs float error (12.34 * 100 = 1233.9999…)
  return Math.round(Number(amount) * 10 ** digits);
}

const unavailable = (status) => new AppError('Online payment is not available right now. Please try again shortly.', {
  statusCode: 502, code: 'PAYMENT_PROVIDER_ERROR', details: status ? { providerStatus: status } : undefined,
});

async function call(credentials, method, path, body) {
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${env.RAZORPAY_API_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(env.RAZORPAY_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ err: err?.message, path }, 'Razorpay unreachable');
    throw unavailable();
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Razorpay's error description never contains the secret; log it for the shop owner's support case
    logger.warn({ status: res.status, path, error: payload?.error?.description, code: payload?.error?.code }, 'Razorpay request failed');
    if (res.status === 401) {
      throw new AppError('The shop\'s Razorpay keys were rejected by Razorpay', { statusCode: 502, code: 'PAYMENT_PROVIDER_AUTH_FAILED' });
    }
    if (res.status === 400) {
      throw new AppError(payload?.error?.description || 'Razorpay rejected the request', { statusCode: 422, code: 'PAYMENT_PROVIDER_REJECTED' });
    }
    throw unavailable(res.status);
  }
  return payload;
}

/** true/false for "do these keys work"; throws only when Razorpay can't be reached. */
export async function credentialsValid(credentials) {
  try {
    await call(credentials, 'GET', '/orders?count=1');
    return true;
  } catch (err) {
    if (err.code === 'PAYMENT_PROVIDER_AUTH_FAILED') return false;
    throw err;
  }
}

// An order fixes the amount on Razorpay's side before the shopper sees the payment window, so the browser can't
// change what is charged. payment_capture: captured automatically, no manual capture step for the shop.
export function createOrder(credentials, { amountMinor, currency, receipt, notes }) {
  return call(credentials, 'POST', '/orders', { amount: amountMinor, currency, receipt: String(receipt).slice(0, 40), notes, payment_capture: 1 });
}

export function refundPayment(credentials, razorpayPaymentId, { amountMinor, notes }) {
  return call(credentials, 'POST', `/payments/${encodeURIComponent(razorpayPaymentId)}/refund`, { amount: amountMinor, notes, speed: 'normal' });
}

// HMAC-SHA256 hex compared in constant time
function signatureMatches(payload, secret, signature) {
  if (!secret || typeof signature !== 'string') return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// After the payment window closes, Razorpay hands the browser order id + payment id + a signature made with the
// shop's key secret. Only the server can check it, so a forged "it's paid" from the browser is rejected.
export const checkoutSignatureValid = (keySecret, orderId, paymentId, signature) =>
  signatureMatches(`${orderId}|${paymentId}`, keySecret, signature);

// Webhooks are signed over the exact raw body with the webhook secret (set in the Razorpay dashboard), not the key secret.
export const webhookSignatureValid = (webhookSecret, rawBody, signature) => signatureMatches(rawBody, webhookSecret, signature);

export const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
