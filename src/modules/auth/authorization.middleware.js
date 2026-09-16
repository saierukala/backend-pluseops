import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { getCacheService } from '../../common/cache/cache.service.js';
import { userPermissionsKey } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';

export function authorize(permission) {
  return async (req, res, next) => {
    try {
      if (!req.context || !req.context.userId || !req.context.tenantId) {
        throw new AppError('Authentication required', {
          statusCode: 401,
          code: 'UNAUTHORIZED',
        });
      }

      const { userId, tenantId } = req.context;
      const prisma = getPrismaClient();

      const membership = await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { status: true },
      });
      if (!membership || membership.status !== 'ACTIVE') {
        throw new AppError('Tenant membership is required', { statusCode: 403, code: 'FORBIDDEN' });
      }

      const permissions = await getUserPermissions(userId, tenantId);

      const hasPermission = permissions.some(
        (p) => p.resource === permission.split(':')[0] && p.action === permission.split(':')[1]
      );

      if (!hasPermission) {
        throw new AppError('Insufficient permissions', {
          statusCode: 403,
          code: 'FORBIDDEN',
        });
      }

      next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      next(error);
    }
  };
}

export async function invalidateUserPermissionsCache(tenantId, userId) {
  try {
    const cache = getCacheService();
    await cache.del(userPermissionsKey(tenantId, userId));
  } catch (error) {
    logger.warn({ err: error, tenantId, userId }, 'User permissions cache invalidation failed');
  }
}

export async function invalidateTenantPermissionsCache(tenantId) {
  try {
    const cache = getCacheService();
    await cache.delByPattern(`${userPermissionsKey(tenantId, '00000000-0000-0000-0000-000000000000').split(':user:')[0]}:user:*`);
  } catch (error) {
    logger.warn({ err: error, tenantId }, 'Tenant permissions cache invalidation failed');
  }
}

// Platform permissions are deliberately separate from tenant roles. Future
// /platform routes must use this middleware, never tenant authorize().
export function authorizePlatform(permission) {
  return async (req, res, next) => {
    try {
      const userId = req.context?.userId;
      if (!userId) throw new AppError('Authentication required', { statusCode: 401, code: 'UNAUTHORIZED' });
      const separator = permission.lastIndexOf(':');
      const resource = permission.slice(0, separator);
      const action = permission.slice(separator + 1);
      const grant = await getPrismaClient().platformUserRole.findFirst({
        where: { userId, role: { permissions: { some: { permission: { resource, action } } } } },
      });
      if (!grant) throw new AppError('Insufficient platform permissions', { statusCode: 403, code: 'FORBIDDEN' });
      next();
    } catch (error) { next(error); }
  };
}

export async function getUserPermissions(userId, tenantId) {
  const cache = getCacheService();
  const cacheKey = userPermissionsKey(tenantId, userId);

  try {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  } catch (error) {
    logger.warn({ err: error, key: cacheKey }, 'User permissions cache GET failed');
  }

  const prisma = getPrismaClient();

  const userRoles = await prisma.userRole.findMany({
    where: { userId, tenantId },
    select: { roleId: true },
  });

  if (userRoles.length === 0) {
    const empty = [];
    try {
      await cache.set(cacheKey, empty, CACHE_TTL.PERMISSIONS_USER);
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'User permissions cache SET failed');
    }
    return [];
  }

  const roleIds = userRoles.map((ur) => ur.roleId);

  const rolePermissions = await prisma.rolePermission.findMany({
    where: {
      tenantId,
      roleId: { in: roleIds },
    },
    include: {
      permission: true,
    },
  });

  const result = rolePermissions.map((rp) => ({
    id: rp.permission.id,
    name: rp.permission.name,
    resource: rp.permission.resource,
    action: rp.permission.action,
    description: rp.permission.description,
  }));

  try {
    await cache.set(cacheKey, result, CACHE_TTL.PERMISSIONS_USER);
  } catch (error) {
    logger.warn({ err: error, key: cacheKey }, 'User permissions cache SET failed');
  }

  return result;
}
