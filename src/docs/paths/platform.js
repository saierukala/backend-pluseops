const tenantIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Tenant ID' };
const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized - missing or invalid platform token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden - insufficient platform permission or platform scope required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error409 = { description: 'Conflict - duplicate slug or email', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const platformPaths = {
  '/api/v1/platform/tenants': {
    get: {
      tags: ['Platform'],
      summary: 'List tenants (platform)',
      description: 'Platform-only. Requires scope=platform JWT with platform:tenant:read permission. Paginated, excludes internal platform tenant.',
      operationId: 'platformListTenants',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'] } },
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 100 } },
      ],
      responses: {
        200: { description: 'Tenants list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Tenant' } }, meta: { $ref: '#/components/schemas/PaginationMeta' }, message: { type: 'string' } } } } } },
        401: error401,
        403: error403,
        500: error500,
      },
    },
    post: {
      tags: ['Platform'],
      summary: 'Create tenant (platform)',
      description: 'Platform-only. Requires platform:tenant:create. Creates tenant and initial Tenant Admin atomically. Tenant and admin are created in single transaction; partially-created tenants never persist. Admin email must be globally unique.',
      operationId: 'platformCreateTenant',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'slug', 'admin'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255, example: 'Acme Store' },
                slug: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1, maxLength: 100, example: 'acme-store' },
                status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'], example: 'ACTIVE' },
                plan: { type: 'string', maxLength: 50, example: 'free' },
                admin: {
                  type: 'object',
                  required: ['email', 'password', 'firstName', 'lastName'],
                  properties: {
                    email: { type: 'string', format: 'email', example: 'acme-admin@example.com' },
                    password: { type: 'string', minLength: 8, description: 'Requires uppercase, lowercase, digit, special' },
                    firstName: { type: 'string', minLength: 1, maxLength: 100 },
                    lastName: { type: 'string', minLength: 1, maxLength: 100 },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Tenant and admin created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { tenant: { $ref: '#/components/schemas/Tenant' }, adminUser: { $ref: '#/components/schemas/User' } } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        409: error409,
        500: error500,
      },
    },
  },
  '/api/v1/platform/tenants/{id}': {
    get: {
      tags: ['Platform'],
      summary: 'Get tenant by ID (platform)',
      description: 'Platform-only. Requires platform:tenant:read.',
      operationId: 'platformGetTenant',
      security: [{ bearerAuth: [] }],
      parameters: [tenantIdParam],
      responses: {
        200: { description: 'Tenant retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Tenant' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    patch: {
      tags: ['Platform'],
      summary: 'Update tenant (platform)',
      description: 'Platform-only. Requires platform:tenant:update.',
      operationId: 'platformUpdateTenant',
      security: [{ bearerAuth: [] }],
      parameters: [tenantIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255 },
                slug: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1, maxLength: 100 },
                status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'] },
                plan: { type: 'string', maxLength: 50 },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Tenant updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Tenant' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        409: error409,
        500: error500,
      },
    },
  },
  '/api/v1/platform/tenants/{id}/status': {
    patch: {
      tags: ['Platform'],
      summary: 'Update tenant status (suspend/activate)',
      description: 'Platform-only. Requires platform:tenant:suspend (also covers activate).',
      operationId: 'platformUpdateTenantStatus',
      security: [{ bearerAuth: [] }],
      parameters: [tenantIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'] } } },
          },
        },
      },
      responses: {
        200: { description: 'Tenant status updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Tenant' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/platform/tenants/{id}/admin': {
    post: {
      tags: ['Platform'],
      summary: 'Create tenant admin (platform)',
      description: 'Platform-only. Requires platform:tenant:create. Creates initial admin for existing tenant.',
      operationId: 'platformCreateTenantAdmin',
      security: [{ bearerAuth: [] }],
      parameters: [tenantIdParam],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password', 'firstName', 'lastName'],
              properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string', minLength: 8 },
                firstName: { type: 'string', minLength: 1, maxLength: 100 },
                lastName: { type: 'string', minLength: 1, maxLength: 100 },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Tenant admin created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/User' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        409: error409,
        500: error500,
      },
    },
  },
};
