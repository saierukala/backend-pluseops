import Redis from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';
import { recordRedisMetric } from './metrics.js';

let redis;

function wrapCommand(client, command) {
  const original = client[command].bind(client);
  client[command] = async (...args) => {
    const start = Date.now();
    try {
      const result = await original(...args);
      recordRedisMetric(command, true, Date.now() - start);
      return result;
    } catch (error) {
      recordRedisMetric(command, false, Date.now() - start, error?.code || 'error');
      throw error;
    }
  };
}

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

    const commands = ['get', 'set', 'del', 'exists', 'expire', 'ttl', 'incr', 'decr', 'hget', 'hset', 'hdel', 'hgetall', 'lpush', 'rpush', 'lpop', 'rpop', 'llen', 'sadd', 'srem', 'smembers', 'scard', 'zadd', 'zrem', 'zrange', 'zcard', 'eval', 'evalsha', 'ping', 'info'];
    for (const cmd of commands) {
      wrapCommand(redis, cmd);
    }
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
  const start = Date.now();
  try {
    const result = (await client.ping()) === 'PONG';
    recordRedisMetric('ping', result, Date.now() - start, result ? null : 'unavailable');
    return result;
  } catch (error) {
    recordRedisMetric('ping', false, Date.now() - start, error?.code || 'error');
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
