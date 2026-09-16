import { logger } from '../config/logger.js';

const FORBIDDEN_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'hash',
  'refreshToken',
  'refresh_token',
  'accessToken',
  'access_token',
  'token',
  'secret',
  'apiSecret',
  'api_secret',
  'webhookSecret',
  'webhook_secret',
  'providerSecret',
  'credentials',
  'authorization',
  'cookie',
  'cookies',
]);

function isForbiddenKey(key) {
  const lower = String(key).toLowerCase();
  if (FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(lower)) return true;
  // also block any key containing password, secret, token, credential, authorization, cookie
  const patterns = ['password', 'secret', 'credential', 'authorization', 'cookie', 'refresh_token', 'access_token'];
  for (const p of patterns) {
    if (lower.includes(p)) return true;
  }
  return false;
}

function sanitizePayload(payload) {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) {
    return payload.map(sanitizePayload);
  }
  if (typeof payload === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (isForbiddenKey(k)) continue;
      // Also block values that look like JWT (contains dots) for token-like keys? No, only key based.
      if (v !== null && typeof v === 'object') {
        out[k] = sanitizePayload(v);
      } else {
        // Truncate stack traces
        if (k === 'stack' || k === 'stackTrace' || k === 'stacktrace') continue;
        out[k] = v;
      }
    }
    return out;
  }
  return payload;
}

export const REALTIME_EVENTS = {
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  INVENTORY_LOW_STOCK: 'inventory.low_stock',
  PAYMENT_COMPLETED: 'payment.completed',
  NOTIFICATION_CREATED: 'notification.created',
};

const ALLOWED_EVENTS = new Set(Object.values(REALTIME_EVENTS));

let ioInstance = null;

export function setIoInstance(io) {
  ioInstance = io;
}

export function getIoInstance() {
  return ioInstance;
}

function getRoomNames(tenantId, userId) {
  const rooms = [];
  if (tenantId) rooms.push(`tenant:${tenantId}`);
  if (userId) rooms.push(`user:${userId}`);
  return rooms;
}

/**
 * Provider-independent realtime abstraction.
 * Business services call emitRealtime without coupling to socket.io internals.
 * Tenant isolation is enforced via room targeting.
 */
export function emitRealtime(event, payload, { tenantId, userId } = {}) {
  if (!ALLOWED_EVENTS.has(event)) {
    logger.warn({ event }, 'Attempted to emit unknown realtime event');
    return false;
  }
  if (!tenantId && !userId) {
    logger.warn({ event }, 'emitRealtime called without tenantId or userId - ignoring');
    return false;
  }
  const io = getIoInstance();
  if (!io) {
    // No socket server (e.g., tests without http server) - no-op but not error
    logger.debug({ event, tenantId, userId }, 'Realtime emit ignored - no io instance');
    return false;
  }

  const sanitized = sanitizePayload(payload);

  // Add minimal envelope metadata
  const envelope = {
    event,
    data: sanitized,
    tenantId: tenantId || null,
    timestamp: new Date().toISOString(),
  };

  try {
    if (userId) {
      // User-specific event -> emit only to that user's room
      // Still tenant-bound: user room is unique per user, but we emit to that room
      // Tenant validation: userId room is derived server-side, safe
      io.to(`user:${userId}`).emit(event, envelope);
    } else if (tenantId) {
      io.to(`tenant:${tenantId}`).emit(event, envelope);
    }
    logger.debug({ event, tenantId, userId }, 'Realtime event emitted');
    return true;
  } catch (err) {
    logger.error({ err, event }, 'Failed to emit realtime event');
    return false;
  }
}

// Convenience helpers for domain events
export function emitOrderCreated(tenantId, orderPayload) {
  return emitRealtime(REALTIME_EVENTS.ORDER_CREATED, orderPayload, { tenantId });
}

export function emitOrderUpdated(tenantId, orderPayload) {
  return emitRealtime(REALTIME_EVENTS.ORDER_UPDATED, orderPayload, { tenantId });
}

export function emitInventoryLowStock(tenantId, payload) {
  return emitRealtime(REALTIME_EVENTS.INVENTORY_LOW_STOCK, payload, { tenantId });
}

export function emitPaymentCompleted(tenantId, payload) {
  return emitRealtime(REALTIME_EVENTS.PAYMENT_COMPLETED, payload, { tenantId });
}

export function emitNotificationCreated(tenantId, userId, payload) {
  if (userId) {
    return emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, payload, { tenantId, userId });
  }
  return emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, payload, { tenantId });
}

export function sanitizeForTest(payload) {
  return sanitizePayload(payload);
}

export { getRoomNames, ALLOWED_EVENTS };
