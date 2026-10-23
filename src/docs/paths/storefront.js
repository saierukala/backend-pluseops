const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const e400 = err('Validation error');
const e401 = err('Not signed in, expired/ended session (`SESSION_REVOKED`) or a token from another store (`WRONG_STORE`)');
const e403 = err('Not a shopper token (`CUSTOMER_AUTH_REQUIRED`)');
const e404 = err('Store or resource not found (`STORE_NOT_FOUND` for unknown or suspended stores)');
const e409 = (d) => err(d);
const e500 = err('Internal server error');
const ok = (description, schema, extra = {}) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema, ...extra } } } },
});
const pub = [];
const shopper = [{ customerAuth: [] }];
const store = { name: 'store', in: 'path', required: true, schema: { type: 'string' }, description: 'Tenant slug' };
const uuidParam = (name) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const meta = { meta: { $ref: '#/components/schemas/PaginationMeta' } };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const tags = ['Storefront'];
const authTags = ['Storefront Auth'];
const accountTags = ['Storefront Account'];

const tokens = ok('Signed in', ref('StorefrontSession'));
const accepted = { description: 'Accepted — the same answer whether or not the email has an account', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { message: { type: 'string' }, devToken: { type: 'string', description: 'development/test only' } } } } } } } };
const password = { type: 'string', minLength: 8, maxLength: 128, description: 'Upper, lower, digit and symbol' };
const addressBody = { type: 'object', required: ['type', 'line1', 'city', 'country'], properties: { type: { type: 'string', enum: ['SHIPPING', 'BILLING'] }, label: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, company: { type: 'string' }, line1: { type: 'string' }, line2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, postalCode: { type: 'string' }, country: { type: 'string', example: 'IN' }, phone: { type: 'string' }, isDefault: { type: 'boolean' } } };

