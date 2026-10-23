import { notificationTemplateService as service } from './notification-templates.service.js';

function ctxFrom(req) {
  return { userId: req.context.userId, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null };
}

export async function listTemplates(req, res, next) {
  try {
    const result = await service.list(req.context.tenantId, res.locals.query);
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Templates retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getTemplate(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await service.getById(req.context.tenantId, req.params.id), message: 'Template retrieved successfully' });
  } catch (error) { next(error); }
}

export async function createTemplate(req, res, next) {
  try {
    res.status(201).json({ success: true, data: await service.create(req.context.tenantId, req.body, ctxFrom(req)), message: 'Template created successfully' });
  } catch (error) { next(error); }
}

export async function updateTemplate(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await service.update(req.context.tenantId, req.params.id, req.body, ctxFrom(req)), message: 'Template updated successfully' });
  } catch (error) { next(error); }
}

export async function deleteTemplate(req, res, next) {
  try {
    await service.delete(req.context.tenantId, req.params.id, ctxFrom(req));
    res.status(200).json({ success: true, data: null, message: 'Template deleted successfully' });
  } catch (error) { next(error); }
}

export async function previewTemplate(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await service.preview(req.context.tenantId, req.params.id, req.body.variables), message: 'Template rendered' });
  } catch (error) { next(error); }
}
