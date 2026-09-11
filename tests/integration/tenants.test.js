import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const app = createApp();
const prisma = getPrismaClient();

afterAll(async () => {
  await prisma.tenantDomain.deleteMany();
  await prisma.tenantSettings.deleteMany();
  await prisma.tenant.deleteMany();
  await disconnectDatabase();
});

describe('tenant endpoints', () => {
  let createdTenantId;

  it('creates a tenant successfully', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .send({ name: 'Test Tenant', slug: 'test-tenant' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe('Test Tenant');
    expect(response.body.data.slug).toBe('test-tenant');
    expect(response.body.data.status).toBe('TRIAL');
    expect(response.body.data.plan).toBe('free');
    expect(response.body.data.id).toBeDefined();
    expect(response.headers['x-request-id']).toBeDefined();

    createdTenantId = response.body.data.id;
  });

  it('rejects duplicate tenant slug', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .send({ name: 'Test Tenant 2', slug: 'test-tenant' });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_SLUG_EXISTS');
  });

  it('retrieves a tenant by ID', async () => {
    const response = await request(app).get(`/api/v1/tenants/${createdTenantId}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe(createdTenantId);
    expect(response.body.data.name).toBe('Test Tenant');
    expect(response.body.data.slug).toBe('test-tenant');
  });

  it('returns 404 for non-existent tenant', async () => {
    const response = await request(app).get('/api/v1/tenants/00000000-0000-0000-0000-000000000000');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('updates a tenant', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .send({ name: 'Updated Tenant', status: 'ACTIVE', plan: 'pro' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe('Updated Tenant');
    expect(response.body.data.status).toBe('ACTIVE');
    expect(response.body.data.plan).toBe('pro');
    expect(response.body.data.slug).toBe('test-tenant');
  });

  it('rejects invalid tenant status', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .send({ status: 'INVALID_STATUS' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects update with duplicate slug', async () => {
    await request(app).post('/api/v1/tenants').send({ name: 'Another Tenant', slug: 'another-tenant' });

    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .send({ slug: 'another-tenant' });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_SLUG_EXISTS');
  });

  it('rejects empty update', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates slug format', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .send({ name: 'Test', slug: 'Invalid_Slug' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts all valid tenant statuses', async () => {
    for (const status of ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED']) {
      const slug = `test-${status.toLowerCase()}-${Date.now()}`;
      const response = await request(app)
        .post('/api/v1/tenants')
        .send({ name: `Test ${status}`, slug, status });

      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe(status);
    }
  });

  it('deletes a tenant', async () => {
    const createResponse = await request(app)
      .post('/api/v1/tenants')
      .send({ name: 'To Delete', slug: 'to-delete' });

    const deleteResponse = await request(app).delete(`/api/v1/tenants/${createResponse.body.data.id}`);

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);
    expect(deleteResponse.body.message).toBe('Tenant deleted successfully');

    const getResponse = await request(app).get(`/api/v1/tenants/${createResponse.body.data.id}`);
    expect(getResponse.status).toBe(404);
  });
});