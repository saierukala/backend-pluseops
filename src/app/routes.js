import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';
import { tenantsRouter } from '../modules/tenants/tenants.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { rolesRouter } from '../modules/roles/roles.routes.js';
import { permissionsRouter } from '../modules/permissions/permissions.routes.js';
import { usersRouter } from '../modules/users/users.routes.js';

export const apiRouter = Router();
apiRouter.use('/health', healthRouter);
apiRouter.use('/tenants', tenantsRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/roles', rolesRouter);
apiRouter.use('/permissions', permissionsRouter);
apiRouter.use('/users', usersRouter);