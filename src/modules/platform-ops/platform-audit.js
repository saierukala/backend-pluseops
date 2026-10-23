import { getPrismaClient } from '../../config/database.js';
import { logger } from '../../config/logger.js';

export function platformActorFrom(req) {
  return {
    userId: req.context?.userId ?? null,
    ipAddress: req.ip?.slice(0, 64) ?? null,
    userAgent: req.headers['user-agent']?.slice(0, 512) ?? null,
  };
}

/**
 * Records a platform admin action (Phase 33). Written after the action succeeds; a logging failure is
 * reported but doesn't undo or fail the action itself.
 */
export async function logPlatformAction(actor, { action, targetType, targetId = null, tenantId = null, details = {} }) {
  try {
    await getPrismaClient().platformAuditLog.create({
      data: { actorUserId: actor.userId, action, targetType, targetId: targetId ? String(targetId) : null, tenantId, details, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
    });
  } catch (err) {
    logger.error({ err, action, targetType, targetId }, 'Platform audit log write failed');
  }
}

export async function listPlatformAudit({ page = 1, limit = 50, action, tenantId, actorUserId, from, to }) {
  const prisma = getPrismaClient();
  const where = {};
  if (action) where.action = action;
  if (tenantId) where.tenantId = tenantId;
  if (actorUserId) where.actorUserId = actorUserId;
  if (from || to) where.createdAt = { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) };
  const [rows, total] = await Promise.all([
    prisma.platformAuditLog.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
      include: { actor: { select: { id: true, email: true } }, tenant: { select: { id: true, name: true, slug: true } } },
    }),
    prisma.platformAuditLog.count({ where }),
  ]);
  return {
    data: rows.map((r) => ({ id: r.id, action: r.action, targetType: r.targetType, targetId: r.targetId, tenant: r.tenant, actor: r.actor, details: r.details, ipAddress: r.ipAddress, createdAt: r.createdAt })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
