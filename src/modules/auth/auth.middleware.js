import { verifyAccessToken } from './jwt.util.js';
import { AppError } from '../../common/errors/app-error.js';
import { AuthRepository } from './auth.repository.js';
import { getPrismaClient } from '../../config/database.js';
import { supportService } from '../support/support.service.js';

const PLATFORM_TENANT_SLUG = '__platform';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Phase 28: an access token is only valid while its login session still holds a live refresh token,
 * so logout, session revocation, logout-all and password changes take effect immediately.
 */
async function assertSessionActive(repo, decoded) {
  if (!UUID_RE.test(decoded.sessionId)) {
    throw new AppError('Invalid token claims', { statusCode: 401, code: 'INVALID_TOKEN_CLAIMS' });
  }
  if (!(await repo.isSessionActive(decoded.sessionId, decoded.sub))) {
    throw new AppError('Session has ended. Please sign in again.', { statusCode: 401, code: 'SESSION_REVOKED' });
  }
}

/**
 * Phase 30: a platform admin's read-only support token for one tenant (see support.service.js).
 * Writes are refused outright; every request is recorded in the tenant's activity log.
 */
async function authenticateSupport(req, res, decoded) {
  if (!UUID_RE.test(decoded.sessionId) || !decoded.tenantId) {
    throw new AppError('Invalid token claims', { statusCode: 401, code: 'INVALID_TOKEN_CLAIMS' });
  }
  const session = await supportService.findActive(decoded);
  if (!session) throw new AppError('Support session has ended', { statusCode: 401, code: 'SESSION_REVOKED' });
  req.context = req.context || {};
  req.context.userId = decoded.sub;
  req.context.tenantId = decoded.tenantId;
  req.context.sessionId = decoded.sessionId;
  req.context.email = decoded.email;
  req.context.scope = 'support';
  req.context.support = { sessionId: session.id, readOnly: true };
  // Logged before the read-only check so refused write attempts are recorded too
  res.on('finish', () => supportService.logRequest(req, res.statusCode));
  if (!READ_METHODS.has(req.method)) {
    throw new AppError('Support sessions are read-only', { statusCode: 403, code: 'SUPPORT_READ_ONLY' });
  }
}

/** `allowSupport: false` keeps support tokens out of endpoints about a user's own account. */
export function authenticate({ allowSupport = true } = {}) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AppError('Authentication required', {
          statusCode: 401,
          code: 'UNAUTHORIZED',
        });
      }

      const token = authHeader.substring(7);
      const decoded = verifyAccessToken(token);

      // Validate required claims (tenantId required for tenant scope, scope may be missing for legacy tokens treated as tenant)
      if (!decoded.sub || !decoded.sessionId) {
        throw new AppError('Invalid token claims', {
          statusCode: 401,
          code: 'INVALID_TOKEN_CLAIMS',
        });
      }
      const scope = decoded.scope || 'tenant';
      if (scope === 'support') {
        if (!allowSupport) throw new AppError('Support sessions cannot use this endpoint', { statusCode: 403, code: 'SUPPORT_TOKEN_FORBIDDEN' });
        await authenticateSupport(req, res, decoded);
        return next();
      }
      if (scope === 'platform') {
        throw new AppError('Platform token cannot access tenant resources', {
          statusCode: 403,
          code: 'PLATFORM_TOKEN_FORBIDDEN',
        });
      }
      if (!decoded.tenantId) {
        throw new AppError('Invalid token claims', {
          statusCode: 401,
          code: 'INVALID_TOKEN_CLAIMS',
        });
      }

      // Verify user exists and is active within tenant
      const repo = new AuthRepository();
      await assertSessionActive(repo, decoded);
      const user = await repo.findUserByIdAndTenant(decoded.sub, decoded.tenantId);
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('User not found or inactive', {
          statusCode: 401,
          code: 'USER_NOT_FOUND',
        });
      }

      // Validate tenant is active and not platform tenant
      const tenant = user.memberships[0]?.tenant;
      if (!tenant || (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL')) {
        throw new AppError('Tenant is not active', {
          statusCode: 403,
          code: 'TENANT_INACTIVE',
        });
      }
      if (tenant.slug === PLATFORM_TENANT_SLUG) {
        throw new AppError('Platform tenant cannot be used for tenant resources', {
          statusCode: 403,
          code: 'PLATFORM_TENANT_FORBIDDEN',
        });
      }

      req.context = req.context || {};
      req.context.userId = decoded.sub;
      req.context.tenantId = decoded.tenantId;
      req.context.sessionId = decoded.sessionId;
      req.context.email = decoded.email;
      req.context.scope = scope;

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError('Access token has expired', {
          statusCode: 401,
          code: 'TOKEN_EXPIRED',
        }));
      }
      if (error.name === 'JsonWebTokenError') {
        return next(new AppError('Invalid access token', {
          statusCode: 401,
          code: 'INVALID_TOKEN',
        }));
      }
      next(error);
    }
  };
}

