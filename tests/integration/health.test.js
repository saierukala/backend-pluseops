import request from 'supertest';
import { createApp } from '../../src/app/app.js';

const app = createApp();

describe('health endpoints', () => {
  it('returns a liveness response and a request ID', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.body).toEqual({ success: true, data: { status: 'ok' }, message: 'Service is healthy' });
  });

  it.each(['/health/db', '/health/redis'])('reports unavailable dependencies safely when disconnected: %s', async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.data.status).toBe('down');
  });

  it('uses the standardized error response for unknown routes', async () => {
    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(response.body.requestId).toBeDefined();
  });
});
