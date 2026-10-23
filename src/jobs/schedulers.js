import { getCleanupQueue, getReportQueue } from './queues/index.js';
import { JOB_NAMES } from './jobs.config.js';
import { logger } from '../config/logger.js';

// Phase 36: recurring jobs as BullMQ job schedulers. upsertJobScheduler is idempotent, so every API/worker process
// may register them; Redis keeps one schedule per id and each run is processed by one worker. Times are UTC.
export const SCHEDULES = [
  { id: 'cleanup-expired-tokens-nightly', queue: getCleanupQueue, pattern: '17 3 * * *', name: JOB_NAMES.CLEANUP_EXPIRED_TOKENS },
  { id: 'prune-reports-nightly', queue: getCleanupQueue, pattern: '27 3 * * *', name: JOB_NAMES.PRUNE_REPORTS },
  // Hourly, so a period that just ended (midnight UTC) is reported within the hour
  { id: 'run-report-schedules-hourly', queue: getReportQueue, pattern: '7 * * * *', name: JOB_NAMES.RUN_REPORT_SCHEDULES },
];

export async function registerSchedulers() {
  const registered = [];
  for (const s of SCHEDULES) {
    const queue = s.queue();
    if (!queue) continue;
    try {
      await queue.upsertJobScheduler(s.id, { pattern: s.pattern, tz: 'UTC' }, { name: s.name, data: { tenantId: null, scheduled: true } });
      registered.push(s.id);
    } catch (err) {
      logger.warn({ err: err?.message, scheduler: s.id }, 'Could not register job scheduler');
    }
  }
  logger.info({ schedulers: registered }, 'Recurring jobs registered');
  return registered;
}