export const storefrontPaths = {
  '/api/v1/storefront/resolve': {
    get: {
      tags, summary: 'Resolve a host name to a store', operationId: 'resolveStorefrontHost', security: pub,
      description: 'Public. A **verified** custom domain, or `<slug>.<STOREFRONT_BASE_DOMAIN>` when configured. Unverified domains never resolve.',
      parameters: [{ name: 'host', in: 'query', required: true, schema: { type: 'string', example: 'shop.example.com' } }],
      responses: { 200: ok('Store', ref('StorefrontStore')), 400: e400, 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}': {
    get: {
      tags, summary: 'Store info', operationId: 'getStorefront', security: pub, description: 'Public. Name, currency, locale and contact details.',
      parameters: [store], responses: { 200: ok('Store', ref('StorefrontStore')), 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/categories': {
    get: {
      tags, summary: 'Active categories', operationId: 'listStorefrontCategories', security: pub, description: 'Public. Flat list with `parentId` for building a tree.',
      parameters: [store], responses: { 200: ok('Categories', { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string', nullable: true }, parentId: { type: 'string', nullable: true } } } }), 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/products': {
    get: {
      tags, summary: 'Product cards', operationId: 'listStorefrontProducts', security: pub,
      description: 'Public. Only ACTIVE products with at least one ACTIVE variant. `category` is a category slug (direct membership). Price filters match any variant. Images are signed URLs valid 1 hour. Availability only — never stock levels or cost prices.',
      parameters: [store,
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Name, brand, description' },
        { name: 'category', in: 'query', schema: { type: 'string' } },
        { name: 'minPrice', in: 'query', schema: { type: 'number' } },
        { name: 'maxPrice', in: 'query', schema: { type: 'number' } },
        { name: 'inStock', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'name'], default: 'newest' } },
        { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 60, default: 24 } }],
      responses: { 200: ok('Products', { type: 'array', items: ref('StorefrontProductCard') }, meta), 400: e400, 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/products/{productId}': {
    get: {
      tags, summary: 'Product detail', operationId: 'getStorefrontProduct', security: pub, description: 'Public. Variants with price, attributes and `inStock`; images; categories.',
      parameters: [store, uuidParam('productId')], responses: { 200: ok('Product', ref('StorefrontProduct')), 400: e400, 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/register': {
    post: {
      tags: authTags, summary: 'Sign up (emails a code)', operationId: 'storefrontRegister', security: pub,
      description: 'Accounts are per store. Emails a 24-hour code; the shopper chooses the password with `set-password`, so registering someone else\'s email gives no access. An existing customer record with this email (e.g. created by staff) is claimed by the person who receives the email.',
      parameters: [store], requestBody: json({ type: 'object', required: ['email', 'firstName', 'lastName'], properties: { email: { type: 'string', format: 'email' }, firstName: { type: 'string' }, lastName: { type: 'string' }, phone: { type: 'string' } } }),
      responses: { 202: accepted, 400: e400, 404: e404, 429: err('Rate limited'), 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/set-password': {
    post: {
      tags: authTags, summary: 'Redeem the emailed code: set password and sign in', operationId: 'storefrontSetPassword', security: pub,
      description: 'Verifies the email, sets the password, ends other sessions and returns tokens. 400 `INVALID_TOKEN` for used/expired codes.',
      parameters: [store], requestBody: json({ type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password } }),
      responses: { 200: tokens, 400: e400, 404: e404, 429: err('Rate limited'), 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/login': {
    post: {
      tags: authTags, summary: 'Sign in', operationId: 'storefrontLogin', security: pub, description: '401 `INVALID_CREDENTIALS` (same for unknown email, wrong password or unverified account).',
      parameters: [store], requestBody: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } }),
      responses: { 200: tokens, 400: e400, 401: err('Invalid email or password'), 404: e404, 429: err('Rate limited'), 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/forgot-password': {
    post: {
      tags: authTags, summary: 'Email a password reset code', operationId: 'storefrontForgotPassword', security: pub,
      parameters: [store], requestBody: json({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }),
      responses: { 202: accepted, 400: e400, 404: e404, 429: err('Rate limited'), 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/refresh': {
    post: {
      tags: authTags, summary: 'Rotate the refresh token', operationId: 'storefrontRefresh', security: pub, description: 'Replaying an already-rotated token ends the whole session (401).',
      parameters: [store], requestBody: json({ type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } }),
      responses: { 200: tokens, 400: e400, 401: err('Invalid or expired refresh token'), 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/auth/logout': {
    post: {
      tags: authTags, summary: 'Sign out', operationId: 'storefrontLogout', security: pub, description: 'Ends the session; its access token stops working at once.',
      parameters: [store], requestBody: json({ type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } }),
      responses: { 200: ok('Signed out', { nullable: true, example: null }), 400: e400, 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/account': {
    get: { tags: accountTags, summary: 'My profile', operationId: 'getStorefrontAccount', security: shopper, parameters: [store], responses: { 200: ok('Profile', ref('StorefrontCustomer')), 401: e401, 403: e403, 404: e404, 500: e500 } },
    patch: {
      tags: accountTags, summary: 'Update my profile', operationId: 'updateStorefrontAccount', security: shopper, parameters: [store],
      requestBody: json({ type: 'object', minProperties: 1, properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, phone: { type: 'string', nullable: true } } }),
      responses: { 200: ok('Profile', ref('StorefrontCustomer')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/account/addresses': {
    get: { tags: accountTags, summary: 'My addresses', operationId: 'listStorefrontAddresses', security: shopper, parameters: [store, { name: 'type', in: 'query', schema: { type: 'string', enum: ['SHIPPING', 'BILLING'] } }], responses: { 200: ok('Addresses', { type: 'array', items: ref('CustomerAddress') }), 401: e401, 403: e403, 404: e404, 500: e500 } },
    post: { tags: accountTags, summary: 'Add an address', operationId: 'createStorefrontAddress', security: shopper, parameters: [store], requestBody: json(addressBody), responses: { 201: ok('Address', ref('CustomerAddress')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/account/addresses/{addressId}': {
    patch: { tags: accountTags, summary: 'Update an address', operationId: 'updateStorefrontAddress', security: shopper, parameters: [store, uuidParam('addressId')], requestBody: json({ ...addressBody, required: [], minProperties: 1 }), responses: { 200: ok('Address', ref('CustomerAddress')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
    delete: { tags: accountTags, summary: 'Delete an address', operationId: 'deleteStorefrontAddress', security: shopper, parameters: [store, uuidParam('addressId')], responses: { 200: ok('Deleted', { nullable: true, example: null }), 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/account/orders': {
    get: { tags: accountTags, summary: 'My orders', operationId: 'listStorefrontOrders', security: shopper, parameters: [store, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50 } }], responses: { 200: ok('Orders', { type: 'array', items: ref('StorefrontOrder') }, meta), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/account/orders/{orderId}': {
    get: { tags: accountTags, summary: 'Track an order', operationId: 'getStorefrontOrder', security: shopper, description: 'Own orders only. `timeline` lists each status with its time; `payments` the payment attempts.', parameters: [store, uuidParam('orderId')], responses: { 200: ok('Order', ref('StorefrontOrder')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/account/orders/{orderId}/pay': {
    post: { tags: accountTags, summary: 'Start a payment for my order', operationId: 'payStorefrontOrder', security: shopper, description: 'For when checkout could not start the payment, or the shopper closed Razorpay\'s window. With Razorpay connected, the same Razorpay order is reused while the amount is unchanged; 409 `ORDER_ALREADY_PAID`. Without it, 409 `PAYMENT_ALREADY_PENDING` if one is pending.', parameters: [store, uuidParam('orderId')], responses: { 201: ok('Payment', ref('StorefrontPayment')), 409: e409('A payment is already pending'), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/account/payments/{paymentId}/verify': {
    post: {
      tags: accountTags, summary: 'Confirm a Razorpay payment', operationId: 'verifyStorefrontPayment', security: shopper,
      description: 'Phase 35. Send what Razorpay checkout\'s handler received. The HMAC of `razorpayOrderId|razorpayPaymentId` with the shop\'s key secret must match, and the order id must be this payment\'s; then the payment is COMPLETED. Repeats are harmless. 400 `INVALID_PAYMENT_SIGNATURE`; 404 if the payment is not one of my orders. The shop\'s webhook confirms the payment too, if this call never arrives.',
      parameters: [store, uuidParam('paymentId')],
      requestBody: json({ type: 'object', required: ['razorpayOrderId', 'razorpayPaymentId', 'razorpaySignature'], properties: { razorpayOrderId: { type: 'string' }, razorpayPaymentId: { type: 'string' }, razorpaySignature: { type: 'string', pattern: '^[a-f0-9]{64}$' } } }),
      responses: { 200: ok('Payment confirmed', ref('StorefrontPayment')), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409('`PAYMENT_GATEWAY_NOT_CONFIGURED`'), 500: e500 },
    },
  },
  '/api/v1/storefront/{store}/cart': {
    get: { tags: accountTags, summary: 'My cart (server-priced)', operationId: 'getStorefrontCart', security: shopper, description: 'Current prices; each line says whether it can be bought (`issue`: UNAVAILABLE | INSUFFICIENT_STOCK). `subtotal` counts only buyable lines.', parameters: [store], responses: { 200: ok('Cart', ref('StorefrontCart')), 401: e401, 403: e403, 404: e404, 500: e500 } },
    delete: { tags: accountTags, summary: 'Empty my cart', operationId: 'clearStorefrontCart', security: shopper, parameters: [store], responses: { 200: ok('Cart', ref('StorefrontCart')), 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/cart/items/{variantId}': {
    put: {
      tags: accountTags, summary: 'Set a cart line quantity', operationId: 'setStorefrontCartItem', security: shopper, description: '`quantity` 0 removes the line. 404 `PRODUCT_NOT_AVAILABLE`, 409 `INSUFFICIENT_STOCK`.',
      parameters: [store, uuidParam('variantId')], requestBody: json({ type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 0, maximum: 100 } } }),
      responses: { 200: ok('Cart', ref('StorefrontCart')), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409('Not enough stock'), 500: e500 },
    },
    delete: { tags: accountTags, summary: 'Remove a cart line', operationId: 'removeStorefrontCartItem', security: shopper, parameters: [store, uuidParam('variantId')], responses: { 200: ok('Cart', ref('StorefrontCart')), 400: e400, 401: e401, 403: e403, 404: e404, 500: e500 } },
  },
  '/api/v1/storefront/{store}/checkout': {
    post: {
      tags: accountTags, summary: 'Place the order from my cart', operationId: 'storefrontCheckout', security: shopper,
      description: 'Server-priced; stock is reserved atomically; each line ships from one warehouse (default first). Addresses default to the shopper\'s defaults. Empties the cart and starts a payment (`payment` is null if that failed — retry with `/account/orders/{id}/pay`). 409 `CART_EMPTY` / `CART_NOT_READY`.',
      parameters: [store], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { shippingAddressId: { type: 'string', format: 'uuid' }, billingAddressId: { type: 'string', format: 'uuid' } } } } } },
      responses: { 201: ok('Order placed', { type: 'object', properties: { order: ref('StorefrontOrder'), payment: { ...ref('StorefrontPayment'), nullable: true } } }), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409('Cart not ready'), 500: e500 },
    },
  },
};
