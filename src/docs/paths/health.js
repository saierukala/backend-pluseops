const healthResponses = (serviceName) => ({
  200: {
    description: `${serviceName} is healthy`,
    content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { name: { type: 'string', example: serviceName }, status: { type: 'string', example: 'up' }, required: { type: 'boolean', example: true } } }, message: { type: 'string' } } } } },
  },
  503: {
    description: `${serviceName} unavailable`,
    content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: false }, data: { type: 'object' }, message: { type: 'string' } } } } },
  },
});

const liveHealthOperation = {
  tags: ['Health'],
  summary: 'Liveness check',
  description: 'Public liveness probe. No authentication required.',
  operationId: 'liveHealth',
  security: [],
  responses: {
    200: {
      description: 'Service is healthy',
      content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }, message: { type: 'string', example: 'Service is healthy' } } } } },
    },
  },
};

const dbHealthOperation = {
  tags: ['Health'],
  summary: 'Database health',
  description: 'Checks PostgreSQL connectivity. Public, no authentication.',
  operationId: 'databaseHealth',
  security: [],
  responses: healthResponses('database'),
};

const redisHealthOperation = {
  tags: ['Health'],
  summary: 'Redis health',
  description: 'Checks Redis connectivity. Public, no authentication.',
  operationId: 'redisHealth',
  security: [],
  responses: healthResponses('redis'),
};

const bullmqHealthOperation = {
  tags: ['Health'],
  summary: 'BullMQ health',
  description: 'Checks BullMQ/Redis connectivity for background jobs. Public, no authentication.',
  operationId: 'bullmqHealth',
  security: [],
  responses: healthResponses('bullmq'),
};

const readinessOperation = {
  tags: ['Readiness'],
  summary: 'Readiness check',
  description: 'Checks if application is ready to serve traffic (all required dependencies healthy). Public, no authentication.',
  operationId: 'readinessCheck',
  security: [],
  responses: {
    200: {
      description: 'Application is ready',
      content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { status: { type: 'string', example: 'ready' }, dependencies: { type: 'object' }, timestamp: { type: 'string', format: 'date-time' } } }, message: { type: 'string', example: 'Application is ready to serve traffic' } } } } },
    },
    503: {
      description: 'Application not ready',
      content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: false }, data: { type: 'object', properties: { status: { type: 'string', example: 'not_ready' }, dependencies: { type: 'object' }, timestamp: { type: 'string', format: 'date-time' } } }, message: { type: 'string', example: 'Required dependencies unavailable' } } } } },
    },
  },
};

const readinessLiveOperation = {
  tags: ['Readiness'],
  summary: 'Readiness liveness check',
  description: 'Simple liveness probe for readiness endpoint. Public, no authentication.',
  operationId: 'readinessLive',
  security: [],
  responses: {
    200: {
      description: 'Readiness endpoint is alive',
      content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }, message: { type: 'string', example: 'Service is alive' } } } } },
    },
  },
};

export const healthPaths = {
  '/health': { get: liveHealthOperation },
  '/health/db': { get: dbHealthOperation },
  '/health/redis': { get: redisHealthOperation },
  '/health/bullmq': { get: bullmqHealthOperation },
  '/api/v1/health': { get: { ...liveHealthOperation, operationId: 'liveHealthV1', description: 'Alias of GET /health under /api/v1 prefix. Public.' } },
  '/api/v1/health/db': { get: { ...dbHealthOperation, operationId: 'databaseHealthV1' } },
  '/api/v1/health/redis': { get: { ...redisHealthOperation, operationId: 'redisHealthV1' } },
  '/api/v1/health/bullmq': { get: { ...bullmqHealthOperation, operationId: 'bullmqHealthV1' } },
};

export const readinessPaths = {
  '/ready': { get: readinessOperation },
  '/ready/live': { get: readinessLiveOperation },
  '/api/v1/ready': { get: { ...readinessOperation, operationId: 'readinessCheckV1', description: 'Alias of GET /ready under /api/v1 prefix. Public.' } },
  '/api/v1/ready/live': { get: { ...readinessLiveOperation, operationId: 'readinessLiveV1' } },
};