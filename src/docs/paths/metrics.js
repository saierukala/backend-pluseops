const metricsOperation = {
  tags: ['Metrics'],
  summary: 'Application metrics',
  description: 'Returns application metrics snapshot. Supports JSON and Prometheus format via ?format=prometheus query parameter. Public, no authentication.',
  operationId: 'getMetrics',
  security: [],
  parameters: [
    {
      name: 'format',
      in: 'query',
      schema: { type: 'string', enum: ['json', 'prometheus'], default: 'json' },
      description: 'Output format',
    },
  ],
  responses: {
    200: {
      description: 'Metrics snapshot',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data: {
                type: 'object',
                properties: {
                  counters: { type: 'object', additionalProperties: { type: 'integer' } },
                  histograms: { type: 'object', additionalProperties: { type: 'object' } },
                  gauges: { type: 'object', additionalProperties: { type: 'number' } },
                },
              },
              message: { type: 'string', example: 'Metrics snapshot' },
            },
          },
        },
        'text/plain': {
          schema: { type: 'string' },
          description: 'Prometheus format metrics',
        },
      },
    },
  },
};

export const metricsPaths = {
  '/metrics': { get: metricsOperation },
  '/metrics/metrics': { get: metricsOperation },
  '/api/v1/metrics': { get: { ...metricsOperation, operationId: 'getMetricsV1' } },
  '/api/v1/metrics/metrics': { get: { ...metricsOperation, operationId: 'getMetricsV1Alt' } },
};