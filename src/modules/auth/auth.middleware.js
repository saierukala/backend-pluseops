import { verifyAccessToken } from './jwt.util.js';
import { AppError } from '../../common/errors/app-error.js';
import { AuthRepository } from './auth.repository.js';
import { getPrismaClient } from '../../config/database.js';

const PLATFORM_TENANT_SLUG = '__platform';

export function authenticate() {
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
