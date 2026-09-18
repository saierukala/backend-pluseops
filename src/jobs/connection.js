import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let bullMqRedis = null;
let bullMqConnectionErrorLogged = false;
let bullMqErrorResetTimer = null;

/**
 * BullMQ requires maxRetriesPerRequest: null and enableReadyCheck: false.
 * We keep a dedicated ioredis instance separate from the Phase 14 cache client
 * so cache settings (maxRetriesPerRequest:1) are preserved.
 * Reuses REDIS_URL from env.
 */
export function getBullMqRedisConnection() {
  if (!env.REDIS_URL) return null;
  if (bullMqRedis) return bullMqRedis;
  bullMqRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // BullMQ manages its own connection lifecycle; lazyConnect false aligns with worker expectations
    lazyConnect: false,
    connectTimeout: 5000,
  });
  bullMqRedis.on('error', (error) => {
    if (!bullMqConnectionErrorLogged) {
      // Avoid log spam on repeated failures
      bullMqConnectionErrorLogged = true;
      logger.warn({ code: error.code, message: error.message }, 'BullMQ Redis connection error');
      if (bullMqErrorResetTimer) clearTimeout(bullMqErrorResetTimer);
      bullMqErrorResetTimer = setTimeout(() => { bullMqConnectionErrorLogged = false; bullMqErrorResetTimer = null; }, 30000);
      if (bullMqErrorResetTimer.unref) bullMqErrorResetTimer.unref();
    }
  });
  bullMqRedis.on('connect', () => logger.info('BullMQ Redis connection established'));
  bullMqRedis.on('ready', () => logger.info('BullMQ Redis connection ready'));
  return bullMqRedis;
}

export function getBullMqConnectionOptions() {
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  return connection;
}

export async function disconnectBullMqRedis() {
  const client = bullMqRedis;
  bullMqRedis = null;
  if (bullMqErrorResetTimer) {
    clearTimeout(bullMqErrorResetTimer);
    bullMqErrorResetTimer = null;
  }
  bullMqConnectionErrorLogged = false;
  if (!client) return;
  try {
    client.removeAllListeners();
  } catch (_e) { void _e; }
  try {
    if (client.status === 'wait') {
      client.disconnect();
      return;
    }
    await client.quit();
  } catch (error) {
    logger.warn({ code: error?.code, message: error?.message }, 'BullMQ Redis disconnect failed; closing client');
    try { client.disconnect(); } catch (_e) { void _e; }
  }
}

export function isBullMqEnabled() {
  return Boolean(env.REDIS_URL);
}
