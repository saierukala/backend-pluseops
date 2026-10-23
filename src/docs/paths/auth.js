const error400 = { description: 'Validation error / invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized - invalid/expired token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden - tenant inactive', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error429 = { description: 'Too many requests - rate limited', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const authPaths = {
  '/api/v1/auth/register': {
    post: {
      tags: ['Auth'],
      summary: 'Register new user',
      description: 'Public. Rate-limited (auth limiter). tenantId optional; if omitted, uses default provisioning.',
      operationId: 'register',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password', 'firstName', 'lastName'],
              properties: {
                email: { type: 'string', format: 'email', example: 'user@example.com' },
                password: { type: 'string', minLength: 8, maxLength: 128, example: 'Str0ng!Pass', description: 'Requires uppercase, lowercase, digit, special char' },
                firstName: { type: 'string', minLength: 1, maxLength: 100, example: 'John' },
                lastName: { type: 'string', minLength: 1, maxLength: 100, example: 'Doe' },
                tenantId: { type: 'string', format: 'uuid', description: 'Optional tenant context' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Registration successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, accessToken: { type: 'string' }, refreshToken: { type: 'string' } } }, message: { type: 'string' } } } } } },
        400: error400,
        409: { description: 'Conflict - email already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login',
      description: 'Public. Rate-limited. Supports dual-scope authentication. Use scope=platform for Platform Admin (requires platform role). Use scope=tenant (default) for tenant users. Tenant login no longer requires manual tenantId; when omitted the server auto-resolves tenant via email (requires globally unique email). Legacy tenantId still accepted for backward compatibility. tenantSlug optional resolves tenant by slug without exposing UUID.',
      operationId: 'login',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string', minLength: 1 },
                scope: { type: 'string', enum: ['platform', 'tenant'], description: 'Authentication scope. platform=Platform Console, tenant=Tenant Console (default tenant).' },
                tenantId: { type: 'string', format: 'uuid', description: 'Deprecated: optional legacy tenant UUID. Prefer tenantSlug or auto-resolution.' },
                tenantSlug: { type: 'string', pattern: '^[a-z0-9-]+$', description: 'Optional tenant slug for tenant login without exposing UUID' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Login successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { accessToken: { type: 'string', description: 'JWT with scope claim (platform|tenant)' }, refreshToken: { type: 'string' }, sessionId: { type: 'string', format: 'uuid' }, scope: { type: 'string', enum: ['platform', 'tenant'] }, user: { $ref: '#/components/schemas/User' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: { description: 'Forbidden - platform access denied or tenant inactive', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Refresh access token',
      description: 'Public. Rate-limited. Requires valid refreshToken.',
      operationId: 'refresh',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              properties: { refreshToken: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Token refreshed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout',
      description: 'Public. Optionally revokes refresh token if provided.',
      operationId: 'logout',
      security: [],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { refreshToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Logout successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        500: error500,
      },
    },
  },
  '/api/v1/auth/forgot-password': {
    post: {
      tags: ['Auth'],
      summary: 'Forgot password',
      description: 'Public. Rate-limited. Always returns success to avoid email enumeration. tenantId/tenantSlug optional; when omitted auto-resolves via email.',
      operationId: 'forgotPassword',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: {
                email: { type: 'string', format: 'email' },
                tenantId: { type: 'string', format: 'uuid' },
                tenantSlug: { type: 'string', pattern: '^[a-z0-9-]+$' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Reset link sent if email exists', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/reset-password': {
    post: {
      tags: ['Auth'],
      summary: 'Reset password',
      description: 'Public. Rate-limited. Requires valid reset token.',
      operationId: 'resetPassword',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'password'],
              properties: {
                token: { type: 'string', minLength: 1 },
                password: { type: 'string', minLength: 8, maxLength: 128, example: 'NewStr0ng!Pass' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Password reset successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        401: { description: 'Invalid or expired token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/verify-email': {
    post: {
      tags: ['Auth'],
      summary: 'Verify email',
      description: 'Public. Rate-limited.',
      operationId: 'verifyEmail',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Email verified', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        401: { description: 'Invalid or expired token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current user',
      description: 'Requires authentication. No specific permission. Tenant isolated via JWT. Includes the caller\'s `roles` and the de-duplicated, sorted union of their permission names (`resource:action`) for UI gating — every request is still authorized server-side.',
      operationId: 'getMe',
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'Current user with roles and effective permissions',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    allOf: [
                      { $ref: '#/components/schemas/User' },
                      {
                        type: 'object',
                        properties: {
                          scope: { type: 'string', enum: ['tenant', 'platform'] },
                          roles: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string', example: 'admin' }, description: { type: 'string', nullable: true }, isSystem: { type: 'boolean' } } } },
                          permissions: { type: 'array', items: { type: 'string', example: 'product:read' } },
                        },
                      },
                    ],
                  },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        401: error401,
        403: error403,
        500: error500,
      },
    },
    patch: {
      tags: ['Auth'],
      summary: 'Update own profile',
      description: 'Tenant token. Only `firstName` / `lastName` (trimmed); any other field → 400. Returns the same shape as GET /auth/me.',
      operationId: 'updateMe',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', minProperties: 1, additionalProperties: false, properties: { firstName: { type: 'string', minLength: 1, maxLength: 100 }, lastName: { type: 'string', minLength: 1, maxLength: 100 } } } } },
      },
      responses: {
        200: { description: 'Profile updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/User' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/auth/change-password': {
    post: {
      tags: ['Auth'],
      summary: 'Change own password',
      description: 'Tenant or platform token. Rate-limited. Wrong current password → 400 `INVALID_CURRENT_PASSWORD` (deliberately not 401); same password → 400 `PASSWORD_UNCHANGED`. On success every other session is signed out; the calling session stays valid.',
      operationId: 'changePassword',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['currentPassword', 'newPassword'], additionalProperties: false, properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8, maxLength: 128, description: 'Upper, lower, digit and symbol required' } } } } },
      },
      responses: {
        200: { description: 'Password changed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { success: { type: 'boolean' }, otherSessionsRevoked: { type: 'integer' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/resend-verification': {
    post: {
      tags: ['Auth'],
      summary: 'Resend email verification',
      description: 'Tenant token. Rate-limited. Invalidates earlier unused verification links. 409 `EMAIL_ALREADY_VERIFIED` when already verified. `devToken` is only returned in development/test.',
      operationId: 'resendVerification',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Verification email sent', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { success: { type: 'boolean' } } }, message: { type: 'string' } } } } } },
        401: error401,
        409: { description: 'Email already verified', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: error429,
        500: error500,
      },
    },
  },
  '/api/v1/auth/sessions': {
    get: {
      tags: ['Auth'],
      summary: 'List own active sessions',
      description: 'Tenant or platform token. One entry per login (a session survives refresh-token rotation); `current` marks the caller.',
      operationId: 'listSessions',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Active sessions', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid', description: 'Session id (= JWT sessionId)' }, current: { type: 'boolean' }, userAgent: { type: 'string', nullable: true }, ipAddress: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, lastUsedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' } } } }, message: { type: 'string' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/auth/sessions/{sessionId}': {
    delete: {
      tags: ['Auth'],
      summary: 'Revoke one of own sessions',
      description: 'Tenant or platform token. Its access and refresh tokens stop working immediately (401 `SESSION_REVOKED`). Revoking the current session signs the caller out. 404 `SESSION_NOT_FOUND` for unknown sessions or sessions of other users.',
      operationId: 'revokeSession',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Session revoked', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { success: { type: 'boolean' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        404: { description: 'Session not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: error500,
      },
    },
  },
  '/api/v1/auth/logout-all': {
    post: {
      tags: ['Auth'],
      summary: 'Sign out everywhere',
      description: 'Tenant or platform token. Revokes every session of the caller, including the current one.',
      operationId: 'logoutAll',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'All sessions revoked', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { success: { type: 'boolean' }, sessionsRevoked: { type: 'integer' } } }, message: { type: 'string' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
};
