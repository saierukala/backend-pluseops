import { verifyAccessToken } from '../modules/auth/jwt.util.js';
import { AuthRepository } from '../modules/auth/auth.repository.js';
import { logger } from '../config/logger.js';

function extractToken(socket) {
  // Token via auth payload (preferred)
  const authToken = socket.handshake?.auth?.token;
  if (authToken && typeof authToken === 'string') {
    // Allow "Bearer <token>" or raw token
    if (authToken.startsWith('Bearer ')) return authToken.slice(7);
    return authToken;
  }
  // Token via Authorization header
  const authHeader = socket.handshake?.headers?.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Token via query param (fallback, less secure but common)
  const queryToken = socket.handshake?.query?.token;
  if (queryToken && typeof queryToken === 'string') {
    return queryToken;
  }
  return null;
}

export async function socketAuthMiddleware(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) {
      logger.warn({ socketId: socket.id }, 'Socket auth failed: no token');
      const err = new Error('Authentication required');
      err.data = { code: 'UNAUTHORIZED' };
      return next(err);
    }

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        const err = new Error('Token expired');
        err.data = { code: 'TOKEN_EXPIRED' };
        return next(err);
      }
      if (e.name === 'JsonWebTokenError') {
        const err = new Error('Invalid token');
        err.data = { code: 'INVALID_TOKEN' };
        return next(err);
      }
      throw e;
    }

    const scope = decoded.scope || 'tenant';
    if (!decoded.sub || !decoded.tenantId || !decoded.sessionId) {
      const err = new Error('Invalid token claims');
      err.data = { code: 'INVALID_TOKEN_CLAIMS' };
      return next(err);
    }

    if (scope === 'platform') {
      // Platform socket: verify platform role
      const { getPrismaClient } = await import('../config/database.js');
      const prisma = getPrismaClient();
      const grant = await prisma.platformUserRole.findFirst({ where: { userId: decoded.sub } });
      if (!grant) {
        const err = new Error('Platform access denied');
        err.data = { code: 'PLATFORM_ACCESS_DENIED' };
        return next(err);
      }
      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user || user.status !== 'ACTIVE') {
        const err = new Error('User not found or inactive');
        err.data = { code: 'USER_NOT_FOUND' };
        return next(err);
      }
    } else {
      const repo = new AuthRepository();
      const user = await repo.findUserByIdAndTenant(decoded.sub, decoded.tenantId);
      if (!user || user.status !== 'ACTIVE') {
        const err = new Error('User not found or inactive');
        err.data = { code: 'USER_NOT_FOUND' };
        return next(err);
      }
      const tenant = user.memberships[0]?.tenant;
      if (!tenant || (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL')) {
        const err = new Error('Tenant is not active');
        err.data = { code: 'TENANT_INACTIVE' };
        return next(err);
      }
      if (tenant.slug === '__platform') {
        const err = new Error('Platform tenant forbidden');
        err.data = { code: 'PLATFORM_TENANT_FORBIDDEN' };
        return next(err);
      }
    }

    // Server-derived context only - never trust client-supplied tenantId/userId
    socket.context = {
      userId: decoded.sub,
      tenantId: decoded.tenantId,
      sessionId: decoded.sessionId,
      email: decoded.email,
      scope,
    };
    // Also set for backward compatibility
    socket.data = socket.data || {};
    socket.data.context = socket.context;

    return next();
  } catch (error) {
    logger.error({ err: error, socketId: socket.id }, 'Socket auth unexpected error');
    const err = new Error('Authentication failed');
    err.data = { code: 'AUTH_FAILED' };
    return next(err);
  }
}
