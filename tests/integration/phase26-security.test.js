import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase26#Pass123';

let platformAdmin;
let tenantId;
let adminToken;
let staffToken;

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p26_${RUN}` });
  const created = await request(app)
    .post('/api/v1/platform/tenants')
    .set('Authorization', `Bearer ${platformAdmin.token}`)
    .send({
      name: 'Phase 26',
      slug: `phase26-${RUN}`,
      status: 'ACTIVE',
      admin: { email: `p26-admin-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' },
    });
  tenantId = created.body.data.tenant.id;
  adminToken = await login(`p26-admin-${RUN}@test.local`);

  // Staff user with no roles at all
  await request(app).post('/api/v1/auth/register').send({ email: `p26-staff-${RUN}@test.local`, password: PASSWORD, firstName: 'Sam', lastName: 'Staff', tenantId });
  staffToken = await login(`p26-staff-${RUN}@test.local`);
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 26 — jobs API requires permissions', () => {
  it.each([
    ['get', '/api/v1/jobs/status', undefined],
    ['post', '/api/v1/jobs/cleanup', undefined],
    ['post', '/api/v1/jobs/notifications', { title: 'x', message: 'y' }],
    ['post', '/api/v1/jobs/reports', {}],
    ['post', '/api/v1/jobs/analytics', {}],
  ])('%s %s is forbidden without jobs permissions', async (method, path, body) => {
    const res = await request(app)[method](path).set('Authorization', `Bearer ${staffToken}`).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('tenant admin (provisioned by the platform) can use the jobs API', async () => {
    const status = await request(app).get('/api/v1/jobs/status').set('Authorization', `Bearer ${adminToken}`);
    const cleanup = await request(app).post('/api/v1/jobs/cleanup').set('Authorization', `Bearer ${adminToken}`);

    expect(status.status).toBe(200);
    expect([200, 202]).toContain(cleanup.status);
  });
});

describe('Phase 26 — tenant admins receive the full permission catalog', () => {
  it.each(['/api/v1/attributes', '/api/v1/analytics/overview', '/api/v1/dashboard/overview'])('admin can GET %s', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
