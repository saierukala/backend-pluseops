import { createRequire } from 'node:module';
import { env } from './env.js';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
let prisma;
let databaseReady = false;

export function getPrismaClient() {
  if (!prisma) {
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
    });
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
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    databaseReady = false;
    logger.warn({ err: error }, 'PostgreSQL health check failed');
    return false;
  }
}

export async function disconnectDatabase() {
  if (databaseReady) await getPrismaClient().$disconnect();
  databaseReady = false;
}
