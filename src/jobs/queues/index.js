import { getNotificationQueue, enqueueNotification } from './notification.queue.js';
import { getCleanupQueue, enqueueCleanup } from './cleanup.queue.js';
import { getWebhookQueue, enqueueWebhook } from './webhook.queue.js';
import { getEmailQueue, enqueueEmail } from './email.queue.js';
import { getReportQueue, enqueueReport } from './report.queue.js';
import { getAnalyticsQueue, enqueueAnalytics } from './analytics.queue.js';
import { QUEUE_NAMES } from '../jobs.config.js';

export function getAllQueues() {
  return {
    [QUEUE_NAMES.NOTIFICATION]: getNotificationQueue(),
    [QUEUE_NAMES.CLEANUP]: getCleanupQueue(),
    [QUEUE_NAMES.WEBHOOK]: getWebhookQueue(),
    [QUEUE_NAMES.EMAIL]: getEmailQueue(),
    [QUEUE_NAMES.REPORT]: getReportQueue(),
    [QUEUE_NAMES.ANALYTICS]: getAnalyticsQueue(),
  };
}

export async function closeAllQueues() {
  const queues = Object.values(getAllQueues()).filter(Boolean);
  await Promise.all(queues.map((q) => q.close().catch(() => {})));
}

export {
  getNotificationQueue, enqueueNotification,
  getCleanupQueue, enqueueCleanup,
  getWebhookQueue, enqueueWebhook,
  getEmailQueue, enqueueEmail,
  getReportQueue, enqueueReport,
  getAnalyticsQueue, enqueueAnalytics,
  QUEUE_NAMES,
};
