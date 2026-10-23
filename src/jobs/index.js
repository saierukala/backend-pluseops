import { startWorkers, stopWorkers, getWorkers, isWorkersStarted } from './workers/index.js';
import { getAllQueues, closeAllQueues } from './queues/index.js';
import { disconnectBullMqRedis, isBullMqEnabled } from './connection.js';

export async function initJobs() {
  if (!isBullMqEnabled()) {
    // No Redis -> no workers, but queues will fallback synchronously; not a fatal error
    const { logger } = await import('../config/logger.js');
    logger.warn('BullMQ disabled (REDIS_URL missing); background jobs will use synchronous fallback');
    return { enabled: false };
  }
  const workers = await startWorkers();
  const { env } = await import('../config/env.js');
  if (env.JOB_SCHEDULERS_ENABLED) {
    const { registerSchedulers } = await import('./schedulers.js');
    await registerSchedulers();
  }
  return { enabled: true, workers, queues: getAllQueues() };
}

export async function shutdownJobs() {
  await stopWorkers();
  await closeAllQueues();
  await disconnectBullMqRedis();
}

export { isBullMqEnabled, getAllQueues, getWorkers, isWorkersStarted, disconnectBullMqRedis, stopWorkers };
