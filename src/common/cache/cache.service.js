import { getRedisClient } from '../../config/redis.js';
import { logger } from '../../config/logger.js';

const SENSITIVE_KEYS = ['password', 'passwordHash', 'password_hash', 'token', 'refreshToken', 'accessToken', 'secret', 'providerSecret', 'credential', 'apiKey'];

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((s) => lower.includes(s.toLowerCase()));
}

function stripSensitive(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

export class CacheService {
  constructor(redisClient) {
    this.redis = redisClient ?? null;
  }

  getRedis() {
    if (this.redis) return this.redis;
    try {
      return getRedisClient();
    } catch {
      return undefined;
    }
  }

  async get(key) {
    const client = this.getRedis();
    if (!client) return null;
    try {
      const raw = await client.get(key);
      if (raw === null || raw === undefined) return null;
      return JSON.parse(raw);
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache GET failed; falling back to database');
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    const client = this.getRedis();
    if (!client) return false;
    try {
      const safeValue = stripSensitive(value);
      const serialized = JSON.stringify(safeValue);
      if (ttlSeconds && ttlSeconds > 0) {
        await client.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await client.set(key, serialized);
      }
      return true;
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache SET failed; continuing without cache');
      return false;
    }
  }

  async del(key) {
    const client = this.getRedis();
    if (!client) return false;
    try {
      await client.del(key);
      return true;
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache DEL failed');
      return false;
    }
  }

  async delByPattern(pattern) {
    const client = this.getRedis();
    if (!client) return 0;
    try {
      let cursor = '0';
      let deleted = 0;
      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await client.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
      return deleted;
    } catch (error) {
      logger.warn({ err: error, pattern }, 'Cache delByPattern failed');
      return 0;
    }
  }

  async getOrSet(key, loader, ttlSeconds) {
    const cached = await this.get(key);
    if (cached !== null) {
      return { value: cached, hit: true };
    }
    const value = await loader();
    if (value !== null && value !== undefined) {
      await this.set(key, value, ttlSeconds);
    }
    return { value, hit: false };
  }
}

let defaultCacheService;
export function getCacheService() {
  if (!defaultCacheService) defaultCacheService = new CacheService();
  return defaultCacheService;
}
