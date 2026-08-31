import request from 'supertest';
import { createApp } from '../../src/app/app.js';

const app = createApp();

describe('request boundaries', () => {
  it('returns a client-error code for malformed JSON', async () => {
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
    expect(response.body.requestId).toBeDefined();
  });

  it('returns a client-error code for a payload exceeding the configured limit', async () => {
    const response = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send({ payload: 'x'.repeat(1024 * 1024 + 1) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.body.requestId).toBeDefined();
  });
});
