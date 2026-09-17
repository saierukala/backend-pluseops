import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { initJobs, shutdownJobs } from './jobs/index.js';

let shuttingDown = false;

async function start() {
  logger.info({ nodeEnv: env.NODE_ENV }, 'PulseOps worker starting');

  const dependencies = [
    { name: 'PostgreSQL', connect: connectDatabase },
    { name: 'Redis', connect: connectRedis },
  ];
  const results = await Promise.allSettled(dependencies.map(({ connect }) => connect()));
  const failures = results
    .map((result, index) => ({ result, name: dependencies[index].name }))
    .filter(({ result }) => result.status === 'rejected');

  // Worker requires both PostgreSQL and Redis — fail fast when missing
  if (failures.length > 0) {
    const message = failures.map(({ name, result }) => `${name}: ${result.reason?.message ?? result.reason}`).join('; ');
    throw new Error(`Worker required dependencies unavailable: ${message} (set DATABASE_URL and REDIS_URL)`);
  }

  // Prisma lazy warm-up: log if connection not actually ready
  const statuses = results.map((r, i) => ({ name: dependencies[i].name, ready: r.status === 'fulfilled' && r.value === true }));
  logger.info({ dependencies: statuses }, 'Worker dependencies connected');

  const jobs = await initJobs();
  logger.info({ jobsEnabled: jobs.enabled }, 'PulseOps worker ready — waiting for BullMQ jobs');

  if (!jobs.enabled) {
    logger.warn('BullMQ disabled (REDIS_URL missing) — worker has no queues to process; exiting');
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker graceful shutdown started');
  try {
    await shutdownJobs();
  } catch (err) {
    logger.warn({ err: err?.message }, 'Worker shutdownJobs failed');
  }
  await Promise.all([disconnectRedis(), disconnectDatabase()]);
  logger.info('Worker graceful shutdown complete');
  // Give logger time to flush
  setTimeout(() => process.exit(0), 200).unref();
  // Hard timeout — force exit if graceful path hangs
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Worker uncaught exception');
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Worker unhandled rejection');
  shutdown('unhandledRejection');
});

start().catch((error) => {
  logger.fatal({ err: error }, 'Unable to start PulseOps worker');
  process.exit(1);
});
