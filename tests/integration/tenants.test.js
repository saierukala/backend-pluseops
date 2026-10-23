import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const slug = (name) => `${name}-${RUN}`;

let admin;
let readOnlyAdmin;
const auth = () => ({ Authorization: `Bearer ${admin.token}` });

beforeAll(async () => {
  admin = await createPlatformAdmin(app, prisma, { suffix: `tenants_${RUN}` });
  readOnlyAdmin = await createPlatformAdmin(app, prisma, { suffix: `tenants_ro_${RUN}`, permissions: ['platform:tenant:read'] });
});

afterAll(async () => {
  // Only remove what this suite created — never wipe the whole tenants table
  await prisma.tenant.deleteMany({ where: { slug: { endsWith: `-${RUN}` } } });
  await admin?.cleanup();
  await readOnlyAdmin?.cleanup();
  await disconnectDatabase();
});

describe('tenant endpoints (platform admin)', () => {
  let createdTenantId;

  it('creates a tenant successfully', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .set(auth())
      .send({ name: 'Test Tenant', slug: slug('test-tenant') });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe('Test Tenant');
    expect(response.body.data.slug).toBe(slug('test-tenant'));
    expect(response.body.data.status).toBe('TRIAL');
    expect(response.body.data.plan).toBe('free');
    expect(response.body.data.id).toBeDefined();
    expect(response.headers['x-request-id']).toBeDefined();

    createdTenantId = response.body.data.id;
  });

  it('rejects duplicate tenant slug', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .set(auth())
      .send({ name: 'Test Tenant 2', slug: slug('test-tenant') });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_SLUG_EXISTS');
  });

  it('retrieves a tenant by ID', async () => {
    const response = await request(app).get(`/api/v1/tenants/${createdTenantId}`).set(auth());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.id).toBe(createdTenantId);
    expect(response.body.data.name).toBe('Test Tenant');
    expect(response.body.data.slug).toBe(slug('test-tenant'));
  });

  it('returns 404 for non-existent tenant', async () => {
    const response = await request(app).get('/api/v1/tenants/00000000-0000-0000-0000-000000000000').set(auth());

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_NOT_FOUND');
  });

  it('updates a tenant', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .set(auth())
      .send({ name: 'Updated Tenant', status: 'ACTIVE', plan: 'pro' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.name).toBe('Updated Tenant');
    expect(response.body.data.status).toBe('ACTIVE');
    expect(response.body.data.plan).toBe('pro');
    expect(response.body.data.slug).toBe(slug('test-tenant'));
  });

  it('rejects invalid tenant status', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .set(auth())
      .send({ status: 'INVALID_STATUS' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects update with duplicate slug', async () => {
    await request(app).post('/api/v1/tenants').set(auth()).send({ name: 'Another Tenant', slug: slug('another-tenant') });

    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .set(auth())
      .send({ slug: slug('another-tenant') });

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('TENANT_SLUG_EXISTS');
  });

  it('rejects empty update', async () => {
    const response = await request(app)
      .patch(`/api/v1/tenants/${createdTenantId}`)
      .set(auth())
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates slug format', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .set(auth())
      .send({ name: 'Test', slug: 'Invalid_Slug' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts all valid tenant statuses', async () => {
    for (const status of ['ACTIVE', 'SUSPENDED', 'TRIAL', 'CANCELLED']) {
      const response = await request(app)
        .post('/api/v1/tenants')
        .set(auth())
        .send({ name: `Test ${status}`, slug: slug(`test-${status.toLowerCase()}`), status });

      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe(status);
    }
  });

  it('deletes a tenant', async () => {
    const createResponse = await request(app)
      .post('/api/v1/tenants')
      .set(auth())
      .send({ name: 'To Delete', slug: slug('to-delete') });

    const deleteResponse = await request(app).delete(`/api/v1/tenants/${createResponse.body.data.id}`).set(auth());

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.success).toBe(true);
    expect(deleteResponse.body.message).toBe('Tenant deleted successfully');

    const getResponse = await request(app).get(`/api/v1/tenants/${createResponse.body.data.id}`).set(auth());
    expect(getResponse.status).toBe(404);
  });

  it('hides the internal platform tenant', async () => {
    const platformTenant = await prisma.tenant.findUnique({ where: { slug: '__platform' } });

    const getResponse = await request(app).get(`/api/v1/tenants/${platformTenant.id}`).set(auth());
    const deleteResponse = await request(app).delete(`/api/v1/tenants/${platformTenant.id}`).set(auth());

    expect(getResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(await prisma.tenant.findUnique({ where: { slug: '__platform' } })).not.toBeNull();
  });
});

describe('tenant endpoints access control (Phase 26)', () => {
  let tenantId;
  let tenantToken;

  beforeAll(async () => {
    const created = await request(app)
      .post('/api/v1/platform/tenants')
      .set(auth())
      .send({
        name: 'Access Tenant',
        slug: slug('access-tenant'),
        status: 'ACTIVE',
        admin: { email: `tenant-admin-${RUN}@test.local`, password: 'TenantAdmin#123', firstName: 'Tenant', lastName: 'Admin' },
      });
    tenantId = created.body.data.tenant.id;
    const login = await request(app).post('/api/v1/auth/login').send({ email: `tenant-admin-${RUN}@test.local`, password: 'TenantAdmin#123' });
    tenantToken = login.body.data.accessToken;
  });

  it.each([
    { method: 'post', body: { name: 'Anon', slug: 'anon-tenant' } },
    { method: 'get' },
    { method: 'patch', body: { name: 'Hijacked' } },
    { method: 'delete' },
  ])('rejects anonymous $method with 401', async ({ method, body }) => {
    const path = method === 'post' ? '/api/v1/tenants' : `/api/v1/tenants/${tenantId}`;
    const response = await request(app)[method](path).send(body);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a tenant-scoped token with 403', async () => {
    const response = await request(app).delete(`/api/v1/tenants/${tenantId}`).set('Authorization', `Bearer ${tenantToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PLATFORM_AUTH_REQUIRED');
  });

  it('requires the matching platform permission', async () => {
    const ro = { Authorization: `Bearer ${readOnlyAdmin.token}` };

    expect((await request(app).get(`/api/v1/tenants/${tenantId}`).set(ro)).status).toBe(200);
    const deleteResponse = await request(app).delete(`/api/v1/tenants/${tenantId}`).set(ro);
    expect(deleteResponse.status).toBe(403);
    expect(deleteResponse.body.error.code).toBe('FORBIDDEN');
    const patchResponse = await request(app).patch(`/api/v1/tenants/${tenantId}`).set(ro).send({ name: 'Nope' });
    expect(patchResponse.status).toBe(403);
  });

  it('leaves the tenant intact after rejected attempts', async () => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(tenant.name).toBe('Access Tenant');
  });
});
