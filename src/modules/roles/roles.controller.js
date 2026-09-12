import { RoleService } from './roles.service.js';

const roleService = new RoleService();

export async function listRoles(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;

    const result = await roleService.list(tenantId, { page, limit });
    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Roles retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getRole(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;

    const role = await roleService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: role,
      message: 'Role retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function createRole(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const role = await roleService.create(tenantId, req.body);
    res.status(201).json({
      success: true,
      data: role,
      message: 'Role created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateRole(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const role = await roleService.update(id, tenantId, req.body);
    res.status(200).json({
      success: true,
      data: role,
      message: 'Role updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteRole(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const result = await roleService.delete(id, tenantId);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Role deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function assignPermissions(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const { permissionIds } = req.body;

    const permissions = await roleService.assignPermissions(id, tenantId, permissionIds);
    res.status(200).json({
      success: true,
      data: permissions,
      message: 'Permissions assigned successfully',
    });
  } catch (error) {
    next(error);
  }
}