import { PlatformService } from './platform.service.js';

const platformService = new PlatformService();

export async function listTenants(req, res, next) {
  try {
    const result = await platformService.listTenants(req.query);
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Tenants retrieved successfully' });
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
      res.status(201).json({ success: true, data: result, message: 'Tenant and admin created successfully' });
    } else {
      const tenant = await platformService.createTenantOnly(req.body);
      res.status(201).json({ success: true, data: tenant, message: 'Tenant created successfully' });
    }
  } catch (error) { next(error); }
}

export async function updateTenant(req, res, next) {
  try {
    const tenant = await platformService.updateTenant(req.params.id, req.body);
    res.status(200).json({ success: true, data: tenant, message: 'Tenant updated successfully' });
  } catch (error) { next(error); }
}

export async function updateTenantStatus(req, res, next) {
  try {
    const tenant = await platformService.updateTenantStatus(req.params.id, req.body.status);
    res.status(200).json({ success: true, data: tenant, message: 'Tenant status updated successfully' });
  } catch (error) { next(error); }
}

export async function createTenantAdmin(req, res, next) {
  try {
    const admin = await platformService.createTenantAdmin(req.params.id, req.body);
    res.status(201).json({ success: true, data: admin, message: 'Tenant admin created successfully' });
  } catch (error) { next(error); }
}
