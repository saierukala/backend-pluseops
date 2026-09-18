import { logger, getRequestLogContext } from '../../config/logger.js';
import { recordRequestMetric } from '../../config/metrics.js';

export function requestLogger(req, res, next) {
  const start = Date.now();
  const ctx = getRequestLogContext(req);

  logger.info({ ...ctx, event: 'request_start' }, 'HTTP request started');

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const statusCode = res.statusCode;
    const logCtx = {
      ...ctx,
      statusCode,
      durationMs,
      event: 'request_complete',
    };

    if (statusCode >= 500) {
      logger.error(logCtx, 'HTTP request completed with server error');
    } else if (statusCode >= 400) {
      logger.warn(logCtx, 'HTTP request completed with client error');
    } else {
      logger.info(logCtx, 'HTTP request completed');
    }

    recordRequestMetric(req.method, req.route?.path || req.originalUrl, statusCode, durationMs);
  });

  next();
}

export function errorLogger(error, req, res, next) {
  const ctx = getRequestLogContext(req);
  logger.error({ ...ctx, err: error, event: 'request_error' }, 'Request error');
  next(error);
}