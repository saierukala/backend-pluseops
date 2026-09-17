import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';

// Global limiter — protects all APIs; disabled in test via app.js conditional
export function createGlobalLimiter() {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', details: null } },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json(options.message);
    },
  });
}

// Strict limiter for auth-sensitive endpoints (login, register, refresh, password, verify)
// Rationale: 20 requests per 15 minutes per IP is generous for legitimate use but mitigates credential stuffing/brute force.
// Redis backing is not required for correctness — express-rate-limit falls back to in-memory store; behavior when Redis unavailable is safe (per-IP memory).
export function createAuthLimiter() {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts, please try again later', details: null } },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json(options.message);
    },
  });
}

export function createWebhookLimiter() {
  return rateLimit({
    windowMs: env.WEBHOOK_RATE_LIMIT_WINDOW_MS,
    limit: env.WEBHOOK_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Webhook rate limit exceeded', details: null } },
    handler: (req, res, next, options) => {
      res.status(options.statusCode).json(options.message);
    },
  });
}
