import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import { env } from '../config/env.js';
import { errorHandler } from '../common/middleware/error-handler.js';
import { notFoundHandler } from '../common/middleware/not-found.js';
import { requestContext } from '../common/middleware/request-context.js';
import { requestLogger } from '../common/middleware/request-logger.js';
import { createGlobalLimiter } from '../common/middleware/rate-limiters.js';
import { apiRouter } from './routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { readinessRouter } from '../modules/readiness/readiness.routes.js';
import { metricsRouter } from '../modules/metrics/metrics.routes.js';
import { setupSwagger } from '../docs/swagger.js';

/**
 * Security hardening — Phase 20
 * - Helmet: X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Frameguard deny, HSTS (production only), hidePoweredBy. CSP/COEP disabled deliberately for JSON API (browser-only HTML protections irrelevant; documented exclusion).
 * - CORS: explicit allowlist from validated env, never wildcard with credentials, production requires explicit origins.
 * - XSS threat model: API returns JSON, not HTML; user-controlled strings are JSON-escaped by Express; no server-side HTML rendering; HTML fields not blindly escaped to avoid corrupting API data — frontend must sanitize before rendering (documented).
 * - CSRF/cookies: authentication is Bearer-token only (Authorization header); no cookies, no HttpOnly/Secure/SameSite needed, no CSRF middleware (meaningless for bearer-only APIs — documented conclusion).
 * - Request size: json + urlencoded limited via REQUEST_BODY_LIMIT; multipart via multer 10MB; webhook payload limited via same JSON limit.
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(requestLogger);
  // Security headers — API-appropriate Helmet configuration
  app.use(helmet({
    contentSecurityPolicy: false, // API returns JSON, not HTML; CSP is browser-rendered content policy — disabled to avoid breaking legitimate API consumers
    crossOriginEmbedderPolicy: false, // Not relevant for JSON API; would block legitimate cross-origin fetches
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
  }));
  // Development-only dynamic localhost CORS: allows any http://localhost:<valid-port> and http://127.0.0.1:<valid-port>
  // Validates parsed hostname/protocol rather than substring check; disabled in production
  function isAllowedDevelopmentOrigin(origin) {
    if (env.NODE_ENV === 'production') return false;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:') return false;
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false;
      if (url.username || url.password) return false;
      if (url.pathname !== '/' || url.search || url.hash) return false;
      if (url.origin !== origin) return false;
      if (url.port) {
        const port = Number(url.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  app.use(cors({
    origin(origin, callback) {
      // Allow non-browser requests (no origin) and configured origins; credentials handled deliberately
      if (!origin) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      if (isAllowedDevelopmentOrigin(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Webhook-Signature', 'X-Payment-Signature'],
    maxAge: 600,
  }));
  app.use(compression({ threshold: 512, level: 6 }));
  app.use(hpp());
  app.use(express.json({
    limit: env.REQUEST_BODY_LIMIT,
    verify: (req, _res, buf) => {
      // Preserve raw bytes for webhook HMAC verification (provider signs raw request bytes)
      if (req.originalUrl && req.originalUrl.includes('/payments/webhook')) {
        req.rawBody = buf.toString('utf8');
      }
    },
  }));
  app.use(express.urlencoded({ extended: false, limit: env.REQUEST_BODY_LIMIT }));
  if (env.NODE_ENV !== 'test') {
    app.use(createGlobalLimiter());
  }

  setupSwagger(app);

  app.use('/health', healthRouter);
  app.use('/ready', readinessRouter);
  app.use('/metrics', metricsRouter);
  app.use('/api/v1', apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
