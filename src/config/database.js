import { createRequire } from 'node:module';
import { env } from './env.js';
import { logger } from './logger.js';
import { recordDbMetric } from './metrics.js';

const require = createRequire(import.meta.url);
let prisma;
let databaseReady = false;

export function getPrismaClient() {
  if (!prisma) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
    });

    if (typeof prisma.$use === 'function') {
      prisma.$use(async (params, next) => {
        const start = Date.now();
        const operation = `${params.model || 'unknown'}.${params.action}`;
        try {
          const result = await next(params);
          const durationMs = Date.now() - start;
          recordDbMetric(operation, true, durationMs);
          return result;
        } catch (error) {
          const durationMs = Date.now() - start;
          let errorType = 'internal';
          if (error?.code === 'P2003') errorType = 'constraint';
          else if (error?.code === 'P2002') errorType = 'unique_constraint';
          else if (error?.code?.startsWith('P2')) errorType = 'database';
          else if (error?.code === 'ECONNREFUSED') errorType = 'connection';
          recordDbMetric(operation, false, durationMs, errorType);
          throw error;
        }
      });
    }
  }
  return prisma;
}

export async function connectDatabase() {
  if (!env.DATABASE_URL) {
    logger.warn('DATABASE_URL is not configured; database health check will remain unavailable');
    return false;
  }

  await getPrismaClient().$connect();
  databaseReady = true;
  logger.info('PostgreSQL connection established');
  return true;
}

export async function databaseHealthCheck() {
  if (!databaseReady) return false;
  const start = Date.now();
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    recordDbMetric('health_check', true, Date.now() - start);
    return true;
  } catch (error) {
    recordDbMetric('health_check', false, Date.now() - start, 'connection');
    databaseReady = false;
    logger.warn({ err: error }, 'PostgreSQL health check failed');
    return false;
  }
}

export async function disconnectDatabase() {
  databaseReady = false;
  if (prisma) {
    try {
      await prisma.$disconnect();
    } catch (_e) {
      void _e;
    }
  }
}
