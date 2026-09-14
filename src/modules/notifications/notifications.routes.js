import { Router } from 'express';
import { z } from 'zod';
import { listNotifications, markOneAsRead, markAllAsRead, getPreferences, updatePreferences } from './notifications.controller.js';
import { listNotificationsQuerySchema, markReadParamsSchema, patchPreferencesSchema } from './notifications.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body ?? req.body;
    req.params = result.data.params ?? req.params;
    if (result.data.query) Object.assign(req.query, result.data.query);
    next();
  };
}

export const notificationsRouter = Router();
notificationsRouter.use(authenticate());
notificationsRouter.get('/', validate(listNotificationsQuerySchema), authorize('notification:read'), listNotifications);
notificationsRouter.post('/read-all', authorize('notification:update'), markAllAsRead);
notificationsRouter.patch('/:id/read', validate(markReadParamsSchema), authorize('notification:update'), markOneAsRead);

export const notificationPreferencesRouter = Router();
notificationPreferencesRouter.use(authenticate());
notificationPreferencesRouter.get('/', authorize('notification:read'), getPreferences);
notificationPreferencesRouter.patch('/', validate(patchPreferencesSchema), authorize('notification:update'), updatePreferences);
