import { PermissionService } from './permissions.service.js';

const permissionService = new PermissionService();

export async function listPermissions(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const permissions = await permissionService.list(tenantId);
    res.status(200).json({
      success: true,
      data: permissions,
      message: 'Permissions retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getPermission(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const permission = await permissionService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: permission,
      message: 'Permission retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}