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
  // A queue closed by shutdownJobs() never reconnects; build a new one instead of hanging on add().
  if (reportQueue && !reportQueue.closing) return reportQueue;
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

/**
 * Enqueue generation of a stored Report row (Phase 31). The payload carries ids only; the worker reads the
 * report's type and filters from the database. One job per report (jobId = report id).
 */
export async function enqueueReport({ tenantId, userId = null, reportId, reportType = null }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!reportId) throw new Error('reportId is required');
  const queue = getQueue();
  const payload = { tenantId, userId, reportId, reportType, enqueuedAt: new Date().toISOString() };
  const jobId = `report-${reportId}`;
  if (!queue) {
    logger.warn({ queue: QUEUE_NAMES.REPORT, reportId }, 'Redis unavailable; generating report synchronously');
    const { processGenerateReport } = await import('../processors/report.processor.js');
    const result = await processGenerateReport(payload, { jobId }).catch((err) => ({ failed: true, error: err.message }));
    return { id: `sync-${reportId}`, fallback: true, result };
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
    logger.info({ queue: QUEUE_NAMES.REPORT, jobId: job.id, tenantId, reportId, reportType }, 'Report job enqueued');
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
