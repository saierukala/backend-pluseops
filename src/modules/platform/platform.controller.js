import { platformOpsService } from '../platform-ops/platform-ops.service.js';
import { logPlatformAction, platformActorFrom } from '../platform-ops/platform-audit.js';
import { PlatformService } from './platform.service.js';

const platformService = new PlatformService();

export async function listTenants(req, res, next) {
  try {
    const result = await platformService.listTenants(req.query);
    const stats = await platformOpsService.tenantListStats(result.data.map((t) => t.id));
    const data = result.data.map((t) => ({ ...t, ...stats.get(t.id) }));
    res.status(200).json({ success: true, data, meta: result.meta, message: 'Tenants retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getTenant(req, res, next) {
  try {
    const tenant = await platformService.getTenantById(req.params.id);
    res.status(200).json({ success: true, data: tenant, message: 'Tenant retrieved successfully' });
  } catch (error) { next(error); }
}

export async function createTenant(req, res, next) {
  try {
    // Support both with-admin and without-admin flows; if admin present create atomic
    if (req.body.admin) {
      const result = await platformService.createTenantWithAdmin(req.body);
      await logPlatformAction(platformActorFrom(req), { action: 'tenant.create', targetType: 'tenant', targetId: result.tenant.id, tenantId: result.tenant.id, details: { name: result.tenant.name, slug: result.tenant.slug, plan: result.tenant.plan, adminEmail: result.adminUser.email } });
      res.status(201).json({ success: true, data: result, message: 'Tenant and admin created successfully' });
    } else {
      const tenant = await platformService.createTenantOnly(req.body);
      await logPlatformAction(platformActorFrom(req), { action: 'tenant.create', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { name: tenant.name, slug: tenant.slug, plan: tenant.plan } });
      res.status(201).json({ success: true, data: tenant, message: 'Tenant created successfully' });
    }
  } catch (error) { next(error); }
}

export async function updateTenant(req, res, next) {
  try {
    const tenant = await platformService.updateTenant(req.params.id, req.body);
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.update', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { changes: req.body } });
    res.status(200).json({ success: true, data: tenant, message: 'Tenant updated successfully' });
  } catch (error) { next(error); }
}

export async function updateTenantStatus(req, res, next) {
  try {
    const tenant = await platformService.updateTenantStatus(req.params.id, req.body.status);
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.status', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { status: req.body.status } });
    res.status(200).json({ success: true, data: tenant, message: 'Tenant status updated successfully' });
  } catch (error) { next(error); }
}

export async function createTenantAdmin(req, res, next) {
  try {
    const admin = await platformService.createTenantAdmin(req.params.id, req.body);
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.admin.create', targetType: 'user', targetId: admin.id, tenantId: req.params.id, details: { email: admin.email } });
    res.status(201).json({ success: true, data: admin, message: 'Tenant admin created successfully' });
  } catch (error) { next(error); }
}
