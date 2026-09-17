const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const analyticsStoragePaths = {
  '/api/v1/analytics/overview': {
    get: {
      tags: ['Analytics'],
      summary: 'Analytics overview',
      description: 'Requires `analytics:read`. tenantId query param is ignored (uses JWT tenant).',
      operationId: 'getAnalyticsOverview',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
      ],
      responses: {
        200: { description: 'Analytics overview', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/analytics/sales': {
    get: {
      tags: ['Analytics'],
      summary: 'Sales analytics',
      description: 'Requires `analytics:read`.',
      operationId: 'getAnalyticsSales',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'category', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'categoryId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'product', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'productId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } },
      ],
      responses: {
        200: { description: 'Sales analytics', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/analytics/orders': {
    get: {
      tags: ['Analytics'],
      summary: 'Orders analytics',
      description: 'Requires `analytics:read`.',
      operationId: 'getAnalyticsOrders',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } },
      ],
      responses: {
        200: { description: 'Orders analytics', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/analytics/inventory': {
    get: {
      tags: ['Analytics'],
      summary: 'Inventory analytics',
      description: 'Requires `analytics:read`.',
      operationId: 'getAnalyticsInventory',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'category', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'categoryId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'product', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'productId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'warehouseId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'warehouse', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'DRAFT', 'ARCHIVED'] } },
      ],
      responses: {
        200: { description: 'Inventory analytics', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/analytics/customers': {
    get: {
      tags: ['Analytics'],
      summary: 'Customers analytics',
      description: 'Requires `analytics:read`.',
      operationId: 'getAnalyticsCustomers',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: {
        200: { description: 'Customers analytics', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/analytics/revenue': {
    get: {
      tags: ['Analytics'],
      summary: 'Revenue analytics',
      description: 'Requires `analytics:read`.',
      operationId: 'getAnalyticsRevenue',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'groupBy', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED'] } },
      ],
      responses: {
        200: { description: 'Revenue analytics', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/storage/signed': {
    get: {
      tags: ['Storage'],
      summary: 'Get file via signed URL',
      description: 'Public. HMAC verified, expiry checked. Query params: key, expires, signature. No bearer token.',
      operationId: 'getSignedFile',
      security: [],
      parameters: [
        { name: 'key', in: 'query', required: true, schema: { type: 'string', example: 'tenants/abc/images/file.jpg' } },
        { name: 'expires', in: 'query', required: true, schema: { type: 'string', example: '1730000000' }, description: 'Unix timestamp expiry' },
        { name: 'signature', in: 'query', required: true, schema: { type: 'string' }, description: 'HMAC signature' },
      ],
      responses: {
        200: { description: 'File stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        400: { description: 'Missing/invalid params or signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Signature mismatch or expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/storage/file': {
    get: {
      tags: ['Storage'],
      summary: 'Get file via authenticated access',
      description: 'Requires authentication. Tenant isolation: key must start with tenants/{tenantId}/.',
      operationId: 'getAuthenticatedFile',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string', example: 'tenants/abc/images/file.jpg' } }],
      responses: {
        200: { description: 'File stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
};
