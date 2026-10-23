import { UnrecoverableError } from 'bullmq';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';

export const ANALYTICS_METRICS = {
  overview: 'getOverview',
  sales: 'getSales',
  orders: 'getOrders',
  inventory: 'getInventory',
  customers: 'getCustomers',
  revenue: 'getRevenue',
};

/**
 * Analytics processor (Phase 31): computes a tenant's analytics aggregate ahead of time, warming the same
 * cache entry the /analytics endpoints read, so the next dashboard load is a cache hit.
 */
export async function processCalculateAnalytics(payload, opts = {}) {
  const start = Date.now();
  const { tenantId, metric = 'overview', filters = {} } = payload;
  const jobId = opts.jobId || 'unknown';
  const method = ANALYTICS_METRICS[metric];
  if (!tenantId || !method) throw new UnrecoverableError(`tenantId and a metric (${Object.keys(ANALYTICS_METRICS).join(', ')}) are required`);
  const { AnalyticsService } = await import('../../modules/analytics/analytics.service.js');
  await new AnalyticsService()[method](tenantId, filters);
  const durationMs = Date.now() - start;
  logger.info({ queue: QUEUE_NAMES.ANALYTICS, jobId, tenantId, metric, durationMs, jobName: JOB_NAMES.CALCULATE_ANALYTICS }, 'Analytics aggregate computed and cached');
  return { tenantId, metric, cached: true, durationMs };
}
