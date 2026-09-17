const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const ordersPaymentsPaths = {
  '/api/v1/orders': {
    post: {
      tags: ['Orders'],
      summary: 'Create order',
      description: 'Requires `order:create`. Validates productId forbidden (use items.productVariantId).',
      operationId: 'createOrder',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['customerId', 'items'],
              properties: {
                customerId: { type: 'string', format: 'uuid' },
                items: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['productVariantId', 'warehouseId', 'quantity'],
                    properties: {
                      productVariantId: { type: 'string', format: 'uuid' },
                      variantId: { type: 'string', format: 'uuid', description: 'Alias' },
                      warehouseId: { type: 'string', format: 'uuid' },
                      quantity: { type: 'integer', minimum: 1 },
                      discount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                      tax: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                    },
                  },
                },
                shippingTotal: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                currency: { type: 'string', minLength: 3, maxLength: 3, example: 'USD' },
                metadata: { type: 'object' },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        201: { description: 'Order created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Order' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
    get: {
      tags: ['Orders'],
      summary: 'List orders',
      description: 'Requires `order:read`.',
      operationId: 'listOrders',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } },
        { name: 'customerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'total', 'status'], default: 'createdAt' } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: {
        200: { description: 'Orders retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Order' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/orders/{id}': {
    get: {
      tags: ['Orders'],
      summary: 'Get order by ID',
      description: 'Requires `order:read`.',
      operationId: 'getOrder',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Order retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Order' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/orders/{id}/status': {
    patch: {
      tags: ['Orders'],
      summary: 'Update order status',
      description: 'Requires `order:update`.',
      operationId: 'updateOrderStatus',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] }, reason: { type: 'string', maxLength: 500 } } } } },
      },
      responses: {
        200: { description: 'Order status updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Order' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/orders/{id}/cancel': {
    post: {
      tags: ['Orders'],
      summary: 'Cancel order',
      description: 'Requires `order:cancel` (distinct permission).',
      operationId: 'cancelOrder',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: false,
        content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } } } },
      },
      responses: {
        200: { description: 'Order cancelled', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Order' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/orders/{id}/history': {
    get: {
      tags: ['Orders'],
      summary: 'Get order history',
      description: 'Requires `order:read`.',
      operationId: 'getOrderHistory',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      ],
      responses: {
        200: { description: 'Order history', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { type: 'object' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/payments/webhook': {
    post: {
      tags: ['Payments'],
      summary: 'Payment webhook',
      description: 'Public. HMAC verified via X-Webhook-Signature or X-Payment-Signature. Rate-limited (webhook limiter). Raw body preserved for signature verification. Provider signs raw bytes.',
      operationId: 'paymentWebhook',
      security: [],
      parameters: [
        { name: 'X-Webhook-Signature', in: 'header', schema: { type: 'string' }, description: 'HMAC signature' },
        { name: 'X-Payment-Signature', in: 'header', schema: { type: 'string' }, description: 'Alternative signature header' },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['eventId', 'type'],
              properties: {
                eventId: { type: 'string', minLength: 1, maxLength: 255 },
                type: { type: 'string', enum: ['payment.succeeded', 'payment.failed', 'payment.refunded', 'charge.succeeded', 'charge.failed'] },
                paymentId: { type: 'string', format: 'uuid' },
                providerPaymentId: { type: 'string', maxLength: 255 },
                providerTransactionId: { type: 'string', maxLength: 255 },
                amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
                tenantId: { type: 'string', format: 'uuid' },
                metadata: { type: 'object' },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: { description: 'Webhook processed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' }, message: { type: 'string' } } } } } },
        400: error400,
        401: { description: 'Invalid signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        429: { description: 'Rate limited', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: error500,
      },
    },
  },
  '/api/v1/payments/create': {
    post: {
      tags: ['Payments'],
      summary: 'Create payment',
      description: 'Requires `payment:create`. Strict body.',
      operationId: 'createPayment',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['orderId'],
              properties: {
                orderId: { type: 'string', format: 'uuid' },
                provider: { type: 'string', maxLength: 50 },
                currency: { type: 'string', minLength: 3, maxLength: 3 },
                metadata: { type: 'object' },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        201: { description: 'Payment created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Payment' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/payments/confirm': {
    post: {
      tags: ['Payments'],
      summary: 'Confirm payment',
      description: 'Requires `payment:confirm`.',
      operationId: 'confirmPayment',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['paymentId'],
              properties: {
                paymentId: { type: 'string', format: 'uuid' },
                providerPaymentId: { type: 'string', maxLength: 255 },
                simulateFailure: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        200: { description: 'Payment confirmed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Payment' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/payments/{id}': {
    get: {
      tags: ['Payments'],
      summary: 'Get payment by ID',
      description: 'Requires `payment:read`.',
      operationId: 'getPayment',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Payment retrieved', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Payment' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/payments/{id}/refund': {
    post: {
      tags: ['Payments'],
      summary: 'Refund payment',
      description: 'Requires `payment:refund`.',
      operationId: 'refundPayment',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount'],
              properties: {
                amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', example: '50.00' },
                reason: { type: 'string', maxLength: 500 },
                metadata: { type: 'object' },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        200: { description: 'Refund initiated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Refund' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
};
