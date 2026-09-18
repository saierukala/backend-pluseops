import { schemas } from './components/schemas.js';
import { healthPaths, readinessPaths } from './paths/health.js';
import { metricsPaths } from './paths/metrics.js';
import { tenantsPaths } from './paths/tenants.js';
import { authPaths } from './paths/auth.js';
import { rbacPaths } from './paths/rbac.js';
import { catalogPaths } from './paths/catalog.js';
import { inventoryWarehousesPaths } from './paths/inventory-warehouses.js';
import { ordersPaymentsPaths } from './paths/orders-payments.js';
import { auditNotificationsPaths } from './paths/audit-notifications.js';
import { jobsPaths } from './paths/jobs.js';
import { analyticsStoragePaths } from './paths/analytics-storage.js';

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'PulseOps API',
    description:
      'Modular monolith API for PulseOps — multi-tenant e-commerce and operations platform. All endpoints under `/api/v1` except health checks which are also available at `/health`. JWT Bearer authentication. Tenant isolation derived from authenticated identity; client-supplied tenant IDs are ignored or validated. Response envelope: `{success, data, message, meta, requestId}` for success and `{success:false, error:{code,message,details}, requestId}` for errors. RequestId is echoed via `X-Request-Id` header.',
    version: '1.0.0',
    contact: { name: 'PulseOps API Support', url: 'https://pulseops.example.com' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  tags: [
    { name: 'Health', description: 'Service health probes (public)' },
    { name: 'Readiness', description: 'Service readiness probes (public)' },
    { name: 'Metrics', description: 'Application metrics (public)' },
    { name: 'Tenants', description: 'Tenant provisioning (public)' },
    { name: 'Auth', description: 'Authentication, registration, tokens, password flows' },
    { name: 'Roles', description: 'Tenant role management' },
    { name: 'Permissions', description: 'Tenant permissions' },
    { name: 'Users', description: 'Tenant user management' },
    { name: 'Categories', description: 'Product category hierarchy' },
    { name: 'Products', description: 'Product catalog' },
    { name: 'Variants', description: 'Product variants and attributes' },
    { name: 'Attributes', description: 'Attribute definitions and values' },
    { name: 'Product Images', description: 'Product and variant images (multipart)' },
    { name: 'Warehouses', description: 'Warehouse management' },
    { name: 'Inventory', description: 'Inventory and movements' },
    { name: 'Orders', description: 'Order lifecycle' },
    { name: 'Payments', description: 'Payments and webhooks' },
    { name: 'Audit', description: 'Audit and activity logs' },
    { name: 'Notifications', description: 'Notifications and preferences' },
    { name: 'Jobs', description: 'Background jobs (BullMQ)' },
    { name: 'Dashboard', description: 'Dashboard aggregates' },
    { name: 'Analytics', description: 'Analytics aggregates' },
    { name: 'Storage', description: 'File storage (signed and authenticated)' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token from /api/v1/auth/login or /api/v1/auth/refresh. Send as `Authorization: Bearer <token>`.',
      },
    },
    schemas,
    responses: {
      ValidationError: {
        description: 'Validation error (Zod)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: [{ path: ['body', 'email'], message: 'Invalid email' }] }, requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' } } },
      },
      Unauthorized: {
        description: 'Unauthorized - missing, expired, or invalid token. Includes TOKEN_EXPIRED, INVALID_TOKEN, INVALID_TOKEN_CLAIMS, USER_NOT_FOUND.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, error: { code: 'TOKEN_EXPIRED', message: 'Token expired', details: null }, requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' } } },
      },
      Forbidden: {
        description: 'Forbidden - tenant inactive or missing permission (e.g., FORBIDDEN).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' }, example: { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions', details: null }, requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' } } },
      },
      NotFound: {
        description: 'Not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      RateLimited: {
        description: 'Too many requests',
        headers: { 'Retry-After': { schema: { type: 'integer' } } },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
    },
    parameters: {
      RequestIdHeader: {
        name: 'X-Request-Id',
        in: 'header',
        schema: { type: 'string', format: 'uuid' },
        description: 'Optional request correlation ID. If omitted, server generates one and returns it in response header.',
      },
    },
  },
  paths: {
    ...healthPaths,
    ...readinessPaths,
    ...metricsPaths,
    ...tenantsPaths,
    ...authPaths,
    ...rbacPaths,
    ...catalogPaths,
    ...inventoryWarehousesPaths,
    ...ordersPaymentsPaths,
    ...auditNotificationsPaths,
    ...jobsPaths,
    ...analyticsStoragePaths,
  },
  security: [],
};
