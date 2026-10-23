const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden - missing permission or tenant inactive', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error409 = { description: 'Conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const paginationParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
];
const usersPagination = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];

export const rbacPaths = {
  '/api/v1/roles': {
    get: {
      tags: ['Roles'],
      summary: 'List roles',
      description: 'Requires authentication and permission `role:read`. Tenant-isolated.',
      operationId: 'listRoles',
      security: [{ bearerAuth: [] }],
      parameters: [...paginationParams],
      responses: {
        200: { description: 'Roles retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }, meta: { $ref: '#/components/schemas/PaginationMeta' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
    post: {
      tags: ['Roles'],
      summary: 'Create role',
      description: 'Requires `role:create`.',
      operationId: 'createRole',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string', pattern: '^[a-z0-9_-]+$', minLength: 1, maxLength: 100, example: 'editor' },
                description: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Role created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Role' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        409: error409,
        500: error500,
      },
    },
  },
  '/api/v1/roles/{id}': {
    get: {
      tags: ['Roles'],
      summary: 'Get role by ID',
      description: 'Requires `role:read`.',
      operationId: 'getRole',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Role retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Role' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    patch: {
      tags: ['Roles'],
      summary: 'Update role',
      description: 'Requires `role:update`. At least one field required.',
      operationId: 'updateRole',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { name: { type: 'string', pattern: '^[a-z0-9_-]+$', minLength: 1, maxLength: 100 }, description: { type: 'string', maxLength: 500 } } } } },
      },
      responses: {
        200: { description: 'Role updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Role' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    delete: {
      tags: ['Roles'],
      summary: 'Delete role',
      description: 'Requires `role:delete`.',
      operationId: 'deleteRole',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Role deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/roles/{id}/permissions': {
    post: {
      tags: ['Roles'],
      summary: 'Assign permissions to role',
      description: 'Requires `role:update`.',
      operationId: 'assignPermissions',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['permissionIds'], properties: { permissionIds: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } } } } } },
      },
      responses: {
        200: { description: 'Permissions assigned', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Permission' } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    put: {
      tags: ['Roles'],
      summary: 'Replace role permissions',
      description: 'Requires `role:update`. Replaces the role\'s whole permission set atomically; an empty array clears it. Unknown or cross-tenant IDs → 400 `INVALID_PERMISSION_IDS` (nothing changes). System roles → 403 `SYSTEM_ROLE_IMMUTABLE`.',
      operationId: 'replacePermissions',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['permissionIds'], properties: { permissionIds: { type: 'array', maxItems: 500, items: { type: 'string', format: 'uuid' } } } } } },
      },
      responses: {
        200: { description: 'Permissions replaced (the role\'s new permission set)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Permission' } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/roles/{id}/permissions/{permissionId}': {
    delete: {
      tags: ['Roles'],
      summary: 'Remove a permission from a role',
      description: 'Requires `role:update`. 404 `PERMISSION_NOT_ASSIGNED` when the role does not have it. System roles → 403 `SYSTEM_ROLE_IMMUTABLE`.',
      operationId: 'removePermission',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'permissionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Permission removed (the role\'s remaining permissions)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Permission' } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/permissions': {
    get: {
      tags: ['Permissions'],
      summary: 'List permissions',
      description: 'Requires `permission:read`. Paginated; the default page size (100) covers the whole tenant catalog.',
      operationId: 'listPermissions',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        { name: 'resource', in: 'query', schema: { type: 'string', pattern: '^[a-z_]+$' }, description: 'Only permissions for this resource, e.g. `product`' },
      ],
      responses: {
        200: { description: 'Permissions retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Permission' } }, meta: { $ref: '#/components/schemas/PaginationMeta' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/permissions/{id}': {
    get: {
      tags: ['Permissions'],
      summary: 'Get permission by ID',
      description: 'Requires `permission:read`.',
      operationId: 'getPermission',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Permission retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Permission' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/users': {
    get: {
      tags: ['Users'],
      summary: 'List users',
      description: 'Requires `user:read`.',
      operationId: 'listUsers',
      security: [{ bearerAuth: [] }],
      parameters: [
        ...usersPagination,
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 255 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] } },
        { name: 'roleId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'email', 'firstName', 'lastName', 'status'], default: 'createdAt' } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: {
        200: { description: 'Users retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/User' } }, meta: { $ref: '#/components/schemas/PaginationMeta' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'Get user by ID',
      description: 'Requires `user:read`.',
      operationId: 'getUser',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'User retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/User' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    patch: {
      tags: ['Users'],
      summary: 'Update user',
      description: 'Requires `user:update`. At least one field. Supports passthrough for extensibility.',
      operationId: 'updateUser',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                status: { type: 'string' },
                email: { type: 'string', format: 'email' },
                passwordHash: { type: 'string' },
                tenantId: { type: 'string', format: 'uuid' },
                roleIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: { description: 'User updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/User' }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    delete: {
      tags: ['Users'],
      summary: 'Delete user',
      description: 'Requires `user:delete`. Cannot delete own account (400 SELF_DELETION_FORBIDDEN).',
      operationId: 'deleteUser',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'User deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true }, message: { type: 'string' } } } } } },
        400: { description: 'Validation or self-deletion forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/users/{id}/roles': {
    get: {
      tags: ['Users'],
      summary: 'Get user roles',
      description: 'Requires `user:read`.',
      operationId: 'getUserRoles',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'User roles', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    post: {
      tags: ['Users'],
      summary: 'Assign roles to user',
      description: 'Requires `user:update`.',
      operationId: 'assignRoles',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['roleIds'], properties: { roleIds: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } } } } } },
      },
      responses: {
        200: { description: 'Roles assigned', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }, message: { type: 'string' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/users/{id}/roles/{roleId}': {
    delete: {
      tags: ['Users'],
      summary: 'Remove a role from a user',
      description: 'Requires `user:update`. 404 `USER_NOT_FOUND` / `ROLE_NOT_FOUND` / `ROLE_NOT_ASSIGNED`. 409 `LAST_ADMIN_ROLE` when removing `admin` from the tenant\'s only admin.',
      operationId: 'removeRole',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'roleId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        200: { description: 'Role removed (the user\'s remaining roles)', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Role' } }, message: { type: 'string' } } } } } },
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
