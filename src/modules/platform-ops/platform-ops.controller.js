import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { platformOpsService as ops } from './platform-ops.service.js';
import { planService, assertAssignablePlan, toPlan } from '../plans/plans.service.js';
import { logPlatformAction, platformActorFrom, listPlatformAudit } from './platform-audit.js';

const ok = (res, data, message, status = 200, extra = {}) => res.status(status).json({ success: true, data, ...extra, message });
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

export const listRoles = handle(async (req, res) => ok(res, await ops.listRoles(), 'Platform roles retrieved'));
export const listAdmins = handle(async (req, res) => ok(res, await ops.listAdmins(), 'Platform admins retrieved'));
export const addAdmin = handle(async (req, res) => {
  const admin = await ops.addAdmin(req.body);
  await logPlatformAction(platformActorFrom(req), { action: 'platform_admin.create', targetType: 'user', targetId: admin.id, details: { email: admin.email, roles: admin.roles.map((r) => r.name) } });
  ok(res, admin, 'Platform admin created', 201);
});
export const removeAdmin = handle(async (req, res) => {
  const removed = await ops.removeAdmin(req.context.userId, req.params.userId);
  await logPlatformAction(platformActorFrom(req), { action: 'platform_admin.remove', targetType: 'user', targetId: removed.id, details: { email: removed.email } });
  ok(res, null, 'Platform access removed');
});

export const listPlans = handle(async (req, res) => ok(res, await planService.list(res.locals.query), 'Plans retrieved'));
export const createPlan = handle(async (req, res) => {
  const plan = await planService.create(req.body);
  await logPlatformAction(platformActorFrom(req), { action: 'plan.create', targetType: 'plan', targetId: plan.code, details: { name: plan.name, limits: plan.limits } });
  ok(res, plan, 'Plan created', 201);
});
export const updatePlan = handle(async (req, res) => {
  const { before, after } = await planService.update(req.params.code, req.body);
  await logPlatformAction(platformActorFrom(req), { action: 'plan.update', targetType: 'plan', targetId: after.code, details: { before, after } });
  ok(res, after, 'Plan updated');
});
export const assignPlan = handle(async (req, res) => {
  const prisma = getPrismaClient();
  const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
  if (!tenant || tenant.slug === '__platform') throw new AppError('Tenant not found', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
  await assertAssignablePlan(req.body.plan);
  await prisma.tenant.update({ where: { id: tenant.id }, data: { plan: req.body.plan } });
  await logPlatformAction(platformActorFrom(req), { action: 'tenant.plan', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { from: tenant.plan, to: req.body.plan } });
  const plan = await prisma.plan.findUnique({ where: { code: req.body.plan } });
  ok(res, { tenantId: tenant.id, plan: toPlan(plan) }, 'Plan assigned');
});

export const tenantUsage = handle(async (req, res) => ok(res, await ops.tenantUsage(req.params.id), 'Usage retrieved'));
export const overview = handle(async (req, res) => ok(res, await ops.overview(), 'Platform overview retrieved'));

export const listAudit = handle(async (req, res) => {
  const result = await listPlatformAudit(res.locals.query);
  ok(res, result.data, 'Platform audit log retrieved', 200, { meta: result.meta });
});
