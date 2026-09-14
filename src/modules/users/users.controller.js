import { UserService } from './users.service.js';

const userService = new UserService();

export async function listUsers(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, search, status, roleId, sortBy, sortOrder } = req.query;

    const result = await userService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      search,
      status,
      roleId,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Users retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getUser(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;

    const user = await userService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: user,
      message: 'User retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const auditContext = {
      actorUserId: req.context.userId,
      ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
      userAgent: req.headers['user-agent'] || null,
    };
    const user = await userService.update(id, tenantId, req.body, auditContext);
    res.status(200).json({
      success: true,
      data: user,
      message: 'User updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const currentUserId = req.context.userId;

    // Prevent self-deletion
    if (id === currentUserId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SELF_DELETION_FORBIDDEN',
          message: 'Cannot delete your own account',
        },
      });
    }

    const auditContext = {
      actorUserId: req.context.userId,
      ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
      userAgent: req.headers['user-agent'] || null,
    };
    await userService.delete(id, tenantId, auditContext);
    res.status(200).json({
      success: true,
      data: null,
      message: 'User deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

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