export function authenticatePlatform() {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AppError('Authentication required', {
          statusCode: 401,
          code: 'UNAUTHORIZED',
        });
      }
      const token = authHeader.substring(7);
      const decoded = verifyAccessToken(token);

      if (!decoded.sub || !decoded.sessionId) {
        throw new AppError('Invalid token claims', {
          statusCode: 401,
          code: 'INVALID_TOKEN_CLAIMS',
        });
      }
      const scope = decoded.scope || 'tenant';
      if (scope !== 'platform') {
        throw new AppError('Platform authentication required', {
          statusCode: 403,
          code: 'PLATFORM_AUTH_REQUIRED',
        });
      }
      if (!decoded.tenantId) {
        throw new AppError('Invalid token claims', {
          statusCode: 401,
          code: 'INVALID_TOKEN_CLAIMS',
        });
      }

      await assertSessionActive(new AuthRepository(), decoded);

      // Verify user has platform role
      const prisma = getPrismaClient();
      const platformGrant = await prisma.platformUserRole.findFirst({
        where: { userId: decoded.sub },
      });
      if (!platformGrant) {
        throw new AppError('Platform access denied', {
          statusCode: 403,
          code: 'PLATFORM_ACCESS_DENIED',
        });
      }
      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('User not found or inactive', {
          statusCode: 401,
          code: 'USER_NOT_FOUND',
        });
      }

      req.context = req.context || {};
      req.context.userId = decoded.sub;
      req.context.tenantId = decoded.tenantId;
      req.context.sessionId = decoded.sessionId;
      req.context.email = decoded.email;
      req.context.scope = 'platform';

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError('Access token has expired', {
          statusCode: 401,
          code: 'TOKEN_EXPIRED',
        }));
      }
      if (error.name === 'JsonWebTokenError') {
        return next(new AppError('Invalid access token', {
          statusCode: 401,
          code: 'INVALID_TOKEN',
        }));
      }
      next(error);
    }
  };
}

// Optional authentication - doesn't throw if no token
/** Accepts tenant or platform tokens — for endpoints about the caller's own account. */
export function authenticateAnyScope() {
  const tenant = authenticate({ allowSupport: false });
  const platform = authenticatePlatform();
  return (req, res, next) => {
    let scope = 'tenant';
    try {
      const header = req.headers.authorization ?? '';
      if (header.startsWith('Bearer ')) scope = verifyAccessToken(header.substring(7)).scope || 'tenant';
    } catch {
      // Let the tenant middleware produce the standard invalid/expired token error
    }
    return (scope === 'platform' ? platform : tenant)(req, res, next);
  };
}

export function optionalAuthenticate() {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next();
      }

      const token = authHeader.substring(7);
      const decoded = verifyAccessToken(token);
      const scope = decoded.scope || 'tenant';

      if (decoded.sub && decoded.tenantId && decoded.sessionId) {
        if (scope === 'platform') {
          // Do not populate tenant context for optional platform token
          req.context = req.context || {};
          req.context.userId = decoded.sub;
          req.context.tenantId = decoded.tenantId;
          req.context.sessionId = decoded.sessionId;
          req.context.email = decoded.email;
          req.context.scope = 'platform';
        } else {
          const repo = new AuthRepository();
          const user = await repo.findUserByIdAndTenant(decoded.sub, decoded.tenantId);
          const tenant = user?.memberships[0]?.tenant;
          if (user && user.status === 'ACTIVE' && tenant &&
              (tenant.status === 'ACTIVE' || tenant.status === 'TRIAL') && tenant.slug !== PLATFORM_TENANT_SLUG) {
            req.context = req.context || {};
            req.context.userId = decoded.sub;
            req.context.tenantId = decoded.tenantId;
            req.context.sessionId = decoded.sessionId;
            req.context.email = decoded.email;
            req.context.scope = 'tenant';
          }
        }
      }
    } catch {
      // Ignore errors for optional authentication
    }
    next();
  };
}
