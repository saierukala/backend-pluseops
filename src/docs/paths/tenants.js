const tenantIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Tenant ID' };

const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Missing or invalid platform token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Not a platform token, or missing platform permission', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error409 = { description: 'Conflict - duplicate slug', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const tenantsPaths = {
  '/api/v1/tenants': {
    post: {
      tags: ['Tenants'],
      summary: 'Create tenant',
      description: 'Platform admin only (scope=platform token with `platform:tenant:create`). Prefer /api/v1/platform/tenants, which also provisions roles and a first admin.',
      operationId: 'createTenant',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'slug'],
              properties: {
                name: { type: 'string', minLength: 1, maxLength: 255, example: 'Acme Corp' },
                slug: { type: 'string', pattern: '^[a-z0-9-]+$', minLength: 1, maxLength: 100, example: 'acme-corp' },
                status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED'], example: 'TRIAL' },
                plan: { type: 'string', maxLength: 50, example: 'free' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Tenant created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Tenant' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        409: error409,
        500: error500,
      },
    },
  },
  '/api/v1/tenants/{id}': {
    get: {
      tags: ['Tenants'],
      summary: 'Get tenant by ID',
      description: 'Platform admin only (scope=platform token with `platform:tenant:read`). Prefer /api/v1/platform/tenants, which also provisions roles and a first admin.',
      operationId: 'getTenant',
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
      tags: ['Tenants'],
      summary: 'Update tenant',
      description: 'Platform admin only (scope=platform token with `platform:tenant:update`). At least one field required. Prefer /api/v1/platform/tenants, which also provisions roles and a first admin.',
      operationId: 'updateTenant',
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
    delete: {
      tags: ['Tenants'],
      summary: 'Delete tenant',
      description: 'Platform admin only (scope=platform token with `platform:tenant:delete`). Prefer /api/v1/platform/tenants, which also provisions roles and a first admin.',
      operationId: 'deleteTenant',
      security: [{ bearerAuth: [] }],
      parameters: [tenantIdParam],
      responses: {
        200: { description: 'Tenant deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
};
