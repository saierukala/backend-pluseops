const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const error400 = err('Validation error');
const error401 = err('Unauthorized');
const error403 = err('Forbidden (missing permission, a platform token, or a write with a read-only support token: `SUPPORT_READ_ONLY`)');
const error404 = err('Not found');
const error500 = err('Internal server error');

const ok = (description, schema) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema } } } },
});
const workspace = { $ref: '#/components/schemas/Workspace' };
const settings = { $ref: '#/components/schemas/WorkspaceSettings' };
const domain = { $ref: '#/components/schemas/TenantDomain' };
const domainIdParam = { name: 'domainId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const security = [{ bearerAuth: [] }];

const settingsProperties = {
  currency: { type: 'string', nullable: true, pattern: '^[A-Za-z]{3}$', description: 'ISO 4217, stored upper-case', example: 'INR' },
  timezone: { type: 'string', nullable: true, description: 'IANA time zone', example: 'Asia/Kolkata' },
  locale: { type: 'string', nullable: true, description: 'BCP 47 tag', example: 'en-IN' },
  contactEmail: { type: 'string', format: 'email', nullable: true },
  contactPhone: { type: 'string', maxLength: 30, nullable: true },
};

export const workspacePaths = {
  '/api/v1/workspace': {
    get: {
      tags: ['Workspace'],
      summary: "Get the caller's tenant",
      description: 'Requires `tenant:read`. The tenant comes from the token; there is no tenant id in the URL.',
      operationId: 'getWorkspace',
      security,
      responses: { 200: ok('Workspace retrieved', workspace), 401: error401, 403: error403, 500: error500 },
    },
    patch: {
      tags: ['Workspace'],
      summary: 'Rename the workspace',
      description: 'Requires `tenant:update`. Only `name`; slug, status and plan are platform-managed.',
      operationId: 'updateWorkspace',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 255 } } } } } },
      responses: { 200: ok('Workspace updated', workspace), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
  },
  '/api/v1/workspace/settings': {
    get: {
      tags: ['Workspace'],
      summary: 'Get workspace settings',
      description: 'Requires `tenant:read`. Unset keys are `null`.',
      operationId: 'getWorkspaceSettings',
      security,
      responses: { 200: ok('Settings retrieved', settings), 401: error401, 403: error403, 500: error500 },
    },
    patch: {
      tags: ['Workspace'],
      summary: 'Update workspace settings',
      description: 'Requires `tenant:update`. Partial: only given keys change; `null` clears a key.',
      operationId: 'updateWorkspaceSettings',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: settingsProperties } } } },
      responses: { 200: ok('Settings updated', settings), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
  },
  '/api/v1/workspace/domains': {
    get: {
      tags: ['Workspace'],
      summary: 'List workspace domains',
      description: 'Requires `tenant:read`. Primary first.',
      operationId: 'listWorkspaceDomains',
      security,
      responses: { 200: ok('Domains retrieved', { type: 'array', items: domain }), 401: error401, 403: error403, 500: error500 },
    },
    post: {
      tags: ['Workspace'],
      summary: 'Add a domain',
      description: 'Requires `tenant:update`. Hostname only (lower-cased, trailing dot removed). A domain belongs to one tenant platform-wide: 409 `DOMAIN_TAKEN` (same response whoever owns it). The first domain becomes primary. Domains start `verified: false`; verification arrives with the storefront (Phase 32).',
      operationId: 'createWorkspaceDomain',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['domain'], properties: { domain: { type: 'string', example: 'shop.example.com' } } } } } },
      responses: { 201: ok('Domain added', domain), 400: error400, 401: error401, 403: error403, 409: err('Domain already registered (`DOMAIN_TAKEN`)'), 500: error500 },
    },
  },
  '/api/v1/workspace/domains/{domainId}': {
    patch: {
      tags: ['Workspace'],
      summary: 'Make a domain primary',
      description: 'Requires `tenant:update`. Body must be `{ "primary": true }`; the previous primary is unset.',
      operationId: 'updateWorkspaceDomain',
      security,
      parameters: [domainIdParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['primary'], properties: { primary: { type: 'boolean', enum: [true] } } } } } },
      responses: { 200: ok('Primary domain updated', domain), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    delete: {
      tags: ['Workspace'],
      summary: 'Remove a domain',
      description: 'Requires `tenant:update`. Removing the primary promotes the oldest remaining domain.',
      operationId: 'deleteWorkspaceDomain',
      security,
      parameters: [domainIdParam],
      responses: { 200: ok('Domain removed', { nullable: true, example: null }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/platform/tenants/{id}/support-sessions': {
    post: {
      tags: ['Platform'],
      summary: 'Start a read-only support session in a tenant',
      description: 'Requires a platform token with `platform:tenant:access`. Returns a 30-minute `scope: "support"` access token (no refresh token) for that tenant. With it only GET requests and `*:read` permissions pass (writes → 403 `SUPPORT_READ_ONLY`; own-account and notification endpoints → 403 `SUPPORT_TOKEN_FORBIDDEN`). The start, the end and every request are written to the tenant\'s audit/activity logs under the platform admin. Suspending the tenant or removing the permission ends access immediately. 409 `TENANT_INACTIVE` for suspended tenants.',
      operationId: 'startSupportSession',
      security,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Tenant ID' }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 5, maxLength: 500, example: 'Customer reported missing orders' } } } } } },
      responses: { 201: ok('Support session started', { $ref: '#/components/schemas/SupportSession' }), 400: error400, 401: error401, 403: error403, 404: error404, 409: err('Tenant is not active'), 500: error500 },
    },
  },
  '/api/v1/platform/support-sessions/{sessionId}': {
    delete: {
      tags: ['Platform'],
      summary: 'End a support session',
      description: 'Requires `platform:tenant:access`; only the platform admin who started it. Its token stops working immediately. Ending an ended session is a no-op.',
      operationId: 'endSupportSession',
      security,
      parameters: [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { 200: ok('Support session ended', { nullable: true, example: null }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
};
