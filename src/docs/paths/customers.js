const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error409 = { description: 'Email already used by a customer of this tenant (`CUSTOMER_EMAIL_EXISTS`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

const ok = (description, schema, extra = {}) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema, ...extra } } } },
});
const customer = { $ref: '#/components/schemas/Customer' };
const address = { $ref: '#/components/schemas/CustomerAddress' };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Customer ID' };
const addressIdParam = { name: 'addressId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];

const addressProperties = {
  type: { type: 'string', enum: ['SHIPPING', 'BILLING'] },
  label: { type: 'string', maxLength: 100, nullable: true, example: 'Home' },
  firstName: { type: 'string', maxLength: 100, nullable: true },
  lastName: { type: 'string', maxLength: 100, nullable: true },
  company: { type: 'string', maxLength: 255, nullable: true },
  line1: { type: 'string', minLength: 1, maxLength: 255 },
  line2: { type: 'string', maxLength: 255, nullable: true },
  city: { type: 'string', minLength: 1, maxLength: 100 },
  state: { type: 'string', maxLength: 100, nullable: true },
  postalCode: { type: 'string', maxLength: 20, nullable: true },
  country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'ISO 3166-1 alpha-2, stored upper-case', example: 'IN' },
  phone: { type: 'string', maxLength: 30, nullable: true },
  isDefault: { type: 'boolean', description: 'true makes this the default of its type. The first address of a type is always the default.' },
};
const addressBody = { type: 'object', required: ['type', 'line1', 'city', 'country'], properties: addressProperties };

const customerProperties = {
  email: { type: 'string', format: 'email', description: 'Trimmed and lower-cased; unique per tenant (soft-deleted customers keep theirs)' },
  firstName: { type: 'string', minLength: 1, maxLength: 100 },
  lastName: { type: 'string', minLength: 1, maxLength: 100 },
  phone: { type: 'string', maxLength: 30, nullable: true },
  metadata: { type: 'object' },
};

export const customersPaths = {
  '/api/v1/customers': {
    post: {
      tags: ['Customers'],
      summary: 'Create customer',
      description: 'Requires `customer:create`. Addresses can be created in the same request.',
      operationId: 'createCustomer',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['email', 'firstName', 'lastName'], properties: { ...customerProperties, addresses: { type: 'array', maxItems: 20, items: addressBody } } } } },
      },
      responses: { 201: ok('Customer created', customer), 400: error400, 401: error401, 403: error403, 409: error409, 500: error500 },
    },
    get: {
      tags: ['Customers'],
      summary: 'List customers',
      description: 'Requires `customer:read`. Soft-deleted customers are excluded. `search` matches email, first/last name and phone.',
      operationId: 'listCustomers',
      security: [{ bearerAuth: [] }],
      parameters: [
        ...pageParams,
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 255 } },
        { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'email', 'lastName'], default: 'createdAt' } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: { 200: ok('Customers retrieved', { type: 'array', items: customer }, { meta: { $ref: '#/components/schemas/PaginationMeta' } }), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
  },
  '/api/v1/customers/{id}': {
    get: {
      tags: ['Customers'],
      summary: 'Get customer with addresses',
      description: 'Requires `customer:read`.',
      operationId: 'getCustomer',
      security: [{ bearerAuth: [] }],
      parameters: [idParam],
      responses: { 200: ok('Customer retrieved', customer), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    patch: {
      tags: ['Customers'],
      summary: 'Update customer',
      description: 'Requires `customer:update`. Addresses are managed under `/addresses`.',
      operationId: 'updateCustomer',
      security: [{ bearerAuth: [] }],
      parameters: [idParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: customerProperties } } } },
      responses: { 200: ok('Customer updated', customer), 400: error400, 401: error401, 403: error403, 404: error404, 409: error409, 500: error500 },
    },
    delete: {
      tags: ['Customers'],
      summary: 'Delete customer (soft)',
      description: 'Requires `customer:delete`. The customer disappears from reads and cannot place new orders; existing orders are kept.',
      operationId: 'deleteCustomer',
      security: [{ bearerAuth: [] }],
      parameters: [idParam],
      responses: { 200: ok('Customer deleted', { nullable: true, example: null }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/customers/{id}/orders': {
    get: {
      tags: ['Customers'],
      summary: 'Customer order history',
      description: 'Requires `customer:read` **and** `order:read`. Newest first.',
      operationId: 'listCustomerOrders',
      security: [{ bearerAuth: [] }],
      parameters: [idParam, ...pageParams, { name: 'status', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }],
      responses: { 200: ok('Orders retrieved', { type: 'array', items: { $ref: '#/components/schemas/Order' } }, { meta: { $ref: '#/components/schemas/PaginationMeta' } }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/customers/{id}/addresses': {
    get: {
      tags: ['Customers'],
      summary: 'List customer addresses',
      description: 'Requires `customer:read`. Ordered by type, default first.',
      operationId: 'listCustomerAddresses',
      security: [{ bearerAuth: [] }],
      parameters: [idParam, { name: 'type', in: 'query', schema: { type: 'string', enum: ['SHIPPING', 'BILLING'] } }],
      responses: { 200: ok('Addresses retrieved', { type: 'array', items: address }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    post: {
      tags: ['Customers'],
      summary: 'Add customer address',
      description: 'Requires `customer:update`.',
      operationId: 'createCustomerAddress',
      security: [{ bearerAuth: [] }],
      parameters: [idParam],
      requestBody: { required: true, content: { 'application/json': { schema: addressBody } } },
      responses: { 201: ok('Address created', address), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/customers/{id}/addresses/{addressId}': {
    patch: {
      tags: ['Customers'],
      summary: 'Update customer address',
      description: 'Requires `customer:update`. Set `isDefault: true` on another address to move the default. Orders keep their own snapshot.',
      operationId: 'updateCustomerAddress',
      security: [{ bearerAuth: [] }],
      parameters: [idParam, addressIdParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: addressProperties } } } },
      responses: { 200: ok('Address updated', address), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    delete: {
      tags: ['Customers'],
      summary: 'Delete customer address',
      description: 'Requires `customer:update`. Deleting the default promotes the oldest remaining address of that type.',
      operationId: 'deleteCustomerAddress',
      security: [{ bearerAuth: [] }],
      parameters: [idParam, addressIdParam],
      responses: { 200: ok('Address deleted', { nullable: true, example: null }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
};
