import { ZodError } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export function errorHandler(error, req, res, _next) {
  const isValidationError = error instanceof ZodError;
  const isInvalidJson = error.type === 'entity.parse.failed';
  const isPayloadTooLarge = error.type === 'entity.too.large';
  const isCorsError = error.message === 'Not allowed by CORS';
  const isMulterError = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_UNEXPECTED_FILE';
  const isMulterFileType = error.message === 'Invalid file type';
  const statusCode = isValidationError ? 400 : (isInvalidJson ? 400 : (isPayloadTooLarge ? 413 : (isCorsError ? 403 : (isMulterError || isMulterFileType ? 400 : (error.statusCode || 500)))));
  const code = isValidationError
    ? 'VALIDATION_ERROR'
    : (isInvalidJson ? 'INVALID_JSON' : (isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : (isCorsError ? 'CORS_NOT_ALLOWED' : (error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : (isMulterFileType ? 'INVALID_FILE_TYPE' : (error.code || 'INTERNAL_ERROR'))))));
  // Never expose stack traces, SQL, filesystem paths, or secrets in production
  let message = error.message;
  if (statusCode >= 500 && env.NODE_ENV === 'production') {
    message = 'An unexpected error occurred';
  } else if (isCorsError) {
    message = 'Origin not allowed';
  } else if (error.code === 'LIMIT_FILE_SIZE') {
    message = 'File size exceeds allowed limit';
  } else if (isMulterFileType) {
    message = 'Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.';
  }

  // Sanitize message to avoid leaking paths/secrets: strip filesystem paths and secret patterns
  if (env.NODE_ENV === 'production' && typeof message === 'string') {
    message = message.replace(/\/[^\s]*\.(js|ts|sql|env)[^\s]*/gi, '[redacted-path]');
  }

  logger.error({ err: error, requestId: req.id, method: req.method, path: req.originalUrl }, 'Request failed');
  res.status(statusCode).json({
    success: false,
    error: { code, message, details: isValidationError ? error.issues : (error.details || null) },
    requestId: req.id
  });
}
