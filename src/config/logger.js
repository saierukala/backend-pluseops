import pino from 'pino';
import { env } from './env.js';

const sensitiveFields = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-webhook-signature"]',
  'req.headers["x-payment-signature"]',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
  'apiKey',
  'api_key',
  'providerSecret',
  'credential',
  'authorization',
  'S3_SECRET_ACCESS_KEY',
  'EMAIL_PROVIDER_API_KEY',
  'PAYMENT_PROVIDER_API_KEY',
  'SMS_PROVIDER_API_KEY',
  'SHIPPING_PROVIDER_API_KEY',
  'MAPS_PROVIDER_API_KEY',
  'S3_ACCESS_KEY_ID',
  'accessKey',
  'secretKey',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.accessKey',
  '*.secretKey',
  'headers.authorization',
  'headers.cookie',
  'body.password',
  'body.token',
  'body.secret',
  'body.apiKey',
  'body.refreshToken',
  'body.accessToken',
  'query.token',
  'query.apiKey',
  'query.secret',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: sensitiveFields,
    censor: '[REDACTED]',
    remove: true,
  },
  formatters: {
    level: (label) => ({ level: label }),
    bindings: () => ({}),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function createChildLogger(baseContext) {
  return logger.child(baseContext);
}

export function getRequestLogContext(req) {
  return {
    requestId: req.id,
    method: req.method,
    path: req.route?.path || req.originalUrl,
    tenantId: req.context?.tenantId,
    userId: req.context?.userId,
    sessionId: req.context?.sessionId,
  };
}
