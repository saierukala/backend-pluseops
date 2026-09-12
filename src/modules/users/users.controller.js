import { UserService } from './users.service.js';

const userService = new UserService();

export async function getUserRoles(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;

    const roles = await userService.getUserRoles(id, tenantId);
    res.status(200).json({
      success: true,
      data: roles,
      message: 'User roles retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function assignRoles(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const { roleIds } = req.body;

    const roles = await userService.assignRoles(id, tenantId, roleIds);
    res.status(200).json({
      success: true,
      data: roles,
      message: 'Roles assigned successfully',
    });
  } catch (error) {
    next(error);
  }
}