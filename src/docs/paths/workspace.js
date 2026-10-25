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
const taxProfile = { $ref: '#/components/schemas/TaxProfile' };
const domain = { $ref: '#/components/schemas/TenantDomain' };
const paymentGateway = { $ref: '#/components/schemas/PaymentGateway' };
const domainIdParam = { name: 'domainId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const security = [{ bearerAuth: [] }];

const settingsProperties = {
  currency: { type: 'string', nullable: true, pattern: '^[A-Za-z]{3}$', description: 'ISO 4217, stored upper-case', example: 'INR' },
  timezone: { type: 'string', nullable: true, description: 'IANA time zone', example: 'Asia/Kolkata' },
  locale: { type: 'string', nullable: true, description: 'BCP 47 tag', example: 'en-IN' },
  contactEmail: { type: 'string', format: 'email', nullable: true },
  contactPhone: { type: 'string', maxLength: 30, nullable: true },
  gstRatePercent: { type: 'number', minimum: 0, maximum: 100, nullable: true, description: 'GST % applied to new orders (at most two decimals); null uses DEFAULT_GST_RATE_PERCENT (18)', example: 18 },
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
  '/api/v1/workspace/tax-profile': {
    get: {
      tags: ['Workspace'],
      summary: 'Get the GST tax profile',
      description: 'Requires `tenant:read`. Printed on every tax invoice; unset keys are `null`.',
      operationId: 'getWorkspaceTaxProfile',
      security,
      responses: { 200: ok('Tax profile retrieved', taxProfile), 401: error401, 403: error403, 500: error500 },
    },
    patch: {
      tags: ['Workspace'],
      summary: 'Update the GST tax profile',
      description: 'Requires `tenant:update`. Partial; `null` clears a key. The GSTIN is checked (format and check digit) and fills in the state and PAN when they are not given; `stateCode` accepts a GST code, short form or state name. New orders use it: CGST + SGST inside the state, IGST outside, no GST for COMPOSITION/UNREGISTERED, and GST taken out of the price when `pricesIncludeTax` is true.',
      operationId: 'updateWorkspaceTaxProfile',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: { ...taxProfile } } } } },
      responses: { 200: ok('Tax profile updated', taxProfile), 400: error400, 401: error401, 403: error403, 500: error500 },
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
      description: 'Requires `tenant:update`. Hostname only (lower-cased, trailing dot removed). 409 `DOMAIN_TAKEN` if this tenant already has it or another tenant has **verified** it (same response either way); unverified claims elsewhere do not block. The first domain becomes primary. Starts `verified: false` with a `verification` TXT record to publish, then `POST …/verify`.',
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
  '/api/v1/workspace/domains/{domainId}/verify': {
    post: {
      tags: ['Workspace'],
      summary: 'Verify domain ownership (DNS TXT)',
      description: 'Requires `tenant:update`. Publish the `verification` record from the domain (TXT `_pulseops-verify.<domain>` = value), then call this. The first tenant to verify a domain keeps it; other tenants\' unverified claims are removed. Only verified domains resolve to a storefront. 422 `DOMAIN_VERIFICATION_FAILED` with the expected record; 409 `DOMAIN_TAKEN` if verified elsewhere.',
      operationId: 'verifyWorkspaceDomain',
      security,
      parameters: [domainIdParam],
      responses: { 200: ok('Domain verified', domain), 400: error400, 401: error401, 403: error403, 404: error404, 409: err('Domain verified by another tenant'), 422: err('TXT record not found'), 500: error500 },
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
  // Phase 35
  '/api/v1/workspace/payment-gateway': {
    get: {
      tags: ['Workspace'],
      summary: "The shop's Razorpay connection",
      description: 'Requires `tenant:read`. Secrets are never returned; `webhookSecretSet` says whether one is stored. `webhookUrlPath` is the path to enter (after your API origin) as the webhook URL in the Razorpay dashboard, with events `payment.captured` and `order.paid`.',
      operationId: 'getPaymentGateway',
      security,
      responses: { 200: ok('Payment gateway', paymentGateway), 401: error401, 403: error403, 500: error500 },
    },
    put: {
      tags: ['Workspace'],
      summary: "Connect the shop's own Razorpay account",
      description: 'Requires `tenant:update` (owners/admins). Money goes straight to this account. Razorpay is asked whether the keys work before they are saved (422 `RAZORPAY_KEYS_INVALID`; 502 if Razorpay is unreachable). The key secret and webhook secret are stored AES-256-GCM encrypted; replacing the keys replaces the webhook secret too (omit it to clear). 503 `CREDENTIALS_ENCRYPTION_NOT_CONFIGURED` in production without `CREDENTIALS_ENCRYPTION_KEY`.',
      operationId: 'savePaymentGateway',
      security,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['keyId', 'keySecret'], properties: {
          keyId: { type: 'string', pattern: '^rzp_(test|live)_[A-Za-z0-9]{6,}$', example: 'rzp_test_1DP5mmOlF5G5ag' },
          keySecret: { type: 'string', minLength: 8, maxLength: 128, writeOnly: true },
          webhookSecret: { type: 'string', minLength: 8, maxLength: 128, writeOnly: true, description: 'The secret you set on the Razorpay webhook; without it, webhooks are refused (checkout verification still works)' },
          enabled: { type: 'boolean', default: true },
        } } } },
      },
      responses: { 200: ok('Razorpay connected', paymentGateway), 400: error400, 401: error401, 403: error403, 422: err('Razorpay rejected the keys (`RAZORPAY_KEYS_INVALID`)'), 500: error500, 502: err('Razorpay unreachable (`PAYMENT_PROVIDER_ERROR`)'), 503: err('`CREDENTIALS_ENCRYPTION_NOT_CONFIGURED`') },
    },
    patch: {
      tags: ['Workspace'],
      summary: 'Switch online payment on or off',
      description: 'Requires `tenant:update`. Off: the storefront creates plain pending payments again; refunds and webhooks for earlier Razorpay payments keep working.',
      operationId: 'updatePaymentGateway',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } } },
      responses: { 200: ok('Payment gateway updated', paymentGateway), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    delete: {
      tags: ['Workspace'],
      summary: 'Disconnect Razorpay',
      description: 'Requires `tenant:update`. Deletes the stored keys. Refunds of earlier Razorpay payments then fail with 409 `PAYMENT_GATEWAY_NOT_CONFIGURED` until the keys are entered again.',
      operationId: 'deletePaymentGateway',
      security,
      responses: { 204: { description: 'Disconnected' }, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
};
