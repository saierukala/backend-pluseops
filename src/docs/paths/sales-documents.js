// Phase 40: quotes, sales returns (credit notes), customer balances / receivables, payment links, recurring invoices
const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const e400 = err('Validation error');
const e401 = err('Unauthorized');
const e403 = err('Forbidden (missing permission)');
const e404 = err('Not found');
const e409 = err('Conflict (see error.code)');
const security = [{ bearerAuth: [] }];
const ok = (description, schema = { type: 'object' }) => ({ description, content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema } } } } });
const uuid = { type: 'string', format: 'uuid' };
const money = { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', example: '336.00' };
const date = { type: 'string', format: 'date', example: '2026-12-31' };
const id = { name: 'id', in: 'path', required: true, schema: uuid };
const page = [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }];
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const lineItems = { type: 'array', minItems: 1, items: { type: 'object', required: ['variantId', 'quantity'], properties: { variantId: uuid, quantity: { type: 'integer', minimum: 1 }, discount: money } } };
const quote = { $ref: '#/components/schemas/Quote' };
const creditNote = { $ref: '#/components/schemas/CreditNote' };
const recurring = { $ref: '#/components/schemas/RecurringInvoice' };
const idempotencyKey = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 255 }, description: 'Repeat-safe: the same key returns the first response instead of acting twice.' };

