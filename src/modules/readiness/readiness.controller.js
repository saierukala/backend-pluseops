import { databaseHealthCheck } from '../../config/database.js';
import { redisHealthCheck } from '../../config/redis.js';
import { isBullMqEnabled, getBullMqRedisConnection } from '../../jobs/connection.js';
import { logger } from '../../config/logger.js';

const REQUIRED_DEPENDENCIES = ['database'];

export async function readinessCheck(req, res) {
  const start = Date.now();
  const results = {};

  // Check required dependencies
  const dbHealthy = await databaseHealthCheck();
  results.database = { status: dbHealthy ? 'up' : 'down', required: true };

  // Check optional dependencies
  const redisHealthy = await redisHealthCheck();
  results.redis = { status: redisHealthy ? 'up' : 'down', required: false };

  let bullmqHealthy;
  if (isBullMqEnabled()) {
    try {
      const conn = getBullMqRedisConnection();
      bullmqHealthy = conn && conn.status === 'ready';
      if (!bullmqHealthy && conn) {
        await conn.ping();
        bullmqHealthy = true;
      }
    } catch {
      bullmqHealthy = false;
    }
  } else {
    bullmqHealthy = true;
  }
  results.bullmq = { status: bullmqHealthy ? 'up' : 'down', required: false };

  const allRequiredHealthy = REQUIRED_DEPENDENCIES.every((dep) => results[dep]?.status === 'up');
  const overallStatus = allRequiredHealthy ? 'ready' : 'not_ready';
  const statusCode = allRequiredHealthy ? 200 : 503;

  const durationMs = Date.now() - start;

  logger.info(
    { dependencies: results, overallStatus, durationMs, requestId: req.id },
    `Readiness check: ${overallStatus}`
  );

  res.status(statusCode).json({
    success: allRequiredHealthy,
    data: {
      status: overallStatus,
      dependencies: results,
      timestamp: new Date().toISOString(),
    },
    message: allRequiredHealthy ? 'Application is ready to serve traffic' : 'Required dependencies unavailable',
  });
}

export function liveHealth(_req, res) {
  res.status(200).json({ success: true, data: { status: 'ok' }, message: 'Service is alive' });
}