import { getPrismaClient } from '../../config/database.js';

export class PermissionRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findById(id, tenantId) {
    return this.prisma.permission.findFirst({
      where: { id, tenantId },
    });
  }

  async findByResourceAction(resource, action, tenantId) {
    return this.prisma.permission.findFirst({
      where: { resource, action, tenantId },
    });
  }

  async findMany(tenantId) {
    return this.prisma.permission.findMany({
      where: { tenantId },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findSystemPermissions() {
    return this.prisma.permission.findMany({
      where: { tenantId: { in: [] } },
    });
  }
}