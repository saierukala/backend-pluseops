import { ZodError } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export function errorHandler(error, req, res, _next) {
  const isValidationError = error instanceof ZodError;
  const isInvalidJson = error.type === 'entity.parse.failed';
  const isPayloadTooLarge = error.type === 'entity.too.large';
  const statusCode = isValidationError ? 400 : (error.statusCode || 500);
  const code = isValidationError
    ? 'VALIDATION_ERROR'
    : (isInvalidJson ? 'INVALID_JSON' : (isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : (error.code || 'INTERNAL_ERROR')));
  const message = statusCode >= 500 && env.NODE_ENV === 'production'
    ? 'An unexpected error occurred'
    : error.message;

  logger.error({ err: error, requestId: req.id, method: req.method, path: req.originalUrl }, 'Request failed');
  res.status(statusCode).json({
    success: false,
    error: { code, message, details: isValidationError ? error.issues : (error.details || null) },
    requestId: req.id
  });
}
