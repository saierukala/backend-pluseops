import { databaseHealthCheck } from '../../config/database.js';
import { redisHealthCheck } from '../../config/redis.js';

function serviceResponse(name, isHealthy) {
  return { name, status: isHealthy ? 'up' : 'down' };
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
    data: serviceResponse('redis', isHealthy),
    message: isHealthy ? 'Redis is healthy' : 'Redis is unavailable'
  });
}
