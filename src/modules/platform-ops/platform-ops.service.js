import { Prisma } from '@prisma/client';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { hashPassword } from '../auth/password.util.js';
import { toPlan, usageOf } from '../plans/plans.service.js';

const PLATFORM_TENANT_SLUG = '__platform';
const DEFAULT_PLATFORM_ROLE = 'platform_admin';

const adminSelect = {
  id: true, email: true, firstName: true, lastName: true, status: true, lastLoginAt: true, createdAt: true,
  platformUserRoles: { select: { role: { select: { id: true, name: true } } } },
};
const latest = (...dates) => dates.filter(Boolean).sort((a, b) => b - a)[0] ?? null;

const toAdmin = (u) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, roles: u.platformUserRoles.map((r) => r.role) });

export class PlatformOpsService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  // ── Platform admins ──────────────────────────────────────────────────

  async listRoles() {
    const roles = await this.prisma.platformRole.findMany({
      orderBy: { name: 'asc' },
      include: { permissions: { include: { permission: { select: { name: true } } } }, _count: { select: { userRoles: true } } },
    });
    return roles.map((r) => ({ id: r.id, name: r.name, description: r.description, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.name).sort(), adminCount: r._count.userRoles }));
  }

  async listAdmins() {
    const users = await this.prisma.user.findMany({ where: { platformUserRoles: { some: {} } }, select: adminSelect, orderBy: { createdAt: 'asc' } });
    return users.map(toAdmin);
  }

  /** Creates a platform admin with an initial password the inviter shares out of band (change it on first login). */
  async addAdmin({ email, password, firstName, lastName, roleId }) {
    const role = roleId
      ? await this.prisma.platformRole.findUnique({ where: { id: roleId } })
      : await this.prisma.platformRole.findUnique({ where: { name: DEFAULT_PLATFORM_ROLE } });
    if (!role) throw new AppError(roleId ? 'Platform role not found' : 'No default platform role; pass roleId', { statusCode: 400, code: 'PLATFORM_ROLE_NOT_FOUND' });
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new AppError('This email already has an account', { statusCode: 409, code: 'USER_ALREADY_EXISTS' });
    }
    const platformTenant = await this.prisma.tenant.upsert({
      where: { slug: PLATFORM_TENANT_SLUG }, update: {}, create: { name: 'Platform', slug: PLATFORM_TENANT_SLUG, status: 'ACTIVE', plan: 'platform' },
    });
    const user = await this.prisma.user.create({
      data: {
        tenantId: platformTenant.id, email, passwordHash: await hashPassword(password), firstName, lastName, status: 'ACTIVE', emailVerified: true,
        memberships: { create: { tenantId: platformTenant.id, status: 'ACTIVE' } },
        platformUserRoles: { create: { roleId: role.id } },
      },
      select: adminSelect,
    });
    return toAdmin(user);
  }

  /**
   * Takes away platform access: roles removed, account deactivated, sessions and support sessions ended.
   * The caller holds platform:admin:manage and can't remove themselves, so at least one manager always remains.
   */
  async removeAdmin(actorId, userId) {
    if (actorId === userId) throw new AppError('You cannot remove your own platform access', { statusCode: 409, code: 'CANNOT_REMOVE_SELF' });
    const target = await this.prisma.user.findFirst({ where: { id: userId, platformUserRoles: { some: {} } }, select: adminSelect });
    if (!target) throw new AppError('Platform admin not found', { statusCode: 404, code: 'PLATFORM_ADMIN_NOT_FOUND' });
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.platformUserRole.deleteMany({ where: { userId } }),
      this.prisma.user.update({ where: { id: userId }, data: { status: 'INACTIVE' } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.supportSession.updateMany({ where: { platformUserId: userId, endedAt: null }, data: { endedAt: now } }),
    ]);
    return toAdmin(target);
  }

  // ── Usage ────────────────────────────────────────────────────────────

  async tenantUsage(tenantId) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.slug === PLATFORM_TENANT_SLUG) throw new AppError('Tenant not found', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
    const [plan, usage, stats] = await Promise.all([
      this.prisma.plan.findUnique({ where: { code: tenant.plan } }),
      usageOf(tenantId),
      this.tenantListStats([tenantId]),
    ]);
    return { tenantId, plan: plan ? toPlan(plan) : { code: tenant.plan, limits: null }, usage, lastActivityAt: stats.get(tenantId).lastActivityAt };
  }

  /** Active users and last activity (latest activity-log entry or user sign-in) per tenant. */
  async tenantListStats(tenantIds) {
    if (tenantIds.length === 0) return new Map();
    const [members, activity, logins] = await Promise.all([
      this.prisma.tenantMembership.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenantIds }, status: 'ACTIVE' }, _count: { _all: true } }),
      this.prisma.activityLog.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenantIds } }, _max: { createdAt: true } }),
      this.prisma.user.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenantIds } }, _max: { lastLoginAt: true } }),
    ]);
    const stats = new Map(tenantIds.map((id) => [id, { usersCount: 0, lastActivityAt: null }]));
    for (const m of members) stats.get(m.tenantId).usersCount = m._count._all;
    for (const a of activity) stats.get(a.tenantId).lastActivityAt = a._max.createdAt;
    for (const l of logins) stats.get(l.tenantId).lastActivityAt = latest(stats.get(l.tenantId).lastActivityAt, l._max.lastLoginAt);
    return stats;
  }

  async overview() {
    const prisma = this.prisma;
    const notPlatform = { slug: { not: PLATFORM_TENANT_SLUG } };
    const since30d = new Date(Date.now() - 30 * 86400000);
    const yearAgo = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1));
    const [byStatus, byPlan, users, ordersTotal, orders30d, revenue, revenue30d, growth] = await Promise.all([
      prisma.tenant.groupBy({ by: ['status'], where: notPlatform, _count: { _all: true } }),
      prisma.tenant.groupBy({ by: ['plan'], where: notPlatform, _count: { _all: true } }),
      prisma.tenantMembership.count({ where: { status: 'ACTIVE', tenant: notPlatform } }),
      prisma.order.count(),
      prisma.order.count({ where: { createdAt: { gte: since30d } } }),
      prisma.payment.groupBy({ by: ['currency'], where: { status: 'COMPLETED', deletedAt: null }, _sum: { amount: true } }),
      prisma.payment.groupBy({ by: ['currency'], where: { status: 'COMPLETED', deletedAt: null, createdAt: { gte: since30d } }, _sum: { amount: true } }),
      prisma.$queryRaw(Prisma.sql`SELECT to_char(date_trunc('month', "created_at" AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, COUNT(*)::int AS count
        FROM "tenants" WHERE "slug" <> ${PLATFORM_TENANT_SLUG} AND "created_at" >= ${yearAgo} GROUP BY 1 ORDER BY 1`),
    ]);
    const tenantsByStatus = Object.fromEntries(['ACTIVE', 'TRIAL', 'SUSPENDED', 'CANCELLED'].map((s) => [s, 0]));
    for (const row of byStatus) tenantsByStatus[row.status] = row._count._all;
    const money = (rows) => rows.map((r) => ({ currency: r.currency, amount: (r._sum.amount ?? 0).toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
    return {
      tenants: {
        total: Object.values(tenantsByStatus).reduce((a, b) => a + b, 0),
        byStatus: tenantsByStatus,
        byPlan: Object.fromEntries(byPlan.map((r) => [r.plan, r._count._all])),
        newByMonth: growth,
      },
      users: { active: users },
      orders: { total: ordersTotal, last30Days: orders30d },
      // Per currency: tenants sell in different currencies, so there is no single platform total
      revenue: { total: money(revenue), last30Days: money(revenue30d) },
    };
  }
}

export const platformOpsService = new PlatformOpsService();
