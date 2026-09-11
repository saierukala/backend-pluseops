import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';
import { tenantsRouter } from '../modules/tenants/tenants.routes.js';

export const apiRouter = Router();
apiRouter.use('/health', healthRouter);
apiRouter.use('/tenants', tenantsRouter);