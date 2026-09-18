import { databaseHealthCheck } from '../../config/database.js';
import { redisHealthCheck } from '../../config/redis.js';
import { isBullMqEnabled, getBullMqRedisConnection } from '../../jobs/connection.js';

function serviceResponse(name, isHealthy, required = true) {
  return { name, status: isHealthy ? 'up' : 'down', required };
}

export function liveHealth(_req, res) {
  res.status(200).json({ success: true, data: { status: 'ok' }, message: 'Service is healthy' });
}

export async function databaseHealth(_req, res) {
  const isHealthy = await databaseHealthCheck();
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: serviceResponse('database', isHealthy),
    message: isHealthy ? 'Database is healthy' : 'Database is unavailable'
  });
}

export async function redisHealth(_req, res) {
  const isHealthy = await redisHealthCheck();
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: serviceResponse('redis', isHealthy, false),
    message: isHealthy ? 'Redis is healthy' : 'Redis is unavailable'
  });
}

export async function bullmqHealth(_req, res) {
  let isHealthy = false;
  if (isBullMqEnabled()) {
    try {
      const conn = getBullMqRedisConnection();
      if (conn && conn.status === 'ready') {
        isHealthy = true;
      } else if (conn) {
        await conn.ping();
        isHealthy = true;
      }
    } catch {
      isHealthy = false;
    }
  } else {
    isHealthy = true;
  }
  res.status(isHealthy ? 200 : 503).json({
    success: isHealthy,
    data: serviceResponse('bullmq', isHealthy, false),
    message: isHealthy ? 'BullMQ is healthy' : 'BullMQ is unavailable'
  });
}
