import { Router } from 'express';
import { z } from 'zod';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, previewTemplate } from './notification-templates.controller.js';
import { createTemplateSchema, updateTemplateSchema, listTemplatesSchema, templateIdSchema, previewTemplateSchema } from './notification-templates.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = result.data.params;
    // Express 5 re-parses req.query on every access, so the coerced query travels on res.locals.
    res.locals.query = result.data.query ?? {};
    next();
  };
}

export const notificationTemplatesRouter = Router();
notificationTemplatesRouter.use(authenticate());

notificationTemplatesRouter.get('/', validate(listTemplatesSchema), authorize('notification_template:read'), listTemplates);
notificationTemplatesRouter.post('/', validate(createTemplateSchema), authorize('notification_template:create'), createTemplate);
notificationTemplatesRouter.get('/:id', validate(templateIdSchema), authorize('notification_template:read'), getTemplate);
notificationTemplatesRouter.patch('/:id', validate(updateTemplateSchema), authorize('notification_template:update'), updateTemplate);
notificationTemplatesRouter.delete('/:id', validate(templateIdSchema), authorize('notification_template:delete'), deleteTemplate);
// Rendering has no side effects, so it only needs read access.
notificationTemplatesRouter.post('/:id/preview', validate(previewTemplateSchema), authorize('notification_template:read'), previewTemplate);
