import { env } from './env.js';
import { logger } from './logger.js';

export const METRIC_LABELS = {
  method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  statusClass: ['1xx', '2xx', '3xx', '4xx', '5xx'],
  service: ['api', 'worker', 'webhook', 'email', 'report', 'analytics', 'notification', 'cleanup'],
  operation: ['db_query', 'db_transaction', 'redis_command', 'queue_enqueue', 'queue_process', 'http_request', 'storage_upload', 'storage_delete', 'storage_get'],
  queue: ['notification', 'cleanup', 'webhook', 'email', 'report', 'analytics'],
  provider: ['payment', 'email', 'sms', 'shipping', 'maps', 'storage'],
  errorType: ['validation', 'authentication', 'authorization', 'not_found', 'timeout', 'unavailable', 'internal'],
};

function statusClass(statusCode) {
  if (statusCode >= 100 && statusCode < 200) return '1xx';
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
}

class MetricsCollector {
  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.enabled = true;
  }

  _makeKey(name, labels) {
    const sortedLabels = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    const labelStr = sortedLabels.map(([k, v]) => `${k}=${v}`).join(',');
    return `${name}{${labelStr}}`;
  }

  incrementCounter(name, labels = {}, value = 1) {
    if (!this.enabled) return;
    const key = this._makeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  recordHistogram(name, value, labels = {}) {
    if (!this.enabled) return;
    const key = this._makeKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, { count: 0, sum: 0, min: Infinity, max: -Infinity, values: [] });
    }
    const hist = this.histograms.get(key);
    hist.count += 1;
    hist.sum += value;
    hist.min = Math.min(hist.min, value);
    hist.max = Math.max(hist.max, value);
    if (hist.values.length < 1000) {
      hist.values.push(value);
    }
  }

  setGauge(name, value, labels = {}) {
    if (!this.enabled) return;
    const key = this._makeKey(name, labels);
    this.gauges.set(key, value);
  }

  getCounters() {
    return Object.fromEntries(this.counters);
  }

  getHistograms() {
    const result = {};
    for (const [key, hist] of this.histograms) {
      const sorted = [...hist.values].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
      result[key] = {
        count: hist.count,
        sum: hist.sum,
        min: hist.min === Infinity ? 0 : hist.min,
        max: hist.max === -Infinity ? 0 : hist.max,
        avg: hist.count > 0 ? hist.sum / hist.count : 0,
        p50,
        p95,
        p99,
      };
    }
    return result;
  }

  getGauges() {
    return Object.fromEntries(this.gauges);
  }

  getAll() {
    return {
      counters: this.getCounters(),
      histograms: this.getHistograms(),
      gauges: this.getGauges(),
    };
  }

  reset() {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

export const metrics = new MetricsCollector();

export function recordRequestMetric(method, route, statusCode, durationMs) {
  const normalizedRoute = normalizeRoute(route);
  metrics.incrementCounter('http_requests_total', { method, route: normalizedRoute, statusClass: statusClass(statusCode) });
  metrics.recordHistogram('http_request_duration_ms', durationMs, { method, route: normalizedRoute, statusClass: statusClass(statusCode) });
  if (statusCode >= 400) {
    metrics.incrementCounter('http_errors_total', { method, route: normalizedRoute, statusClass: statusClass(statusCode) });
  }
}

export function recordDbMetric(operation, success, durationMs, errorType = null) {
  metrics.incrementCounter('db_operations_total', { operation, success: String(success) });
  if (durationMs > 0) {
    metrics.recordHistogram('db_operation_duration_ms', durationMs, { operation });
  }
  if (!success && errorType) {
    metrics.incrementCounter('db_errors_total', { operation, errorType });
  }
}

export function recordRedisMetric(command, success, durationMs, errorType = null) {
  metrics.incrementCounter('redis_commands_total', { command, success: String(success) });
  if (durationMs > 0) {
    metrics.recordHistogram('redis_command_duration_ms', durationMs, { command });
  }
  if (!success && errorType) {
    metrics.incrementCounter('redis_errors_total', { command, errorType });
  }
}

export function recordQueueMetric(queue, operation, success, durationMs, errorType = null) {
  metrics.incrementCounter('queue_operations_total', { queue, operation, success: String(success) });
  if (durationMs > 0) {
    metrics.recordHistogram('queue_operation_duration_ms', durationMs, { queue, operation });
  }
  if (!success && errorType) {
    metrics.incrementCounter('queue_errors_total', { queue, operation, errorType });
  }
}

export function recordExternalMetric(provider, operation, success, durationMs, errorType = null, retryCount = 0) {
  metrics.incrementCounter('external_requests_total', { provider, operation, success: String(success) });
  if (durationMs > 0) {
    metrics.recordHistogram('external_request_duration_ms', durationMs, { provider, operation });
  }
  if (retryCount > 0) {
    metrics.incrementCounter('external_retries_total', { provider, operation }, retryCount);
  }
  if (!success && errorType) {
    metrics.incrementCounter('external_errors_total', { provider, operation, errorType });
  }
}

export function recordStorageMetric(operation, success, durationMs, errorType = null, provider = 'local') {
  metrics.incrementCounter('storage_operations_total', { provider, operation, success: String(success) });
  if (durationMs > 0) {
    metrics.recordHistogram('storage_operation_duration_ms', durationMs, { provider, operation });
  }
  if (!success && errorType) {
    metrics.incrementCounter('storage_errors_total', { provider, operation, errorType });
  }
}

export function setQueueGauge(queue, metric, value) {
  metrics.setGauge(`queue_${metric}`, value, { queue });
}

function normalizeRoute(route) {
  return route
    .replace(/\/[a-f0-9-]{36}/gi, '/:id')
    .replace(/\/[0-9]+/g, '/:id')
    .replace(/\/\w{20,}/g, '/:token');
}

export function logMetricSummary() {
  if (env.NODE_ENV !== 'production') return;
  const all = metrics.getAll();
  logger.info({ metrics: all }, 'Metrics summary');
}

let metricsInterval = null;
if (env.NODE_ENV !== 'test') {
  metricsInterval = setInterval(() => {
    logMetricSummary();
  }, 60000);
  if (metricsInterval.unref) metricsInterval.unref();
}

export function stopMetricsInterval() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}