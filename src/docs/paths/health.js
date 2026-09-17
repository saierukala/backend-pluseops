const healthResponses = (serviceName) => ({
  200: {
    description: `${serviceName} is healthy`,
    content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', example: true }, data: { type: 'object', properties: { name: { type: 'string', example: serviceName }, status: { type: 'string', example: 'up' } } }, message: { type: 'string' } } } } },
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

export const healthPaths = {
  '/health': { get: liveHealthOperation },
  '/health/db': { get: dbHealthOperation },
  '/health/redis': { get: redisHealthOperation },
  '/api/v1/health': { get: { ...liveHealthOperation, operationId: 'liveHealthV1', description: 'Alias of GET /health under /api/v1 prefix. Public.' } },
  '/api/v1/health/db': { get: { ...dbHealthOperation, operationId: 'databaseHealthV1' } },
  '/api/v1/health/redis': { get: { ...redisHealthOperation, operationId: 'redisHealthV1' } },
};
