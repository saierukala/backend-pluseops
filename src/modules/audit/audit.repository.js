import { getPrismaClient } from '../../config/database.js';

export class AuditRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tx = null) {
    const client = tx || this.prisma;
    return client.auditLog.create({ data });
  }

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      action,
      resource,
      resourceId,
      userId,
      from,
      to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (action) where.action = action;
    if (resource) where.resource = resource;
    if (resourceId) where.resourceId = resourceId;
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const allowedSort = ['createdAt', 'action', 'resource'];
    const safeSort = allowedSort.includes(sortBy) ? sortBy : 'createdAt';
    const safeOrder = ['asc', 'desc'].includes(sortOrder) ? sortOrder : 'desc';
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { [safeSort]: safeOrder }, skip, take }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async findById(id, tenantId) {
    return this.prisma.auditLog.findFirst({ where: { id, tenantId } });
  }
}

export class ActivityRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tx = null) {
    const client = tx || this.prisma;
    return client.activityLog.create({ data });
  }

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      action,
      userId,
      from,
      to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId };
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const allowedSort = ['createdAt', 'action'];
    const safeSort = allowedSort.includes(sortBy) ? sortBy : 'createdAt';
    const safeOrder = ['asc', 'desc'].includes(sortOrder) ? sortOrder : 'desc';
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({ where, orderBy: { [safeSort]: safeOrder }, skip, take }),
      this.prisma.activityLog.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async findById(id, tenantId) {
    return this.prisma.activityLog.findFirst({ where: { id, tenantId } });
  }
}
