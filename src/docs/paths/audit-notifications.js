const error400 = { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error401 = { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error403 = { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error404 = { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const error500 = { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };

export const auditNotificationsPaths = {
  '/api/v1/audit-logs': {
    get: {
      tags: ['Audit'],
      summary: 'List audit logs',
      description: 'Requires `audit:read`.',
      operationId: 'listAuditLogs',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'action', in: 'query', schema: { type: 'string', enum: ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'IMPORT'] } },
        { name: 'resource', in: 'query', schema: { type: 'string', maxLength: 100 } },
        { name: 'resourceId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'action', 'resource'], default: 'createdAt' } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: {
        200: { description: 'Audit logs', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/AuditLog' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/activity-logs': {
    get: {
      tags: ['Audit'],
      summary: 'List activity logs',
      description: 'Requires `activity:read`.',
      operationId: 'listActivityLogs',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'action', in: 'query', schema: { type: 'string', maxLength: 100 } },
        { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'action'], default: 'createdAt' } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: {
        200: { description: 'Activity logs', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/ActivityLog' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/activity-logs/{id}': {
    get: {
      tags: ['Audit'],
      summary: 'Get activity log by ID',
      description: 'Requires `activity:read`.',
      operationId: 'getActivityLog',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Activity log', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/ActivityLog' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'List notifications',
      description: 'Requires `notification:read`. Tenant and user isolated via JWT.',
      operationId: 'listNotifications',
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'isRead', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'Boolean string filter' },
        { name: 'type', in: 'query', schema: { type: 'string', enum: ['INFO', 'SUCCESS', 'WARNING', 'ERROR'] } },
        { name: 'channel', in: 'query', schema: { type: 'string', enum: ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] } },
        { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
      ],
      responses: {
        200: { description: 'Notifications', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { $ref: '#/components/schemas/Notification' } }, meta: { $ref: '#/components/schemas/PaginationMeta' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/notifications/read-all': {
    post: {
      tags: ['Notifications'],
      summary: 'Mark all notifications as read',
      description: 'Requires `notification:update`.',
      operationId: 'markAllRead',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'All marked read', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', nullable: true } } } } } },
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
  '/api/v1/notifications/{id}/read': {
    patch: {
      tags: ['Notifications'],
      summary: 'Mark one notification as read',
      description: 'Requires `notification:update`.',
      operationId: 'markOneAsRead',
      security: [{ bearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Notification marked read', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { $ref: '#/components/schemas/Notification' } } } } } },
        400: error400,
        401: error401,
        403: error403,
        404: error404,
        500: error500,
      },
    },
  },
  '/api/v1/notification-preferences': {
    get: {
      tags: ['Notifications'],
      summary: 'Get notification preferences',
      description: 'Requires `notification:read`.',
      operationId: 'getNotificationPreferences',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: 'Preferences', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { type: 'object' } } } } } } },
        401: error401,
        403: error403,
        500: error500,
      },
    },
    patch: {
      tags: ['Notifications'],
      summary: 'Update notification preferences',
      description: 'Requires `notification:update`. Accepts IN_APP/EMAIL/SMS/PUSH or normalized variants.',
      operationId: 'updateNotificationPreferences',
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                preferences: { type: 'object', properties: { IN_APP: { type: 'boolean' }, EMAIL: { type: 'boolean' }, SMS: { type: 'boolean' }, PUSH: { type: 'boolean' } } },
                IN_APP: { type: 'boolean' },
                EMAIL: { type: 'boolean' },
                SMS: { type: 'boolean' },
                PUSH: { type: 'boolean' },
                inApp: { type: 'boolean' },
                email: { type: 'boolean' },
                sms: { type: 'boolean' },
                push: { type: 'boolean' },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: {
        200: { description: 'Preferences updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'array', items: { type: 'object' } } } } } } },
        400: error400,
        401: error401,
        403: error403,
        500: error500,
      },
    },
  },
};
