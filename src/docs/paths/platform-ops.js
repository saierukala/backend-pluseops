const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const e400 = err('Validation error');
const e401 = err('Unauthorized');
const e403 = err('Forbidden (platform token and the named permission required)');
const e404 = err('Not found');
const e409 = (d) => err(d);
const e500 = err('Internal server error');
const ok = (description, schema, extra = {}) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema, ...extra } } } },
});
const security = [{ bearerAuth: [] }];
const tags = ['Platform'];
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Tenant ID' };
const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const limit = { type: 'integer', minimum: 0, nullable: true, description: 'null = unlimited' };
const limits = { type: 'object', properties: { users: limit, products: limit, warehouses: limit, ordersPerMonth: limit } };

export const platformOpsPaths = {
  '/api/v1/platform/overview': {
    get: {
      tags, summary: 'Platform overview', operationId: 'getPlatformOverview', security,
      description: 'Requires `platform:tenant:read`. Tenants by status and plan, new tenants per month (12 months), active users, orders (total / 30 days) and completed revenue **per currency** (total / 30 days).',
      responses: { 200: ok('Overview', ref('PlatformOverview')), 401: e401, 403: e403, 500: e500 },
    },
  },
  '/api/v1/platform/tenants/{id}/usage': {
    get: {
      tags, summary: 'Tenant usage against its plan', operationId: 'getPlatformTenantUsage', security,
      description: 'Requires `platform:tenant:read`. Users = active memberships; products = not deleted; orders = this calendar month (UTC). `lastActivityAt` = latest activity-log entry or user sign-in.',
      parameters: [id],
      responses: { 200: ok('Usage', ref('TenantUsage')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 },
    },
  },
  '/api/v1/platform/tenants/{id}/plan': {
    patch: {
      tags, summary: 'Assign a plan to a tenant', operationId: 'assignPlatformTenantPlan', security,
      description: 'Requires `platform:billing:update`. The plan must exist and be active (400 `PLAN_NOT_FOUND` / `PLAN_INACTIVE` / `PLAN_RESERVED`). Lowering limits below current usage blocks new creations only; nothing is deleted.',
      parameters: [id], requestBody: json({ type: 'object', required: ['plan'], properties: { plan: { type: 'string', example: 'pro' } } }),
      responses: { 200: ok('Plan assigned', { type: 'object', properties: { tenantId: { type: 'string' }, plan: ref('Plan') } }), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 },
    },
  },
  '/api/v1/platform/plans': {
    get: {
      tags, summary: 'List plans', operationId: 'listPlatformPlans', security, description: 'Requires `platform:billing:read`. Active plans with how many tenants use each.',
      parameters: [{ name: 'includeInactive', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
      responses: { 200: ok('Plans', { type: 'array', items: ref('Plan') }), 401: e401, 403: e403, 500: e500 },
    },
    post: {
      tags, summary: 'Create a plan', operationId: 'createPlatformPlan', security,
      description: 'Requires `platform:billing:update`. Limits are enforced on create (users, products, warehouses, orders per month) with 403 `PLAN_LIMIT_REACHED`.',
      requestBody: json({ type: 'object', required: ['code', 'name'], properties: { code: { type: 'string', example: 'growth' }, name: { type: 'string' }, description: { type: 'string', nullable: true }, limits, isActive: { type: 'boolean' } } }),
      responses: { 201: ok('Plan created', ref('Plan')), 400: e400, 401: e401, 403: e403, 409: e409('Plan code exists (`PLAN_EXISTS`)'), 500: e500 },
    },
  },
  '/api/v1/platform/plans/{code}': {
    patch: {
      tags, summary: 'Update a plan', operationId: 'updatePlatformPlan', security, description: 'Requires `platform:billing:update`. `limits` is merged key by key; `null` makes a limit unlimited.',
      parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: json({ type: 'object', minProperties: 1, properties: { name: { type: 'string' }, description: { type: 'string', nullable: true }, limits, isActive: { type: 'boolean' } } }),
      responses: { 200: ok('Plan updated', ref('Plan')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 },
    },
  },
  '/api/v1/platform/roles': {
    get: {
      tags, summary: 'List platform roles', operationId: 'listPlatformRoles', security, description: 'Requires `platform:admin:read`.',
      responses: { 200: ok('Roles', { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string', nullable: true }, isSystem: { type: 'boolean' }, permissions: { type: 'array', items: { type: 'string' } }, adminCount: { type: 'integer' } } } }), 401: e401, 403: e403, 500: e500 },
    },
  },
  '/api/v1/platform/admins': {
    get: {
      tags, summary: 'List platform admins', operationId: 'listPlatformAdmins', security, description: 'Requires `platform:admin:read`.',
      responses: { 200: ok('Admins', { type: 'array', items: ref('PlatformAdmin') }), 401: e401, 403: e403, 500: e500 },
    },
    post: {
      tags, summary: 'Add a platform admin', operationId: 'createPlatformAdmin', security,
      description: 'Requires `platform:admin:manage`. Creates an account with the given initial password (12+ chars, upper/lower/digit/symbol); share it out of band and have them change it. `roleId` defaults to the seeded `platform_admin` role. 409 if the email already has an account (one person = one account).',
      requestBody: json({ type: 'object', required: ['email', 'password', 'firstName', 'lastName'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 12 }, firstName: { type: 'string' }, lastName: { type: 'string' }, roleId: { type: 'string', format: 'uuid' } } }),
      responses: { 201: ok('Admin created', ref('PlatformAdmin')), 400: e400, 401: e401, 403: e403, 409: e409('Email already has an account'), 500: e500 },
    },
  },
  '/api/v1/platform/admins/{userId}': {
    delete: {
      tags, summary: 'Remove a platform admin', operationId: 'removePlatformAdmin', security,
      description: 'Requires `platform:admin:manage`. Removes their platform roles, deactivates the account and ends their sessions and support sessions immediately. 409 `CANNOT_REMOVE_SELF`.',
      parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { 200: ok('Removed', { nullable: true, example: null }), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409('Cannot remove yourself'), 500: e500 },
    },
  },
  '/api/v1/platform/audit-logs': {
    get: {
      tags, summary: 'Platform audit trail', operationId: 'listPlatformAuditLogs', security,
      description: 'Requires `platform:audit:read`. Every platform write: tenant create/update/status/plan/admin, legacy tenant routes, support sessions, plans, platform admins. Newest first.',
      parameters: [
        { name: 'action', in: 'query', schema: { type: 'string', example: 'tenant.plan' } },
        { name: 'tenantId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'actorUserId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 50 } },
      ],
      responses: { 200: ok('Audit log', { type: 'array', items: ref('PlatformAuditEntry') }, { meta: ref('PaginationMeta') }), 400: e400, 401: e401, 403: e403, 500: e500 },
    },
  },
};
