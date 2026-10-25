const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const e400 = err('Validation error');
const e401 = err('Unauthorized');
const e403 = err('Forbidden (missing permission)');
const e404 = err('Not found');
const e409 = err('Conflict');
const security = [{ bearerAuth: [] }];
const ok = (description, schema = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema } } } },
});
const uuid = { type: 'string', format: 'uuid' };
const money = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', example: '69.62' };
const session = { $ref: '#/components/schemas/CashSession' };
const idempotencyKey = {
  name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 255 },
  description: 'Send a fresh value per attempt. Repeating the request with the same key (double click, retry) returns the first response (header `Idempotent-Replayed: true`) instead of selling twice. Same key with a different body → 422 `IDEMPOTENCY_KEY_REUSED`; while the first is still running → 409 `IDEMPOTENCY_IN_PROGRESS`.',
};
const pathParam = (name, pattern) => ({ name, in: 'path', required: true, schema: pattern ? { type: 'string', pattern } : uuid });
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });

export const posPaths = {
  '/api/v1/pos/context': {
    get: {
      tags: ['POS'], summary: 'What the counter screen needs', operationId: 'posContext', security,
      description: 'Requires `pos:sell`. Walk-in customer, default warehouse, counters with their open shift, default GST rate, whether prices include GST, and how UPI is taken (`razorpay`, `upi-id` or null).',
      responses: { 200: ok('Counter ready'), 401: e401, 403: e403 },
    },
  },
  '/api/v1/pos/lookup': {
    get: {
      tags: ['POS'], summary: 'Find items by barcode, SKU or name', operationId: 'posLookup', security,
      description: 'Requires `pos:sell`. Exact barcode/SKU matches come first (`exactMatch: true`, what a scanner types), then partial matches. Only sellable variants; `stock` is in the given warehouse.',
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 100 } },
        { name: 'warehouseId', in: 'query', schema: uuid },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
      ],
      responses: { 200: ok('Items found', { type: 'array', items: { $ref: '#/components/schemas/PosItem' } }), 400: e400, 401: e401, 403: e403 },
    },
  },
  '/api/v1/pos/sales': {
    post: {
      tags: ['POS'], summary: 'Sell at the counter', operationId: 'posSale', security,
      description: 'Requires `pos:sell`. Creates the GST invoice (channel `POS`), takes the stock, records each payment as COMPLETED and marks the order DELIVERED, all in one transaction. Leave out `customerId` for a walk-in sale. Payments must add up to the invoice total exactly (400 `PAYMENT_TOTAL_MISMATCH`, nothing is sold). Cash needs an open shift on the counter (409 `REGISTER_CLOSED`); `tendered` gives the change. UPI paid on a Razorpay QR passes `razorpayQrId`; the server checks with Razorpay that the exact amount was received and not used before.',
      parameters: [idempotencyKey],
      requestBody: json({
        type: 'object', required: ['items', 'payments'],
        properties: {
          customerId: uuid, warehouseId: uuid, registerId: uuid, note: { type: 'string', maxLength: 500 },
          items: { type: 'array', minItems: 1, items: { type: 'object', required: ['variantId', 'quantity'], properties: { variantId: uuid, quantity: { type: 'integer', minimum: 1 }, discount: money } } },
          payments: {
            type: 'array', minItems: 1, maxItems: 5,
            items: { type: 'object', required: ['method', 'amount'], properties: { method: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'CREDIT'], description: 'CREDIT = pay later (named customer only; stays owing)' }, amount: money, tendered: money, reference: { type: 'string' }, razorpayQrId: { type: 'string', pattern: '^qr_' } } },
          },
        },
      }),
      responses: {
        201: ok('Sale completed', { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' }, payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } }, change: money } }),
        400: e400, 401: e401, 403: e403, 404: e404, 409: e409, 422: err('Idempotency-Key reused for a different request'),
      },
    },
  },
  '/api/v1/pos/held-sales': {
    get: { tags: ['POS'], summary: 'Sales parked at the counter', operationId: 'listHeldSales', security, description: 'Requires `pos:sell`. Newest first.', responses: { 200: ok('Held sales'), 401: e401, 403: e403 } },
    post: {
      tags: ['POS'], summary: 'Park a sale to serve the next customer', operationId: 'holdSale', security, description: 'Requires `pos:sell`.',
      requestBody: json({ type: 'object', required: ['cart'], properties: { label: { type: 'string', maxLength: 100 }, cart: { type: 'object', required: ['items'], properties: { customerId: uuid, items: { type: 'array', items: { type: 'object' } } } } } }),
      responses: { 201: ok('Sale held'), 400: e400, 401: e401, 403: e403 },
    },
  },
  '/api/v1/pos/held-sales/{id}': {
    delete: { tags: ['POS'], summary: 'Remove a held sale (resumed or abandoned)', operationId: 'removeHeldSale', security, description: 'Requires `pos:sell`.', parameters: [pathParam('id')], responses: { 200: ok('Removed'), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/pos/upi-qr': {
    post: {
      tags: ['POS'], summary: 'UPI QR for an amount', operationId: 'posUpiQr', security,
      description: 'Requires `pos:sell`. With Razorpay connected: a single-use, exact-amount Razorpay UPI QR (`qrId`, `imageUrl`, valid 15 minutes). Otherwise a `upi://pay` link for the shop UPI ID in the tax profile (staff confirm the payment). 409 `UPI_NOT_CONFIGURED` when neither is set up.',
      requestBody: json({ type: 'object', required: ['amount'], properties: { amount: money } }),
      responses: { 201: ok('UPI QR ready'), 400: e400, 401: e401, 403: e403, 409: e409 },
    },
  },
  '/api/v1/pos/upi-qr/{qrId}': {
    get: { tags: ['POS'], summary: 'Has the Razorpay UPI QR been paid?', operationId: 'posUpiQrStatus', security, description: 'Requires `pos:sell`. The counter asks every few seconds.', parameters: [pathParam('qrId', '^qr_')], responses: { 200: ok('Status', { type: 'object', properties: { paid: { type: 'boolean' }, amount: money, razorpayPaymentId: { type: 'string' } } }), 401: e401, 403: e403, 409: e409 } },
  },
  '/api/v1/cash-registers': {
    get: { tags: ['Cash register'], summary: 'Counters and their open shift', operationId: 'listCashRegisters', security, description: 'Requires `cash_register:read`. A "Main counter" is created on first use.', responses: { 200: ok('Registers'), 401: e401, 403: e403 } },
    post: { tags: ['Cash register'], summary: 'Add a counter', operationId: 'createCashRegister', security, description: 'Requires `cash_register:manage`.', requestBody: json({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 } } }), responses: { 201: ok('Register created'), 400: e400, 401: e401, 403: e403, 409: e409 } },
  },
  '/api/v1/cash-registers/{registerId}/open': {
    post: {
      tags: ['Cash register'], summary: 'Open a shift with a float', operationId: 'openCashRegister', security, description: 'Requires `cash_register:manage`. One open shift per counter (409 `REGISTER_ALREADY_OPEN`).',
      parameters: [pathParam('registerId')], requestBody: json({ type: 'object', properties: { openingFloat: money, note: { type: 'string' } } }),
      responses: { 201: ok('Register opened', session), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/cash-registers/{registerId}/current': {
    get: { tags: ['Cash register'], summary: 'The open shift and its running totals', operationId: 'currentCashSession', security, description: 'Requires `cash_register:read`. `data` is null when the counter is closed.', parameters: [pathParam('registerId')], responses: { 200: ok('Current shift', session), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/cash-registers/sessions': {
    get: {
      tags: ['Cash register'], summary: 'Shift history', operationId: 'listCashSessions', security, description: 'Requires `cash_register:read`. Newest first.',
      parameters: [{ name: 'registerId', in: 'query', schema: uuid }, { name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }],
      responses: { 200: ok('Shifts', { type: 'array', items: session }), 401: e401, 403: e403 },
    },
  },
  '/api/v1/cash-registers/sessions/{sessionId}': {
    get: { tags: ['Cash register'], summary: 'One shift with every cash movement', operationId: 'getCashSession', security, description: 'Requires `cash_register:read`.', parameters: [pathParam('sessionId')], responses: { 200: ok('Shift', session), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/cash-registers/sessions/{sessionId}/movements': {
    post: {
      tags: ['Cash register'], summary: 'Cash in or cash out', operationId: 'addCashMovement', security, description: 'Requires `cash_register:manage`. Cash out can\'t exceed what should be in the drawer (409 `INSUFFICIENT_CASH`).',
      parameters: [pathParam('sessionId')], requestBody: json({ type: 'object', required: ['type', 'amount', 'reason'], properties: { type: { type: 'string', enum: ['CASH_IN', 'CASH_OUT'] }, amount: money, reason: { type: 'string', maxLength: 200 } } }),
      responses: { 201: ok('Cash recorded', session), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/cash-registers/sessions/{sessionId}/close': {
    post: {
      tags: ['Cash register'], summary: 'Close the shift: counted vs expected cash', operationId: 'closeCashSession', security,
      description: 'Requires `cash_register:manage`. expected = float + cash sales − cash refunds + cash in − cash out; `variance` = counted − expected (negative = short).',
      parameters: [pathParam('sessionId')], requestBody: json({ type: 'object', required: ['countedCash'], properties: { countedCash: money, note: { type: 'string' } } }),
      responses: { 200: ok('Shift closed', session), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
};
