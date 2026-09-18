import { Worker } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, JOB_NAMES, QUEUE_PREFIX } from '../jobs.config.js';
import { logger } from '../../config/logger.js';
import { recordQueueMetric } from '../../config/metrics.js';
import { processSendNotification } from '../processors/notification.processor.js';
import { processCleanupExpiredTokens } from '../processors/cleanup.processor.js';
import { processWebhook } from '../processors/webhook.processor.js';
import { processSendEmail } from '../processors/email.processor.js';
import { processGenerateReport } from '../processors/report.processor.js';
import { processCalculateAnalytics } from '../processors/analytics.processor.js';

let workers = [];
let started = false;

const PROCESSORS = {
  [QUEUE_NAMES.NOTIFICATION]: {
    [JOB_NAMES.SEND_NOTIFICATION]: processSendNotification,
  },
  [QUEUE_NAMES.CLEANUP]: {
    [JOB_NAMES.CLEANUP_EXPIRED_TOKENS]: processCleanupExpiredTokens,
  },
  [QUEUE_NAMES.WEBHOOK]: {
    [JOB_NAMES.PROCESS_WEBHOOK]: processWebhook,
  },
  [QUEUE_NAMES.EMAIL]: {
    [JOB_NAMES.SEND_EMAIL]: processSendEmail,
  },
  [QUEUE_NAMES.REPORT]: {
    [JOB_NAMES.GENERATE_REPORT]: processGenerateReport,
  },
  [QUEUE_NAMES.ANALYTICS]: {
    [JOB_NAMES.CALCULATE_ANALYTICS]: processCalculateAnalytics,
  },
};

function createWorker(queueName) {
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  const concurrency = queueName === QUEUE_NAMES.WEBHOOK ? 10 : queueName === QUEUE_NAMES.CLEANUP ? 1 : 5;
  const worker = new Worker(queueName, async (job) => {
    const start = Date.now();
    const jobName = job.name;
    const queue = queueName;
    const jobId = job.id;
    const tenantId = job.data?.tenantId || 'unknown';
    logger.info({ queue, jobId, jobName, tenantId, attempt: job.attemptsMade + 1 }, 'Worker job started');
    try {
      const processorMap = PROCESSORS[queueName];
      const processor = processorMap?.[jobName];
      if (!processor) {
        logger.warn({ queue, jobId, jobName }, 'No processor for job');
        const { UnrecoverableError } = await import('bullmq');
        throw new UnrecoverableError(`No processor for ${queueName}:${jobName}`);
      }
      const result = await processor(job.data, { jobId, attempt: job.attemptsMade + 1, job });
      const durationMs = Date.now() - start;
      recordQueueMetric(queue, jobName, true, durationMs);
      logger.info({ queue, jobId, jobName, tenantId, durationMs, attempt: job.attemptsMade + 1 }, 'Worker job completed');
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      // UnrecoverableError will be handled by BullMQ as permanent failure (no retry)
      const isUnrecoverable = err?.name === 'UnrecoverableError';
      const errorType = isUnrecoverable ? 'permanent' : 'retryable';
      recordQueueMetric(queue, jobName, false, durationMs, errorType);
      logger[isUnrecoverable ? 'warn' : 'error']({ queue, jobId, jobName, tenantId, attempt: job.attemptsMade + 1, durationMs, err: err?.message, name: err?.name }, isUnrecoverable ? 'Worker job permanently failed' : 'Worker job failed (will retry if attempts remain)');
      throw err;
    }
  }, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency,
    lockDuration: 30000,
  });

  worker.on('completed', (job) => {
    logger.info({ queue: queueName, jobId: job.id, jobName: job.name, tenantId: job.data?.tenantId }, 'Worker emitted completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ queue: queueName, jobId: job?.id, jobName: job?.name, tenantId: job?.data?.tenantId, err: err?.message, attemptsMade: job?.attemptsMade }, 'Worker emitted failed');
  });
  worker.on('error', (err) => {
    logger.error({ queue: queueName, err: err?.message }, 'Worker error');
  });
  worker.on('stalled', (jobId) => {
    logger.warn({ queue: queueName, jobId }, 'Worker job stalled');
  });

  return worker;
}

export async function startWorkers() {
  if (started) return workers;
  const connection = getBullMqRedisConnection();
  if (!connection) {
    logger.warn('REDIS_URL not configured; BullMQ workers will not start (jobs will fallback synchronously)');
    return [];
  }
  // Early connection check: ping to ensure Redis is reachable; if not, don't start workers but allow API to run
  try {
    if (connection.status !== 'ready' && connection.status !== 'connecting' && connection.status !== 'connect') {
      // Connection is not ready; try to connect (ioredis with lazyConnect false already connects)
      // Give a short wait
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Redis connect timeout')), 3000);
        if (connection.status === 'ready') { clearTimeout(timeout); resolve(); }
        else connection.once('ready', () => { clearTimeout(timeout); resolve(); });
        connection.once('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    }
  } catch (err) {
    logger.warn({ err: err?.message }, 'BullMQ Redis not reachable; workers not started, enqueue will fallback');
    return [];
  }

  const queueNames = Object.values(QUEUE_NAMES);
  workers = queueNames.map(createWorker).filter(Boolean);
  started = true;
  logger.info({ queues: queueNames }, 'BullMQ workers started');
  return workers;
}

export async function stopWorkers() {
  if (!started && workers.length === 0) return;
  logger.info('Stopping BullMQ workers gracefully');
  await Promise.all(workers.map(async (w) => {
    try { await w.close(); } catch (err) { logger.warn({ err: err?.message }, 'Worker close failed'); }
  }));
  workers = [];
  started = false;
  logger.info('BullMQ workers stopped');
}

export function getWorkers() { return workers; }
export function isWorkersStarted() { return started; }

// For tests: reset state
export function _resetWorkersForTest() { workers = []; started = false; }
