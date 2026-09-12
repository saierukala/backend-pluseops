import { getPrismaClient } from '../../config/database.js';

export class UserRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findByIdAndTenant(id, tenantId) {
    return this.prisma.user.findFirst({
      where: { id, memberships: { some: { tenantId, status: 'ACTIVE' } } },
    });
  }

  async findUserRoles(userId, tenantId) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, tenantId },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });
    return userRoles;
  }

  async findRolesByIds(roleIds, tenantId) {
    return this.prisma.role.findMany({
      where: {
        id: { in: roleIds },
        tenantId,
      },
      select: { id: true },
    });
  }

  async assignRoles(userId, tenantId, roleIds) {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { id: true, status: true },
      });
      if (!membership || membership.status !== 'ACTIVE') return [];
      const existing = await tx.userRole.findMany({
        where: {
          tenantId,
          userId,
          roleId: { in: roleIds },
        },
        select: { roleId: true },
      });

      const existingIds = new Set(existing.map((e) => e.roleId));
      const newRoles = roleIds.filter((id) => !existingIds.has(id));

      if (newRoles.length > 0) {
        await tx.userRole.createMany({
          data: newRoles.map((roleId) => ({
            tenantId,
            userId,
            roleId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.userRole.findMany({
        where: { tenantId, userId },
        include: {
          role: {
            include: {
              rolePermissions: {
                include: { permission: true },
              },
            },
          },
        },
      });
    });
  }
}
