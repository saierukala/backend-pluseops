import { auditService } from './audit.service.js';
import { AppError } from '../../common/errors/app-error.js';

export async function listAuditLogs(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, action, resource, resourceId, userId, from, to, sortBy, sortOrder } = req.query;
    const result = await auditService.listAuditLogs(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      action,
      resource,
      resourceId,
      userId,
      from,
      to,
      sortBy,
      sortOrder,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Audit logs retrieved successfully' });
  } catch (error) { next(error); }
}

export async function listActivityLogs(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, action, userId, from, to, sortBy, sortOrder } = req.query;
    const result = await auditService.listActivityLogs(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      action,
      userId,
      from,
      to,
      sortBy,
      sortOrder,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Activity logs retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getActivityLog(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const log = await auditService.getActivityLogById(id, tenantId);
    if (!log) throw new AppError('Activity log not found', { statusCode: 404, code: 'ACTIVITY_LOG_NOT_FOUND' });
    res.status(200).json({ success: true, data: log, message: 'Activity log retrieved successfully' });
  } catch (error) { next(error); }
}
