import { AuditRepository, ActivityRepository } from './audit.repository.js';
import { sanitizeAuditValues, sanitizeMetadata } from './audit.sanitize.js';

const auditRepository = new AuditRepository();
const activityRepository = new ActivityRepository();

export class AuditService {
  constructor() {
    this.auditRepository = auditRepository;
    this.activityRepository = activityRepository;
  }

  // Reusable audit logging - future modules call this without direct DB access
  async logAudit({ tenantId, userId, action, resource, resourceId, oldValue, newValue, ipAddress, userAgent, tx = null }) {
    if (!tenantId) throw new Error('tenantId is required for audit log');
    if (!action) throw new Error('action is required for audit log');
    if (!resource) throw new Error('resource is required for audit log');
    const sanitized = sanitizeAuditValues(oldValue, newValue);
    const data = {
      tenantId,
      userId: userId || null,
      action,
      resource,
      resourceId: resourceId ? String(resourceId) : null,
      oldValue: sanitized.oldValue,
      newValue: sanitized.newValue,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    };
    return this.auditRepository.create(data, tx);
  }

  // Reusable activity logging
  async logActivity({ tenantId, userId, action, description, metadata, ipAddress, userAgent, tx = null }) {
    if (!tenantId) throw new Error('tenantId is required for activity log');
    if (!action) throw new Error('action is required for activity log');
    const sanitizedMeta = metadata ? sanitizeMetadata(metadata) : {};
    const data = {
      tenantId,
      userId: userId || null,
      action: String(action),
      description: description || null,
      metadata: sanitizedMeta,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    };
    return this.activityRepository.create(data, tx);
  }

  // Convenience: log both audit and activity atomically when tx provided
  async logAuditAndActivity(auditData, activityData, tx = null) {
    const audit = await this.logAudit({ ...auditData, tx });
    const activity = await this.logActivity({ ...activityData, tx });
    return { audit, activity };
  }

  async listAuditLogs(tenantId, options) {
    return this.auditRepository.list(tenantId, options);
  }

  async listActivityLogs(tenantId, options) {
    return this.activityRepository.list(tenantId, options);
  }

  async getActivityLogById(id, tenantId) {
    return this.activityRepository.findById(id, tenantId);
  }

  async getAuditLogById(id, tenantId) {
    return this.auditRepository.findById(id, tenantId);
  }
}

// Singleton instance for reuse
export const auditService = new AuditService();

// Helper to extract request context for auditing
export function extractAuditContext(req) {
  const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
  const userAgent = req.headers['user-agent'] || null;
  return { ipAddress, userAgent };
}

// For future modules: simple function that sanitizes and delegates
export async function recordAudit(event, tx = null) {
  return auditService.logAudit({ ...event, tx });
}

export async function recordActivity(event, tx = null) {
  return auditService.logActivity({ ...event, tx });
}
