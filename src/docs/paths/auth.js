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
      description: 'Public. Rate-limited. Returns access and refresh tokens.',
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
                tenantId: { type: 'string', format: 'uuid' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Login successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
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
      description: 'Public. Rate-limited. Always returns success to avoid email enumeration.',
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
      description: 'Requires authentication. No specific permission. Tenant isolated via JWT.',
      operationId: 'getMe',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Current user', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/User' }, message: { type: 'string' } } } } } },
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
};
