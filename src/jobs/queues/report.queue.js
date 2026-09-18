import { Queue } from 'bullmq';
import { getBullMqRedisConnection } from '../connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX, DEFAULT_JOB_OPTIONS, JOB_NAMES, jobTimeoutMs } from '../jobs.config.js';
import { logger } from '../../config/logger.js';
import { recordQueueMetric } from '../../config/metrics.js';

/**
 * Report queue — DEFERRED analytics/reporting (Phase 18).
 * Phase 15 creates queue/worker boundary only; processor is a safe stub.
 */
let reportQueue = null;

function getQueue() {
  if (reportQueue) return reportQueue;
  const connection = getBullMqRedisConnection();
  if (!connection) return null;
  reportQueue = new Queue(QUEUE_NAMES.REPORT, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.REPORT],
  });
  reportQueue.on('error', (err) => logger.warn({ err, queue: QUEUE_NAMES.REPORT }, 'Queue error'));
  return reportQueue;
}

export async function enqueueReport({ tenantId, userId = null, reportType = 'generic', filters = {}, idempotencyKey = null }) {
  if (!tenantId) throw new Error('tenantId is required');
  const queue = getQueue();
  const payload = { tenantId, userId, reportType, filters, enqueuedAt: new Date().toISOString() };
  // BullMQ Custom Id cannot contain `:` — use `-`
  const rawJobId = idempotencyKey ? `report-${tenantId}-${idempotencyKey}` : undefined;
  const jobId = rawJobId ? rawJobId.replace(/:/g, '-') : undefined;
  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.REPORT }, 'Redis unavailable; report job deferred');
    return { id: `deferred-${Date.now()}`, fallback: true, deferred: true };
  }
  try {
    const job = await queue.add(JOB_NAMES.GENERATE_REPORT, payload, {
      jobId,
      attempts: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.REPORT].attempts,
      backoff: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.REPORT].backoff,
      removeOnComplete: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.REPORT].removeOnComplete,
      removeOnFail: DEFAULT_JOB_OPTIONS[QUEUE_NAMES.REPORT].removeOnFail,
      timeout: jobTimeoutMs(QUEUE_NAMES.REPORT),
    });
    recordQueueMetric(QUEUE_NAMES.REPORT, 'enqueue', true, 0);
    logger.info({ queue: QUEUE_NAMES.REPORT, jobId: job.id, tenantId, reportType }, 'Report job enqueued (generation deferred)');
    return job;
  } catch (err) {
    recordQueueMetric(QUEUE_NAMES.REPORT, 'enqueue', false, 0, err?.code || 'error');
    if (String(err?.message).toLowerCase().includes('already exists') || String(err?.message).includes('JobId')) {
      return { id: jobId, duplicate: true };
    }
    logger.error({ err, queue: QUEUE_NAMES.REPORT }, 'Failed to enqueue report job');
    throw err;
  }
}

export function getReportQueue() { return getQueue(); }
export function _resetReportQueueForTest() { reportQueue = null; }
