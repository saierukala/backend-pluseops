const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const jobsPaths = {
  '/api/v1/jobs/status': {
    get: {
      tags: ['Jobs'],
      summary: 'Get jobs status',
      description: 'Requires authentication. No specific permission. Tenant-isolated.',
      operationId: 'getJobsStatus',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Jobs status', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/jobs/cleanup': {
    post: {
      tags: ['Jobs'],
      summary: 'Trigger cleanup job',
      description: 'Requires authentication. No specific permission.',
      operationId: 'triggerCleanup',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Cleanup triggered', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/jobs/notifications': {
    post: {
      tags: ['Jobs'],
      summary: 'Trigger notification job',
      description: 'Requires authentication. Strict body.',
      operationId: 'triggerNotification',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title', 'message'],
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 255, example: 'System Alert' },
                message: { type: 'string', minLength: 1, maxLength: 2000, example: 'Deployment completed' },
                type: { type: 'string', enum: ['INFO', 'SUCCESS', 'WARNING', 'ERROR'] },
                channel: { type: 'string', enum: ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] },
                referenceType: { type: 'string', maxLength: 100 },
                referenceId: { type: 'string', maxLength: 255 },
                metadata: { type: 'object' },
                idempotencyKey: { type: 'string', maxLength: 255 },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        200: { description: 'Notification job enqueued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        400: error400,
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/jobs/reports': {
    post: {
      tags: ['Jobs'],
      summary: 'Trigger report job',
      description: 'Requires authentication. Passthrough body.',
      operationId: 'triggerReport',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                reportType: { type: 'string' },
                filters: { type: 'object' },
                idempotencyKey: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: { description: 'Report job enqueued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/jobs/analytics': {
    post: {
      tags: ['Jobs'],
      summary: 'Trigger analytics job',
      description: 'Requires authentication.',
      operationId: 'triggerAnalytics',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                metric: { type: 'string' },
                period: { type: 'string' },
                filters: { type: 'object' },
                idempotencyKey: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: { description: 'Analytics job enqueued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        401: error401,
        500: error500,
      },
    },
  },
  '/api/v1/dashboard/overview': {
    get: {
      tags: ['Dashboard'],
      summary: 'Get dashboard overview',
      description: 'Requires `dashboard:read`. Single aggregate endpoint.',
      operationId: 'getDashboardOverview',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Dashboard overview', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object' } } } } } },
        401: error401,
        403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        500: error500,
      },
    },
  },
};
