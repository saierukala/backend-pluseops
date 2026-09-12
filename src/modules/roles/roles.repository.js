import { getPrismaClient } from '../../config/database.js';

export class RoleRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findById(id, tenantId) {
    return this.prisma.role.findFirst({
      where: { id, tenantId },
      include: {
        rolePermissions: {
          include: {
            permission: true,
          },
        },
      },
    });
  }

  async findByName(name, tenantId) {
    return this.prisma.role.findFirst({
      where: { name, tenantId },
    });
  }

  async findMany(tenantId, { skip = 0, take = 50 } = {}) {
    return this.prisma.role.findMany({
      where: { tenantId },
      include: {
        rolePermissions: {
          include: {
            permission: true,
          },
        },
        _count: {
          select: { userRoles: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take,
    });
  }

  async count(tenantId) {
    return this.prisma.role.count({ where: { tenantId } });
  }

  async create(data) {
    return this.prisma.role.create({
      data: {
        tenantId: data.tenantId,
        name: data.name,
        description: data.description,
        isSystem: false,
      },
      include: {
        rolePermissions: {
          include: {
            permission: true,
          },
        },
      },
    });
  }

  async update(id, tenantId, data) {
    return this.prisma.role.update({
      where: { id, tenantId },
      data: {
        name: data.name,
        description: data.description,
      },
      include: {
        rolePermissions: {
          include: {
            permission: true,
          },
        },
      },
    });
  }

  async delete(id, tenantId) {
    return this.prisma.role.delete({
      where: { id, tenantId },
    });
  }

  async assignPermissions(roleId, tenantId, permissionIds) {
    return this.prisma.$transaction(async (tx) => {
      // Validate that all permissions exist and belong to the tenant
      const permissions = await tx.permission.findMany({
        where: {
          id: { in: permissionIds },
          tenantId,
        },
        select: { id: true },
      });

      const validPermissionIds = new Set(permissions.map((p) => p.id));
      const validPermissionIdsList = permissionIds.filter((id) => validPermissionIds.has(id));

      const existing = await tx.rolePermission.findMany({
        where: {
          tenantId,
          roleId,
          permissionId: { in: validPermissionIdsList },
        },
        select: { permissionId: true },
      });

      const existingIds = new Set(existing.map((e) => e.permissionId));
      const newPermissions = validPermissionIdsList.filter((id) => !existingIds.has(id));

      if (newPermissions.length > 0) {
        await tx.rolePermission.createMany({
          data: newPermissions.map((permissionId) => ({
            tenantId,
            roleId,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.rolePermission.findMany({
        where: { tenantId, roleId },
        include: { permission: true },
      });
    });
  }

  async removePermission(roleId, tenantId, permissionId) {
    return this.prisma.rolePermission.deleteMany({
      where: { tenantId, roleId, permissionId },
    });
  }

  async isSystemRole(id, tenantId) {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId },
      select: { isSystem: true },
    });
    return role?.isSystem ?? false;
  }
}