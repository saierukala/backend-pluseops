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

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      roleId,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = {
      memberships: { some: { tenantId, status: 'ACTIVE' } },
    };

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (roleId) {
      where.userRoles = { some: { tenantId, roleId } };
    }

    const allowedSortFields = ['createdAt', 'updatedAt', 'email', 'firstName', 'lastName', 'status'];
    const allowedSortOrders = ['asc', 'desc'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const safeSortOrder = allowedSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          tenantId: true,
          email: true,
          firstName: true,
          lastName: true,
          status: true,
          emailVerified: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          userRoles: {
            where: { tenantId },
            include: {
              role: {
                select: { id: true, name: true, isSystem: true },
              },
            },
          },
        },
        orderBy: { [safeSortBy]: safeSortOrder },
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async findById(id, tenantId) {
    return this.prisma.user.findFirst({
      where: { id, memberships: { some: { tenantId, status: 'ACTIVE' } } },
      select: {
        id: true,
        tenantId: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        emailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        userRoles: {
          where: { tenantId },
          include: {
            role: {
              select: { id: true, name: true, isSystem: true },
            },
          },
        },
      },
    });
  }

  async update(id, tenantId, data) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        tenantId: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        emailVerified: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.user.delete({
      where: { id },
    });
  }

  async existsByEmailAndTenant(email, tenantId, excludeId = null) {
    const where = {
      email,
      memberships: { some: { tenantId, status: 'ACTIVE' } },
    };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    const user = await this.prisma.user.findFirst({ where, select: { id: true } });
    return !!user;
  }
}