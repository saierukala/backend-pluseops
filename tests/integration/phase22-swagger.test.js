import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { openApiSpec } from '../../src/docs/openapi.js';

const app = createApp();

describe('Phase 22 - Swagger / OpenAPI Documentation', () => {
  const expectedPublic = new Set([
    'GET /health',
    'GET /health/db',
    'GET /health/redis',
    'GET /health/bullmq',
    'GET /api/v1/health',
    'GET /api/v1/health/db',
    'GET /api/v1/health/redis',
    'GET /api/v1/health/bullmq',
    'GET /ready',
    'GET /ready/live',
    'GET /api/v1/ready',
    'GET /api/v1/ready/live',
    'GET /metrics',
    'GET /metrics/metrics',
    'GET /api/v1/metrics',
    'GET /api/v1/metrics/metrics',
    'POST /api/v1/auth/register',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',
    'POST /api/v1/auth/forgot-password',
    'POST /api/v1/auth/reset-password',
    'POST /api/v1/auth/verify-email',
    'POST /api/v1/payments/webhook',
    'GET /api/v1/storage/signed',
    // Phase 32 public storefront
    'GET /api/v1/storefront/resolve',
    'GET /api/v1/storefront/{store}',
    'GET /api/v1/storefront/{store}/categories',
    'GET /api/v1/storefront/{store}/products',
    'GET /api/v1/storefront/{store}/products/{productId}',
    'POST /api/v1/storefront/{store}/auth/register',
    'POST /api/v1/storefront/{store}/auth/set-password',
    'POST /api/v1/storefront/{store}/auth/login',
    'POST /api/v1/storefront/{store}/auth/forgot-password',
    'POST /api/v1/storefront/{store}/auth/refresh',
    'POST /api/v1/storefront/{store}/auth/logout',
  ]);

  const allExpected = [
    // Health (dual)
    'GET /health',
    'GET /health/db',
    'GET /health/redis',
    'GET /health/bullmq',
    'GET /api/v1/health',
    'GET /api/v1/health/db',
    'GET /api/v1/health/redis',
    'GET /api/v1/health/bullmq',
    // Readiness
    'GET /ready',
    'GET /ready/live',
    'GET /api/v1/ready',
    'GET /api/v1/ready/live',
    // Metrics
    'GET /metrics',
    'GET /metrics/metrics',
    'GET /api/v1/metrics',
    'GET /api/v1/metrics/metrics',
    // Tenants 4
    'POST /api/v1/tenants',
    'GET /api/v1/tenants/{id}',
    'PATCH /api/v1/tenants/{id}',
    'DELETE /api/v1/tenants/{id}',
    // Auth 8
    'POST /api/v1/auth/register',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',
    'POST /api/v1/auth/forgot-password',
    'POST /api/v1/auth/reset-password',
    'POST /api/v1/auth/verify-email',
    'GET /api/v1/auth/me',
    // Roles 6
    'GET /api/v1/roles',
    'GET /api/v1/roles/{id}',
    'POST /api/v1/roles',
    'PATCH /api/v1/roles/{id}',
    'DELETE /api/v1/roles/{id}',
    'POST /api/v1/roles/{id}/permissions',
    // Permissions 2
    'GET /api/v1/permissions',
    'GET /api/v1/permissions/{id}',
    // Users 6
    'GET /api/v1/users',
    'GET /api/v1/users/{id}',
    'PATCH /api/v1/users/{id}',
    'DELETE /api/v1/users/{id}',
    'GET /api/v1/users/{id}/roles',
    'POST /api/v1/users/{id}/roles',
    // Categories 6
    'POST /api/v1/categories',
    'GET /api/v1/categories',
    'GET /api/v1/categories/tree',
    'GET /api/v1/categories/{id}',
    'PATCH /api/v1/categories/{id}',
    'DELETE /api/v1/categories/{id}',
    // Products 7
    'POST /api/v1/products',
    'GET /api/v1/products',
    'GET /api/v1/products/{id}',
    'PATCH /api/v1/products/{id}',
    'DELETE /api/v1/products/{id}',
    'POST /api/v1/products/{productId}/categories',
    'GET /api/v1/products/{productId}/categories',
    // Variants 7
    'POST /api/v1/products/{productId}/variants',
    'GET /api/v1/products/{productId}/variants',
    'GET /api/v1/products/{productId}/variants/{variantId}',
    'PATCH /api/v1/products/{productId}/variants/{variantId}',
    'DELETE /api/v1/products/{productId}/variants/{variantId}',
    'PUT /api/v1/products/{productId}/variants/{variantId}/attributes',
    'GET /api/v1/products/{productId}/variants/{variantId}/attributes',
    // Attributes 10
    'POST /api/v1/attributes',
    'GET /api/v1/attributes',
    'GET /api/v1/attributes/{id}',
    'PATCH /api/v1/attributes/{id}',
    'DELETE /api/v1/attributes/{id}',
    'POST /api/v1/attributes/{attributeId}/values',
    'GET /api/v1/attributes/{attributeId}/values',
    'GET /api/v1/attributes/{attributeId}/values/{valueId}',
    'PATCH /api/v1/attributes/{attributeId}/values/{valueId}',
    'DELETE /api/v1/attributes/{attributeId}/values/{valueId}',
    // Product Images 9
    'POST /api/v1/products/{productId}/images',
    'POST /api/v1/products/{productId}/variants/{variantId}/images',
    'GET /api/v1/products/{productId}/images',
    'GET /api/v1/products/{productId}/variants/{variantId}/images',
    'GET /api/v1/products/{productId}/images/{imageId}',
    'PATCH /api/v1/products/{productId}/images/{imageId}',
    'DELETE /api/v1/products/{productId}/images/{imageId}',
    'GET /api/v1/products/{productId}/images/{imageId}/file',
    'GET /api/v1/products/{productId}/images/{imageId}/signed-url',
    // Warehouses 5
    'POST /api/v1/warehouses',
    'GET /api/v1/warehouses',
    'GET /api/v1/warehouses/{id}',
    'PATCH /api/v1/warehouses/{id}',
    'DELETE /api/v1/warehouses/{id}',
    // Inventory 6
    'GET /api/v1/inventory',
    'GET /api/v1/inventory/movements',
    'GET /api/v1/inventory/low-stock',
    'GET /api/v1/inventory/variants/{variantId}',
    'POST /api/v1/inventory/adjust',
    'POST /api/v1/inventory/transfer',
    // Orders 6
    'POST /api/v1/orders',
    'GET /api/v1/orders',
    'GET /api/v1/orders/{id}',
    'PATCH /api/v1/orders/{id}/status',
    'POST /api/v1/orders/{id}/cancel',
    'GET /api/v1/orders/{id}/history',
    // Payments 5
    'POST /api/v1/payments/webhook',
    'POST /api/v1/payments/create',
    'POST /api/v1/payments/confirm',
    'GET /api/v1/payments/{id}',
    'POST /api/v1/payments/{id}/refund',
    // Audit 3
    'GET /api/v1/audit-logs',
    'GET /api/v1/activity-logs',
    'GET /api/v1/activity-logs/{id}',
    // Notifications 5
    'GET /api/v1/notifications',
    'POST /api/v1/notifications/read-all',
    'PATCH /api/v1/notifications/{id}/read',
    'GET /api/v1/notification-preferences',
    'PATCH /api/v1/notification-preferences',
    // Jobs 5
    'GET /api/v1/jobs/status',
    'POST /api/v1/jobs/cleanup',
    'POST /api/v1/jobs/notifications',
    'POST /api/v1/jobs/reports',
    'POST /api/v1/jobs/analytics',
    // Dashboard 1
    'GET /api/v1/dashboard/overview',
    // Analytics 6
    'GET /api/v1/analytics/overview',
    'GET /api/v1/analytics/sales',
    'GET /api/v1/analytics/orders',
    'GET /api/v1/analytics/inventory',
    'GET /api/v1/analytics/customers',
    'GET /api/v1/analytics/revenue',
    // Storage 2
    'GET /api/v1/storage/signed',
    'GET /api/v1/storage/file',
    // Platform admin 6
    'GET /api/v1/platform/tenants',
    'POST /api/v1/platform/tenants',
    'GET /api/v1/platform/tenants/{id}',
    'PATCH /api/v1/platform/tenants/{id}',
    'PATCH /api/v1/platform/tenants/{id}/status',
    'POST /api/v1/platform/tenants/{id}/admin',
    // RBAC completion (Phase 27) 3
    'PUT /api/v1/roles/{id}/permissions',
    'DELETE /api/v1/roles/{id}/permissions/{permissionId}',
    'DELETE /api/v1/users/{id}/roles/{roleId}',
    // Account self-service (Phase 28) 6
    'PATCH /api/v1/auth/me',
    'POST /api/v1/auth/change-password',
    'POST /api/v1/auth/resend-verification',
    'GET /api/v1/auth/sessions',
    'DELETE /api/v1/auth/sessions/{sessionId}',
    'POST /api/v1/auth/logout-all',
    // Customers & addresses (Phase 29) 10
    'POST /api/v1/customers',
    'GET /api/v1/customers',
    'GET /api/v1/customers/{id}',
    'PATCH /api/v1/customers/{id}',
    'DELETE /api/v1/customers/{id}',
    'GET /api/v1/customers/{id}/orders',
    'GET /api/v1/customers/{id}/addresses',
    'POST /api/v1/customers/{id}/addresses',
    'PATCH /api/v1/customers/{id}/addresses/{addressId}',
    'DELETE /api/v1/customers/{id}/addresses/{addressId}',
    // Tenant workspace + support sessions (Phase 30) 10
    'GET /api/v1/workspace',
    'PATCH /api/v1/workspace',
    'GET /api/v1/workspace/settings',
    'PATCH /api/v1/workspace/settings',
    'GET /api/v1/workspace/domains',
    'POST /api/v1/workspace/domains',
    'PATCH /api/v1/workspace/domains/{domainId}',
    'DELETE /api/v1/workspace/domains/{domainId}',
    'POST /api/v1/platform/tenants/{id}/support-sessions',
    'DELETE /api/v1/platform/support-sessions/{sessionId}',
    // Reports + notification templates (Phase 31) 10
    'POST /api/v1/reports',
    'GET /api/v1/reports',
    'GET /api/v1/reports/{id}',
    'GET /api/v1/reports/{id}/download',
    'GET /api/v1/notification-templates',
    'POST /api/v1/notification-templates',
    'GET /api/v1/notification-templates/{id}',
    'PATCH /api/v1/notification-templates/{id}',
    'DELETE /api/v1/notification-templates/{id}',
    'POST /api/v1/notification-templates/{id}/preview',
    // Storefront + domain verification (Phase 32) 26
    'POST /api/v1/workspace/domains/{domainId}/verify',
    'GET /api/v1/storefront/resolve',
    'GET /api/v1/storefront/{store}',
    'GET /api/v1/storefront/{store}/categories',
    'GET /api/v1/storefront/{store}/products',
    'GET /api/v1/storefront/{store}/products/{productId}',
    'POST /api/v1/storefront/{store}/auth/register',
    'POST /api/v1/storefront/{store}/auth/set-password',
    'POST /api/v1/storefront/{store}/auth/login',
    'POST /api/v1/storefront/{store}/auth/forgot-password',
    'POST /api/v1/storefront/{store}/auth/refresh',
    'POST /api/v1/storefront/{store}/auth/logout',
    'GET /api/v1/storefront/{store}/account',
    'PATCH /api/v1/storefront/{store}/account',
    'GET /api/v1/storefront/{store}/account/addresses',
    'POST /api/v1/storefront/{store}/account/addresses',
    'PATCH /api/v1/storefront/{store}/account/addresses/{addressId}',
    'DELETE /api/v1/storefront/{store}/account/addresses/{addressId}',
    'GET /api/v1/storefront/{store}/account/orders',
    'GET /api/v1/storefront/{store}/account/orders/{orderId}',
    'POST /api/v1/storefront/{store}/account/orders/{orderId}/pay',
    'GET /api/v1/storefront/{store}/cart',
    'DELETE /api/v1/storefront/{store}/cart',
    'PUT /api/v1/storefront/{store}/cart/items/{variantId}',
    'DELETE /api/v1/storefront/{store}/cart/items/{variantId}',
    'POST /api/v1/storefront/{store}/checkout',
  ];

  it('OpenAPI JSON endpoint responds successfully', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.openapi).toBeDefined();
  });

  it('OpenAPI JSON is also available at /openapi.json and /api/v1/openapi.json', async () => {
    const r1 = await request(app).get('/openapi.json');
    expect(r1.status).toBe(200);
    expect(r1.body.openapi).toBeDefined();
    const r2 = await request(app).get('/api/v1/openapi.json');
    expect(r2.status).toBe(200);
    expect(r2.body.openapi).toBeDefined();
  });

  it('OpenAPI document is valid and version is 3.x', async () => {
    const res = await request(app).get('/api-docs.json');
    const spec = res.body;
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('PulseOps API');
    expect(spec.info.version).toBeDefined();
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('Swagger UI loads successfully', async () => {
    const res = await request(app).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/swagger/i);
  });

  it('All documented paths correspond to actual production routes (inventory)', async () => {
    const spec = openApiSpec;
    for (const key of allExpected) {
      const [method, path] = key.split(' ');
      const lower = method.toLowerCase();
      expect(spec.paths[path]).toBeDefined();
      expect(spec.paths[path][lower]).toBeDefined();
    }
  });

  it('No unexpected extra API paths are documented beyond inventory (no phantom endpoints)', async () => {
    const specPaths = Object.keys(openApiSpec.paths);
    // Collect documented API endpoints as METHOD PATH
    const documented = [];
    for (const p of specPaths) {
      for (const m of Object.keys(openApiSpec.paths[p])) {
        documented.push(`${m.toUpperCase()} ${p}`);
      }
    }
    const expectedSet = new Set(allExpected);
    for (const d of documented) {
      expect(expectedSet.has(d)).toBe(true);
    }
    expect(documented.length).toBe(allExpected.length);
  });

  it('HTTP methods match actual routes (PUT only for full-set replacements)', async () => {
    const putPaths = [];
    for (const [path, methods] of Object.entries(openApiSpec.paths)) {
      if (methods.put) putPaths.push(path);
    }
    expect(putPaths.sort()).toEqual([
      '/api/v1/products/{productId}/variants/{variantId}/attributes',
      '/api/v1/roles/{id}/permissions',
      // Phase 32: sets a cart line's quantity (idempotent; 0 removes)
      '/api/v1/storefront/{store}/cart/items/{variantId}',
    ].sort());
  });

  it('Protected endpoints have bearerAuth security', async () => {
    const spec = openApiSpec;
    // Sample protected endpoints
    const protectedSamples = [
      'GET /api/v1/auth/me',
      'GET /api/v1/roles',
      'GET /api/v1/products',
      'POST /api/v1/orders',
      'GET /api/v1/inventory',
      'GET /api/v1/storage/file',
    ];
    for (const key of protectedSamples) {
      const [method, path] = key.split(' ');
      const op = spec.paths[path][method.toLowerCase()];
      expect(op.security).toBeDefined();
      expect(op.security.length).toBeGreaterThan(0);
      expect(op.security[0].bearerAuth).toBeDefined();
    }
  });

  it('Public endpoints are not incorrectly marked protected', async () => {
    const spec = openApiSpec;
    for (const key of expectedPublic) {
      const [method, path] = key.split(' ');
      const op = spec.paths[path]?.[method.toLowerCase()];
      expect(op).toBeDefined();
      // Public should have security: [] or no bearerAuth
      const hasBearer = op.security && op.security.some((s) => s.bearerAuth !== undefined);
      expect(hasBearer).toBe(false);
    }
  });

  it('Important schemas are present', async () => {
    const schemas = openApiSpec.components.schemas;
    const requiredSchemas = [
      'ErrorResponse',
      'PaginationMeta',
      'Tenant',
      'User',
      'Role',
      'Permission',
      'Product',
      'ProductVariant',
      'AttributeDefinition',
      'AttributeValue',
      'ProductImage',
      'Warehouse',
      'Inventory',
      'Order',
      'Payment',
      'Notification',
      'AuditLog',
      'ActivityLog',
    ];
    for (const s of requiredSchemas) {
      expect(schemas[s]).toBeDefined();
    }
  });

  it('Request documentation includes parameters, body, and responses for representative endpoints', async () => {
    const spec = openApiSpec;
    // Product creation has requestBody with required name
    const createProduct = spec.paths['/api/v1/products'].post;
    expect(createProduct.requestBody).toBeDefined();
    expect(createProduct.requestBody.content['application/json'].schema.required).toContain('name');
    expect(createProduct.responses['201']).toBeDefined();
    expect(createProduct.responses['400']).toBeDefined();
    expect(createProduct.responses['401']).toBeDefined();
    expect(createProduct.responses['403']).toBeDefined();

    // Legacy tenant CRUD is platform-only since Phase 26
    const createTenant = spec.paths['/api/v1/tenants'].post;
    expect(createTenant.security).toEqual([{ bearerAuth: [] }]);
    expect(createTenant.responses['401']).toBeDefined();
    expect(createTenant.responses['403']).toBeDefined();
    expect(createTenant.requestBody.content['application/json'].schema.required).toContain('slug');

    // Payments webhook public with header params
    const webhook = spec.paths['/api/v1/payments/webhook'].post;
    expect(webhook.security).toEqual([]);
    expect(webhook.parameters.some((p) => p.name === 'X-Webhook-Signature')).toBe(true);
    expect(webhook.requestBody.content['application/json'].schema.required).toContain('eventId');

    // Inventory adjust with variant alias
    const adjust = spec.paths['/api/v1/inventory/adjust'].post;
    expect(adjust.requestBody).toBeDefined();
  });

  it('Swagger does not break normal application startup - health still works', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    const apiH = await request(app).get('/api/v1/health');
    expect(apiH.status).toBe(200);
  });

  it('Representative unauthenticated public endpoint does not require auth', async () => {
    // Login without a body is a validation error, never an auth error
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('Legacy tenant CRUD requires a platform token (Phase 26)', async () => {
    const res = await request(app).post('/api/v1/tenants').send({});
    expect(res.status).toBe(401);
  });

  it('Representative authenticated endpoint requires auth', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('Error response structure is documented', async () => {
    const errSchema = openApiSpec.components.schemas.ErrorResponse;
    expect(errSchema.properties.success).toBeDefined();
    expect(errSchema.properties.error).toBeDefined();
    expect(errSchema.properties.error.properties.code).toBeDefined();
    expect(errSchema.properties.error.properties.message).toBeDefined();
    expect(errSchema.properties.requestId).toBeDefined();
  });

  it('Tags cover all major domains', async () => {
    const tags = openApiSpec.tags.map((t) => t.name);
    expect(tags).toEqual(expect.arrayContaining(['Health', 'Tenants', 'Auth', 'Products', 'Orders', 'Payments', 'Inventory', 'Analytics']));
  });
});
