import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

let redis;

export function getRedisClient() {
  if (!env.REDIS_URL) return undefined;
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3000,
      retryStrategy: () => null
    });
    redis.on('error', (error) => logger.warn({ code: error.code, message: error.message }, 'Redis client error'));
  }
  return redis;
}

export async function connectRedis() {
  const client = getRedisClient();
  if (!client) {
    logger.warn('REDIS_URL is not configured; Redis health check will remain unavailable');
    return false;
  }
  await client.connect();
  logger.info('Redis connection established');
  return true;
}

export async function redisHealthCheck() {
  const client = getRedisClient();
  if (!client || client.status !== 'ready') return false;
  try {
    return (await client.ping()) === 'PONG';
  } catch (error) {
    logger.warn({ err: error }, 'Redis health check failed');
    return false;
  }
}

export async function disconnectRedis() {
  const client = redis;
  redis = undefined;
  if (!client || client.status === 'end') return;

  // A lazily created client may never have opened a stream (for example, a
  // readiness check while Redis is unavailable). `quit` is invalid in that
  // state, but disconnecting it is safe and releases its resources.
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }

  try {
    await client.quit();
  } catch (error) {
    logger.warn({ code: error.code, message: error.message }, 'Redis disconnect failed; closing client');
    client.disconnect();
  }
}
