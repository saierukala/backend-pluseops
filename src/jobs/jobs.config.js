/**
 * Central job defaults for Phase 15.
 * At-least-once delivery with idempotent processors (see processor docs).
 * BullMQ failed jobs are retained for observability; no separate DLQ is created.
 * If a separate DLQ is justified later, it can be added here without changing processors.
 */
export const QUEUE_NAMES = {
  NOTIFICATION: 'notification',
  CLEANUP: 'cleanup',
  WEBHOOK: 'webhook',
  EMAIL: 'email',
  REPORT: 'report',
  ANALYTICS: 'analytics',
};

export const JOB_NAMES = {
  SEND_NOTIFICATION: 'send-notification',
  CLEANUP_EXPIRED_TOKENS: 'cleanup-expired-tokens',
  PROCESS_WEBHOOK: 'process-webhook',
  SEND_EMAIL: 'send-email',
  GENERATE_REPORT: 'generate-report',
  CALCULATE_ANALYTICS: 'calculate-analytics',
};

export const DEFAULT_JOB_OPTIONS = {
  [QUEUE_NAMES.NOTIFICATION]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  },
  [QUEUE_NAMES.CLEANUP]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 24 * 3600 },
  },
  [QUEUE_NAMES.WEBHOOK]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  },
  [QUEUE_NAMES.EMAIL]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 24 * 3600 },
  },
  [QUEUE_NAMES.REPORT]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600 },
  },
  [QUEUE_NAMES.ANALYTICS]: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600 },
  },
};

export const QUEUE_PREFIX = 'pulseops:v1:queue';

export function jobTimeoutMs(queueName) {
  switch (queueName) {
    case QUEUE_NAMES.NOTIFICATION: return 10000;
    case QUEUE_NAMES.CLEANUP: return 30000;
    case QUEUE_NAMES.WEBHOOK: return 15000;
    case QUEUE_NAMES.EMAIL: return 10000;
    case QUEUE_NAMES.REPORT: return 60000;
    case QUEUE_NAMES.ANALYTICS: return 60000;
    default: return 10000;
  }
}
