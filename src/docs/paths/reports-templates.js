const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } });
const error400 = err('Validation error');
const error401 = err('Unauthorized');
const error403 = err('Forbidden');
const error404 = err('Not found');
const error500 = err('Internal server error');
const ok = (description, schema, extra = {}) => ({
  description,
  content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: schema, ...extra } } } },
});
const security = [{ bearerAuth: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const pageParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];
const report = { $ref: '#/components/schemas/Report' };
const template = { $ref: '#/components/schemas/NotificationTemplate' };
const meta = { meta: { $ref: '#/components/schemas/PaginationMeta' } };

const templateProperties = {
  name: { type: 'string', maxLength: 100, example: 'order.created', description: 'Key the system looks up (lower-cased). Built-in use: `order.created` (variables orderId, total, currency).' },
  channel: { type: 'string', enum: ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] },
  subject: { type: 'string', maxLength: 255, nullable: true, description: 'Required except for SMS; title for IN_APP/PUSH' },
  body: { type: 'string', maxLength: 5000, example: 'Order {{orderId}} total {{total}} {{currency}}' },
  variables: { type: 'array', items: { type: 'string' }, description: 'Every {{placeholder}} must be listed here' },
  isActive: { type: 'boolean', default: true },
};

export const reportsTemplatesPaths = {
  '/api/v1/reports': {
    post: {
      tags: ['Reports'],
      summary: 'Request a CSV export',
      description: 'Requires `report:create` **and** read access to the data: ORDERS → `order:read`, INVENTORY → `inventory:read`, CUSTOMERS → `customer:read`. Returns 202; the worker generates the file (status PENDING → PROCESSING → COMPLETED/FAILED). Filters: ORDERS `from`, `to`, `status`; INVENTORY `warehouseId`; CUSTOMERS `from`, `to` (dates YYYY-MM-DD, UTC, inclusive). Cells that would start a spreadsheet formula are prefixed with `\'`. CUSTOMERS `orderCount`/`totalSpent` exclude cancelled and refunded orders.',
      operationId: 'createReport',
      security,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['type'], properties: {
          type: { type: 'string', enum: ['ORDERS', 'INVENTORY', 'CUSTOMERS'], description: 'Case-insensitive' },
          filters: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, status: { type: 'string' }, warehouseId: { type: 'string', format: 'uuid' } } },
        } } } },
      },
      responses: { 202: ok('Report requested', report), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
    get: {
      tags: ['Reports'],
      summary: 'List reports',
      description: 'Requires `report:read`. Newest first.',
      operationId: 'listReports',
      security,
      parameters: [...pageParams,
        { name: 'type', in: 'query', schema: { type: 'string', enum: ['ORDERS', 'INVENTORY', 'CUSTOMERS'] } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] } }],
      responses: { 200: ok('Reports retrieved', { type: 'array', items: report }, meta), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
  },
  '/api/v1/reports/{id}': {
    get: {
      tags: ['Reports'],
      summary: 'Get a report (poll its status)',
      description: 'Requires `report:read`.',
      operationId: 'getReport',
      security,
      parameters: [idParam],
      responses: { 200: ok('Report retrieved', report), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/reports/{id}/download': {
    get: {
      tags: ['Reports'],
      summary: 'Get a download link',
      description: 'Requires `report:read` plus the report type\'s data permission. Returns a signed URL valid for 5 minutes (no auth header needed to fetch it; served as `text/csv` attachment, UTF-8 with BOM). 409 `REPORT_NOT_READY` unless COMPLETED.',
      operationId: 'downloadReport',
      security,
      parameters: [idParam],
      responses: {
        200: ok('Download link created', { type: 'object', properties: { url: { type: 'string' }, fileName: { type: 'string', example: 'orders-2026-10-24-1a2b3c4d.csv' }, expiresAt: { type: 'string', format: 'date-time' } } }),
        400: error400, 401: error401, 403: error403, 404: error404, 409: err('Report not ready (`REPORT_NOT_READY`)'), 500: error500,
      },
    },
  },
  '/api/v1/notification-templates': {
    get: {
      tags: ['Notification Templates'],
      summary: 'List templates',
      description: 'Requires `notification_template:read`.',
      operationId: 'listNotificationTemplates',
      security,
      parameters: [...pageParams,
        { name: 'channel', in: 'query', schema: { type: 'string', enum: ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] } },
        { name: 'isActive', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches name' }],
      responses: { 200: ok('Templates retrieved', { type: 'array', items: template }, meta), 400: error400, 401: error401, 403: error403, 500: error500 },
    },
    post: {
      tags: ['Notification Templates'],
      summary: 'Create a template',
      description: 'Requires `notification_template:create`. Placeholders are `{{name}}` only (no logic). When a job names a template, the active template for (name, channel) replaces the job\'s own text. 409 `TEMPLATE_EXISTS` for a duplicate (name, channel).',
      operationId: 'createNotificationTemplate',
      security,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'channel', 'body'], properties: templateProperties } } } },
      responses: { 201: ok('Template created', template), 400: error400, 401: error401, 403: error403, 409: err('Template exists'), 500: error500 },
    },
  },
  '/api/v1/notification-templates/{id}': {
    get: {
      tags: ['Notification Templates'],
      summary: 'Get a template',
      description: 'Requires `notification_template:read`.',
      operationId: 'getNotificationTemplate',
      security,
      parameters: [idParam],
      responses: { 200: ok('Template retrieved', template), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
    patch: {
      tags: ['Notification Templates'],
      summary: 'Update a template',
      description: 'Requires `notification_template:update`. The merged template is re-validated (placeholders vs variables, subject).',
      operationId: 'updateNotificationTemplate',
      security,
      parameters: [idParam],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', minProperties: 1, properties: templateProperties } } } },
      responses: { 200: ok('Template updated', template), 400: error400, 401: error401, 403: error403, 404: error404, 409: err('Template exists'), 500: error500 },
    },
    delete: {
      tags: ['Notification Templates'],
      summary: 'Delete a template',
      description: 'Requires `notification_template:delete`. Jobs naming it fall back to their own text.',
      operationId: 'deleteNotificationTemplate',
      security,
      parameters: [idParam],
      responses: { 200: ok('Template deleted', { nullable: true, example: null }), 400: error400, 401: error401, 403: error403, 404: error404, 500: error500 },
    },
  },
  '/api/v1/notification-templates/{id}/preview': {
    post: {
      tags: ['Notification Templates'],
      summary: 'Render a template',
      description: 'Requires `notification_template:read`. No side effects. Missing variables render empty and are listed.',
      operationId: 'previewNotificationTemplate',
      security,
      parameters: [idParam],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { variables: { type: 'object', additionalProperties: true } } } } } },
      responses: {
        200: ok('Template rendered', { type: 'object', properties: { subject: { type: 'string', nullable: true }, body: { type: 'string' }, missingVariables: { type: 'array', items: { type: 'string' } } } }),
        400: error400, 401: error401, 403: error403, 404: error404, 500: error500,
      },
    },
  },
};
