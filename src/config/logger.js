import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'secret', 'apiKey', 'S3_SECRET_ACCESS_KEY', 'EMAIL_PROVIDER_API_KEY', 'PAYMENT_PROVIDER_API_KEY', 'SMS_PROVIDER_API_KEY', 'SHIPPING_PROVIDER_API_KEY', 'MAPS_PROVIDER_API_KEY', 'S3_ACCESS_KEY_ID', 'accessKey', 'secretKey', 'authorization', '*.secret', '*.apiKey', '*.accessKey', '*.secretKey', 'headers.authorization'],
    censor: '[REDACTED]'
  }
});
