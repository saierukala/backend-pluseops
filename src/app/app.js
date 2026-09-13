import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import hpp from 'hpp';
import { env } from '../config/env.js';
import { errorHandler } from '../common/middleware/error-handler.js';
import { notFoundHandler } from '../common/middleware/not-found.js';
import { requestContext } from '../common/middleware/request-context.js';
import { apiRouter } from './routes.js';
import { healthRouter } from '../modules/health/health.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compression());
  app.use(hpp());
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
  if (env.NODE_ENV !== 'test') {
    app.use(rateLimit({ windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX, standardHeaders: 'draft-8', legacyHeaders: false }));
  }

  app.use('/health', healthRouter);
  app.use('/api/v1', apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
