import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';

export const LIMIT_KEYS = ['users', 'products', 'warehouses', 'ordersPerMonth'];
// The internal __platform tenant's plan; never listed or assigned through the API.
export const RESERVED_PLAN = 'platform';

const planNotFound = (code) => new AppError(`Plan ${code} does not exist`, { statusCode: 400, code: 'PLAN_NOT_FOUND' });

export function toPlan(p) {
  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = p.limits?.[key] ?? null;
  return { id: p.id, code: p.code, name: p.name, description: p.description, limits, isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

/** Tenants may only be put on an existing, active, non-reserved plan. */
export async function assertAssignablePlan(code) {
  if (code === undefined) return;
  if (code === RESERVED_PLAN) throw new AppError('This plan is reserved', { statusCode: 400, code: 'PLAN_RESERVED' });
  const plan = await getPrismaClient().plan.findUnique({ where: { code } });
  if (!plan) throw planNotFound(code);
  if (!plan.isActive) throw new AppError(`Plan ${code} is not active`, { statusCode: 400, code: 'PLAN_INACTIVE' });
}

function startOfMonthUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const COUNTERS = {
  users: (prisma, tenantId) => prisma.tenantMembership.count({ where: { tenantId, status: 'ACTIVE' } }),
  products: (prisma, tenantId) => prisma.product.count({ where: { tenantId, deletedAt: null } }),
  warehouses: (prisma, tenantId) => prisma.warehouse.count({ where: { tenantId } }),
  ordersPerMonth: (prisma, tenantId) => prisma.order.count({ where: { tenantId, createdAt: { gte: startOfMonthUtc() } } }),
};

export async function usageOf(tenantId) {
  const prisma = getPrismaClient();
  const counts = await Promise.all(LIMIT_KEYS.map((key) => COUNTERS[key](prisma, tenantId)));
  return Object.fromEntries(LIMIT_KEYS.map((key, i) => [key, counts[i]]));
}

/**
 * Throws 403 PLAN_LIMIT_REACHED when creating one more `resource` would exceed the tenant's plan.
 * Soft limit: two concurrent creates at the boundary can both pass. No plan row or a null limit = unlimited.
 */
export async function assertWithinPlan(tenantId, resource) {
  const prisma = getPrismaClient();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const plan = tenant && await prisma.plan.findUnique({ where: { code: tenant.plan } });
  const limit = plan?.limits?.[resource];
  if (limit === null || limit === undefined) return;
  const used = await COUNTERS[resource](prisma, tenantId);
  if (used >= limit) {
    throw new AppError(`Your ${plan.name} plan allows ${limit} ${resource === 'ordersPerMonth' ? 'orders per month' : resource}`, {
      statusCode: 403, code: 'PLAN_LIMIT_REACHED', details: { resource, limit, used, plan: plan.code },
    });
  }
}

export class PlanService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async list({ includeInactive = false } = {}) {
    const plans = await this.prisma.plan.findMany({
      where: { code: { not: RESERVED_PLAN }, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { createdAt: 'asc' },
    });
    const tenants = await this.prisma.tenant.groupBy({ by: ['plan'], where: { slug: { not: '__platform' } }, _count: { _all: true } });
    const byPlan = new Map(tenants.map((t) => [t.plan, t._count._all]));
    return plans.map((p) => ({ ...toPlan(p), tenantCount: byPlan.get(p.code) ?? 0 }));
  }

  async create(data) {
    if (data.code === RESERVED_PLAN) throw new AppError('This plan code is reserved', { statusCode: 400, code: 'PLAN_RESERVED' });
    try {
      return toPlan(await this.prisma.plan.create({ data: { code: data.code, name: data.name, description: data.description ?? null, limits: data.limits ?? {}, isActive: data.isActive ?? true } }));
    } catch (err) {
      if (err?.code === 'P2002') throw new AppError('A plan with this code already exists', { statusCode: 409, code: 'PLAN_EXISTS' });
      throw err;
    }
  }

  async update(code, data) {
    const existing = await this.prisma.plan.findUnique({ where: { code } });
    if (!existing || code === RESERVED_PLAN) throw new AppError('Plan not found', { statusCode: 404, code: 'PLAN_NOT_FOUND' });
    const limits = data.limits ? { ...existing.limits, ...data.limits } : undefined;
    return { before: toPlan(existing), after: toPlan(await this.prisma.plan.update({ where: { code }, data: { name: data.name, description: data.description, isActive: data.isActive, limits } })) };
  }
}

export const planService = new PlanService();