export const salesDocumentsPaths = {
  '/api/v1/quotes': {
    get: { tags: ['Quotes'], summary: 'List quotes', operationId: 'listQuotes', security, description: 'Requires `quote:read`. Newest first.', parameters: [...page, { name: 'status', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'CONVERTED'] } }, { name: 'customerId', in: 'query', schema: uuid }, { name: 'search', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('Quotes', { type: 'array', items: quote }), 401: e401, 403: e403 } },
    post: {
      tags: ['Quotes'], summary: 'Create a quote', operationId: 'createQuote', security,
      description: 'Requires `quote:create`. Priced with the same GST rules as invoices (item rates, CGST+SGST or IGST by the customer\'s state, tax-inclusive prices). Numbered PREFIX-QT/2026-27/0001. No stock is taken.',
      requestBody: json({ type: 'object', required: ['customerId', 'items'], properties: { customerId: uuid, items: lineItems, validUntil: date, notes: { type: 'string', maxLength: 2000 } } }),
      responses: { 201: ok('Quote created', quote), 400: e400, 401: e401, 403: e403, 404: e404 },
    },
  },
  '/api/v1/quotes/{id}': {
    get: { tags: ['Quotes'], summary: 'Get a quote', operationId: 'getQuote', security, description: 'Requires `quote:read`.', parameters: [id], responses: { 200: ok('Quote', quote), 401: e401, 403: e403, 404: e404 } },
    patch: { tags: ['Quotes'], summary: 'Change a draft or sent quote', operationId: 'updateQuote', security, description: 'Requires `quote:update`. New items are priced again. Accepted, declined and converted quotes can\'t change (409 `QUOTE_LOCKED`).', parameters: [id], requestBody: json({ type: 'object', properties: { items: lineItems, validUntil: { ...date, nullable: true }, notes: { type: 'string', nullable: true } } }), responses: { 200: ok('Quote updated', quote), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 } },
    delete: { tags: ['Quotes'], summary: 'Delete a quote', operationId: 'deleteQuote', security, description: 'Requires `quote:delete`. Converted quotes are kept with their order.', parameters: [id], responses: { 200: ok('Deleted'), 401: e401, 403: e403, 404: e404, 409: e409 } },
  },
  '/api/v1/quotes/{id}/status': {
    post: { tags: ['Quotes'], summary: 'Mark sent, accepted or declined', operationId: 'setQuoteStatus', security, description: 'Requires `quote:update`. DRAFT → SENT/ACCEPTED/DECLINED, SENT → ACCEPTED/DECLINED, ACCEPTED → DECLINED.', parameters: [id], requestBody: json({ type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['SENT', 'ACCEPTED', 'DECLINED'] } } }), responses: { 200: ok('Quote updated', quote), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 } },
  },
  '/api/v1/quotes/{id}/convert': {
    post: {
      tags: ['Quotes'], summary: 'Turn a quote into an order', operationId: 'convertQuote', security,
      description: 'Requires `quote:update` and `order:create`. Creates the order at today\'s catalog prices and takes the stock (default warehouse unless given); the quote becomes CONVERTED. Converting twice → 409 `QUOTE_LOCKED`.',
      parameters: [id], requestBody: json({ type: 'object', properties: { warehouseId: uuid, shippingAddressId: uuid, billingAddressId: uuid } }),
      responses: { 201: ok('Converted', { type: 'object', properties: { quote, order: { $ref: '#/components/schemas/Order' } } }), 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/orders/{id}/returns': {
    post: {
      tags: ['Returns'], summary: 'Record a sales return (credit note)', operationId: 'createReturn', security,
      description: 'Requires `order:return`. Returns lines of a confirmed or delivered invoice; the credit note reverses the invoice\'s own taxable value and CGST/SGST/IGST per unit. `restock` (default true) puts goods back where they came from. `refundMethod`: CREDIT keeps the amount on the customer\'s account, CASH pays it from the open register, ORIGINAL refunds the way they paid (Razorpay through Razorpay). Refunds never exceed what was paid. The order becomes PARTIALLY_REFUNDED or REFUNDED. Numbered PREFIX-CN/2026-27/0001.',
      parameters: [id, idempotencyKey],
      requestBody: json({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['orderItemId', 'quantity'], properties: { orderItemId: uuid, quantity: { type: 'integer', minimum: 1 }, restock: { type: 'boolean' } } } }, reason: { type: 'string' }, refundMethod: { type: 'string', enum: ['CREDIT', 'CASH', 'ORIGINAL'] }, registerId: uuid } }),
      responses: { 201: ok('Return recorded', { type: 'object', properties: { creditNote, refundErrors: { type: 'array', items: { type: 'object' } } } }), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/orders/{id}/credit-notes': {
    get: { tags: ['Returns'], summary: 'Credit notes of an order', operationId: 'listOrderCreditNotes', security, description: 'Requires `order:read`.', parameters: [id], responses: { 200: ok('Credit notes', { type: 'array', items: creditNote }), 401: e401, 403: e403 } },
  },
  '/api/v1/credit-notes': {
    get: { tags: ['Returns'], summary: 'All credit notes', operationId: 'listCreditNotes', security, description: 'Requires `order:read`.', parameters: [...page, { name: 'customerId', in: 'query', schema: uuid }], responses: { 200: ok('Credit notes', { type: 'array', items: creditNote }), 401: e401, 403: e403 } },
  },
  '/api/v1/credit-notes/{id}': {
    get: { tags: ['Returns'], summary: 'One credit note (for printing)', operationId: 'getCreditNote', security, description: 'Requires `order:read`. Includes the invoice it reverses.', parameters: [id], responses: { 200: ok('Credit note', creditNote), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/customers/{id}/balance': {
    get: { tags: ['Customer balances'], summary: 'What a customer owes', operationId: 'customerBalance', security, description: 'Requires `customer:read`. Per invoice: due = total − credit notes − (payments − refunds). Negative outstanding = credit on account.', parameters: [id], responses: { 200: ok('Balance', { $ref: '#/components/schemas/CustomerBalance' }), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/customers/{id}/statement': {
    get: { tags: ['Customer balances'], summary: 'Account statement with running balance', operationId: 'customerStatement', security, description: 'Requires `customer:read`. Invoices and refunds add, payments and credit notes subtract. Dates are India dates.', parameters: [id, { name: 'from', in: 'query', schema: date }, { name: 'to', in: 'query', schema: date }], responses: { 200: ok('Statement'), 400: e400, 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/customers/{id}/payments': {
    post: {
      tags: ['Customer balances'], summary: 'Receive a payment against the account', operationId: 'receiveCustomerPayment', security,
      description: 'Requires `payment:create`. Settles the oldest unpaid invoices first (one payment per invoice). Can\'t exceed what is owed (400 `PAYMENT_EXCEEDS_DUE`). Cash needs an open register.',
      parameters: [id, idempotencyKey], requestBody: json({ type: 'object', required: ['amount', 'method'], properties: { amount: money, method: { type: 'string', enum: ['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE'] }, reference: { type: 'string' }, registerId: uuid, note: { type: 'string' } } }),
      responses: { 201: ok('Payment received'), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/receivables': {
    get: { tags: ['Customer balances'], summary: 'Who owes money, with ageing', operationId: 'listReceivables', security, description: 'Requires `customer:read` and `payment:read`. Ageing by invoice date: 0–30, 31–60, 61–90, over 90 days.', responses: { 200: ok('Receivables'), 401: e401, 403: e403 } },
  },
  '/api/v1/orders/{id}/payment-link': {
    post: {
      tags: ['Customer balances'], summary: 'Send a Razorpay payment link for what is due', operationId: 'createPaymentLink', security,
      description: 'Requires `payment:create` and a connected Razorpay account (409 `PAYMENT_GATEWAY_NOT_CONFIGURED`). The link is for the amount still due; Razorpay emails/SMSes it when `notify` is true. The `payment_link.paid` webhook marks it paid. Asking again for the same amount returns the open link.',
      parameters: [id], requestBody: json({ type: 'object', properties: { notify: { type: 'boolean', default: true } } }),
      responses: { 201: ok('Payment link', { type: 'object', properties: { paymentId: uuid, url: { type: 'string' }, amount: money, reused: { type: 'boolean' } } }), 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/recurring-invoices': {
    get: { tags: ['Recurring invoices'], summary: 'List schedules', operationId: 'listRecurringInvoices', security, description: 'Requires `recurring_invoice:read`.', parameters: [...page, { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ENDED'] } }, { name: 'customerId', in: 'query', schema: uuid }], responses: { 200: ok('Schedules', { type: 'array', items: recurring }), 401: e401, 403: e403 } },
    post: {
      tags: ['Recurring invoices'], summary: 'Bill a customer on a schedule', operationId: 'createRecurringInvoice', security,
      description: 'Requires `recurring_invoice:create`. An hourly job raises each invoice on its date (India time; month ends kept: 31 Jan → 28 Feb → 31 Mar). `sendPaymentLink` sends a Razorpay link with each invoice (needs Razorpay).',
      requestBody: json({ type: 'object', required: ['customerId', 'name', 'items', 'frequency'], properties: { customerId: uuid, name: { type: 'string' }, items: lineItems, frequency: { type: 'string', enum: ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] }, startOn: date, endOn: date, warehouseId: uuid, sendPaymentLink: { type: 'boolean' } } }),
      responses: { 201: ok('Created', recurring), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 },
    },
  },
  '/api/v1/recurring-invoices/{id}': {
    get: { tags: ['Recurring invoices'], summary: 'A schedule and the invoices it raised', operationId: 'getRecurringInvoice', security, description: 'Requires `recurring_invoice:read`.', parameters: [id], responses: { 200: ok('Schedule', recurring), 401: e401, 403: e403, 404: e404 } },
    patch: { tags: ['Recurring invoices'], summary: 'Pause, resume or change a schedule', operationId: 'updateRecurringInvoice', security, description: 'Requires `recurring_invoice:update`. Resuming doesn\'t bill missed periods.', parameters: [id], requestBody: json({ type: 'object', properties: { name: { type: 'string' }, items: lineItems, frequency: { type: 'string' }, endOn: { ...date, nullable: true }, warehouseId: { ...uuid, nullable: true }, sendPaymentLink: { type: 'boolean' }, status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ENDED'] } } }), responses: { 200: ok('Updated', recurring), 400: e400, 401: e401, 403: e403, 404: e404, 409: e409 } },
    delete: { tags: ['Recurring invoices'], summary: 'Delete a schedule', operationId: 'deleteRecurringInvoice', security, description: 'Requires `recurring_invoice:delete`. Invoices already raised stay.', parameters: [id], responses: { 200: ok('Deleted'), 401: e401, 403: e403, 404: e404 } },
  },
  '/api/v1/recurring-invoices/{id}/run': {
    post: { tags: ['Recurring invoices'], summary: 'Bill now', operationId: 'runRecurringInvoice', security, description: 'Requires `recurring_invoice:update` and `order:create`. Raises the invoice immediately; if the period was due, the schedule moves to the next date.', parameters: [id], responses: { 201: ok('Invoice raised', { type: 'object', properties: { orderId: uuid, invoiceNumber: { type: 'string' }, paymentLink: { type: 'string', nullable: true } } }), 401: e401, 403: e403, 404: e404, 409: e409 } },
  },
};
