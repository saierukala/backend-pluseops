import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';
import { tenantsRouter } from '../modules/tenants/tenants.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';

export const apiRouter = Router();
apiRouter.use('/health', healthRouter);
apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/auth', authRouter);