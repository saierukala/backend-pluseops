const tenantIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Tenant ID' };

const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error409 = { description: 'Conflict - duplicate slug', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const tenantsPaths = {
  '/api/v1/tenants': {
    post: {
      tags: ['Tenants'],
      summary: 'Create tenant',
      description: 'Public tenant provisioning. No authentication required.',
      operationId: 'createTenant',
      security: [],
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
        409: error409,
        500: error500,
      },
    },
  },
  '/api/v1/tenants/{id}': {
    get: {
      tags: ['Tenants'],
      summary: 'Get tenant by ID',
      description: 'Public. No authentication required.',
      operationId: 'getTenant',
      security: [],
      parameters: [tenantIdParam],
      responses: {
        200: { description: 'Tenant retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Tenant' }, message: { type: 'string' } } } } } },
        400: error400,
        404: error404,
        500: error500,
      },
    },
    patch: {
      tags: ['Tenants'],
      summary: 'Update tenant',
      description: 'Public. No authentication required. At least one field required.',
      operationId: 'updateTenant',
      security: [],
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
        404: error404,
        409: error409,
        500: error500,
      },
    },
    delete: {
      tags: ['Tenants'],
      summary: 'Delete tenant',
      description: 'Public. No authentication required.',
      operationId: 'deleteTenant',
      security: [],
      parameters: [tenantIdParam],
      responses: {
        200: { description: 'Tenant deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        404: error404,
        500: error500,
      },
    },
  },
};
