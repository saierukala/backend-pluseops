import { TenantService } from './tenants.service.js';

const tenantService = new TenantService();

export async function createTenant(req, res, next) {
  try {
    const tenant = await tenantService.create(req.body);
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
    res.status(200).json({
      success: true,
      data: null,
      message: 'Tenant deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}