import { verifyAccessToken } from './jwt.util.js';
import { AppError } from '../../common/errors/app-error.js';
import { AuthRepository } from './auth.repository.js';

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

      const token = authHeader.substring(7); // Remove 'Bearer '
      const decoded = verifyAccessToken(token);

      // Validate required claims
      if (!decoded.sub || !decoded.tenantId || !decoded.sessionId) {
        throw new AppError('Invalid token claims', {
          statusCode: 401,
          code: 'INVALID_TOKEN_CLAIMS',
        });
      }

      // Verify user exists and is active
      const repo = new AuthRepository();
      const user = await repo.findUserByIdAndTenant(decoded.sub, decoded.tenantId);
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('User not found or inactive', {
          statusCode: 401,
          code: 'USER_NOT_FOUND',
        });
      }

      // Validate tenant is active
      if (user.tenant.status !== 'ACTIVE' && user.tenant.status !== 'TRIAL') {
        throw new AppError('Tenant is not active', {
          statusCode: 403,
          code: 'TENANT_INACTIVE',
        });
      }

      // Set user context
      req.context = req.context || {};
      req.context.userId = decoded.sub;
      req.context.tenantId = decoded.tenantId;
      req.context.sessionId = decoded.sessionId;
      req.context.email = decoded.email;

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

      if (decoded.sub && decoded.tenantId && decoded.sessionId) {
        const repo = new AuthRepository();
        const user = await repo.findUserByIdAndTenant(decoded.sub, decoded.tenantId);
        if (user && user.status === 'ACTIVE' && 
            (user.tenant.status === 'ACTIVE' || user.tenant.status === 'TRIAL')) {
          req.context = req.context || {};
          req.context.userId = decoded.sub;
          req.context.tenantId = decoded.tenantId;
          req.context.sessionId = decoded.sessionId;
          req.context.email = decoded.email;
        }
      }
    } catch {
      // Ignore errors for optional authentication
    }
    next();
  };
}