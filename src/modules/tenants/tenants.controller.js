import { logPlatformAction, platformActorFrom } from '../platform-ops/platform-audit.js';
import { TenantService } from './tenants.service.js';

const tenantService = new TenantService();

export async function createTenant(req, res, next) {
  try {
    const tenant = await tenantService.create(req.body);
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.create', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { name: tenant.name, slug: tenant.slug, plan: tenant.plan, via: 'legacy' } });
    res.status(201).json({
      success: true,
      data: tenant,
      message: 'Tenant created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getTenant(req, res, next) {
  try {
    const tenant = await tenantService.getById(req.params.id);
    res.status(200).json({
      success: true,
      data: tenant,
      message: 'Tenant retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateTenant(req, res, next) {
  try {
    const tenant = await tenantService.update(req.params.id, req.body);
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.update', targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id, details: { changes: req.body, via: 'legacy' } });
    res.status(200).json({
      success: true,
      data: tenant,
      message: 'Tenant updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteTenant(req, res, next) {
  try {
    await tenantService.delete(req.params.id);
    // The tenant row is gone, so it is referenced in details only
    await logPlatformAction(platformActorFrom(req), { action: 'tenant.delete', targetType: 'tenant', targetId: req.params.id, details: { tenantId: req.params.id, via: 'legacy' } });
    res.status(200).json({
      success: true,
      data: null,
      message: 'Tenant deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}