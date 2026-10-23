import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase30#Pass123';

let platformAdmin;
let readOnlyPlatformAdmin;
let tenantA;
let tenantB;
let A;
let B;
let noRole;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

async function createTenant(label) {
  const res = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Phase 30 ${label}`, slug: `phase30-${label}-${RUN}`, status: 'ACTIVE', admin: { email: `p30-${label}-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: label } });
  return { id: res.body.data.tenant.id, token: await login(`p30-${label}-${RUN}@test.local`) };
}

function startSupport(tenantId, token = platformAdmin.token, reason = 'Customer asked for help with orders') {
  return api.post(`/platform/tenants/${tenantId}/support-sessions`, token, { reason });
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p30_${RUN}` });
  readOnlyPlatformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p30ro_${RUN}`, permissions: ['platform:tenant:read'] });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  A = tenantA.token;
  B = tenantB.token;

  const staffEmail = `p30-staff-${RUN}@test.local`;
  await request(app).post('/api/v1/auth/register').send({ email: staffEmail, password: PASSWORD, firstName: 'No', lastName: 'Role', tenantId: tenantA.id });
  noRole = await login(staffEmail);
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA?.id, tenantB?.id].filter(Boolean) } } });
  await platformAdmin?.cleanup();
  await readOnlyPlatformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 30 — workspace profile and tenant context', () => {
  it('GET /workspace returns the caller’s own tenant with empty settings and no domains', async () => {
    const res = await api.get('/workspace', A);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: tenantA.id, slug: `phase30-a-${RUN}`, status: 'ACTIVE', domains: [] });
    expect(res.body.data.settings).toEqual({ currency: null, timezone: null, locale: null, contactEmail: null, contactPhone: null });
  });

  it('GET /auth/me includes the tenant the login belongs to', async () => {
    const res = await api.get('/auth/me', A);
    expect(res.status).toBe(200);
    expect(res.body.data.tenant).toMatchObject({ id: tenantA.id, name: 'Phase 30 a', slug: `phase30-a-${RUN}`, status: 'ACTIVE' });
  });

  it('renames the workspace and audit-logs it', async () => {
    const res = await api.patch('/workspace', A, { name: 'Ravi Furniture' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Ravi Furniture');
    const log = await prisma.auditLog.findFirst({ where: { tenantId: tenantA.id, resource: 'tenant', action: 'UPDATE' } });
    expect(log.newValue).toEqual({ name: 'Ravi Furniture' });
  });

  it('requires tenant:read / tenant:update', async () => {
    expect((await api.get('/workspace', noRole)).status).toBe(403);
    expect((await api.patch('/workspace', noRole, { name: 'Pwned' })).status).toBe(403);
    expect((await api.patch('/workspace/settings', noRole, { currency: 'USD' })).status).toBe(403);
    expect((await api.post('/workspace/domains', noRole, { domain: `nr-${RUN}.example.com` })).status).toBe(403);
    expect((await request(app).get('/api/v1/workspace')).status).toBe(401);
  });

  it('refuses platform tokens (the platform uses /platform/tenants)', async () => {
    const res = await api.get('/workspace', platformAdmin.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLATFORM_TOKEN_FORBIDDEN');
  });
});

describe('Phase 30 — settings', () => {
  it('sets, normalises and partially updates settings', async () => {
    const first = await api.patch('/workspace/settings', A, { currency: 'inr', timezone: 'Asia/Kolkata', locale: 'en-IN', contactEmail: 'Help@Ravi.example' });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ currency: 'INR', timezone: 'Asia/Kolkata', locale: 'en-IN', contactEmail: 'help@ravi.example', contactPhone: null });

    const second = await api.patch('/workspace/settings', A, { contactPhone: '+91 90000 00000', locale: null });
    expect(second.body.data).toMatchObject({ currency: 'INR', locale: null, contactPhone: '+91 90000 00000' });
    expect((await api.get('/workspace/settings', A)).body.data).toEqual(second.body.data);
  });

  it('rejects invalid values and empty updates', async () => {
    expect((await api.patch('/workspace/settings', A, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await api.patch('/workspace/settings', A, { currency: 'RUPEES' })).status).toBe(400);
    expect((await api.patch('/workspace/settings', A, { contactEmail: 'nope' })).status).toBe(400);
    expect((await api.patch('/workspace/settings', A, {})).status).toBe(400);
  });

  it('keeps settings per tenant', async () => {
    expect((await api.get('/workspace/settings', B)).body.data.currency).toBeNull();
  });
});

describe('Phase 30 — domains', () => {
  const shop = `shop-${RUN}.example.com`;
  let first;
  let second;

  it('adds a normalised domain; the first one is primary and unverified', async () => {
    const res = await api.post('/workspace/domains', A, { domain: `  SHOP-${RUN}.Example.com. ` });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ domain: shop, primary: true, verified: false });
    first = res.body.data;

    const next = await api.post('/workspace/domains', A, { domain: `www.${shop}` });
    expect(next.body.data.primary).toBe(false);
    second = next.body.data;
  });

  it('rejects malformed domains', async () => {
    for (const domain of [`https://${shop}`, `${shop}/path`, `${shop}:8080`, 'localhost', '10.0.0.1', '-bad.example.com']) {
      expect((await api.post('/workspace/domains', A, { domain })).status).toBe(400);
    }
  });

  it('a tenant cannot add the same domain twice; an unverified claim does not block other tenants (Phase 32)', async () => {
    const own = await api.post('/workspace/domains', A, { domain: shop });
    expect(own.status).toBe(409);
    expect(own.body.error).toMatchObject({ code: 'DOMAIN_TAKEN', message: 'This domain is already registered' });
    // Verified domains are reserved platform-wide — see phase32-storefront.test.js
    const other = await api.post('/workspace/domains', B, { domain: shop.toUpperCase() });
    expect(other.status).toBe(201);
    expect((await api.delete(`/workspace/domains/${other.body.data.id}`, B)).status).toBe(200);
  });

  it('moves the primary flag and promotes another domain when the primary is removed', async () => {
    const moved = await api.patch(`/workspace/domains/${second.id}`, A, { primary: true });
    expect(moved.status).toBe(200);
    let list = (await api.get('/workspace/domains', A)).body.data;
    expect(list.filter((d) => d.primary).map((d) => d.id)).toEqual([second.id]);
    expect(list[0].id).toBe(second.id);

    expect((await api.delete(`/workspace/domains/${second.id}`, A)).status).toBe(200);
    list = (await api.get('/workspace/domains', A)).body.data;
    expect(list).toEqual([expect.objectContaining({ id: first.id, primary: true })]);
    expect((await api.patch(`/workspace/domains/${first.id}`, A, { primary: false })).status).toBe(400);
  });

  it('hides another tenant’s domains (404)', async () => {
    expect((await api.patch(`/workspace/domains/${first.id}`, B, { primary: true })).status).toBe(404);
    expect((await api.delete(`/workspace/domains/${first.id}`, B)).status).toBe(404);
    expect((await api.get('/workspace/domains', B)).body.data).toEqual([]);
  });
});

describe('Phase 30 — read-only platform support sessions', () => {
  let session;
  let customerB;

  beforeAll(async () => {
    customerB = (await api.post('/customers', B, { email: `b-cust-${RUN}@shop.test`, firstName: 'Bo', lastName: 'B' })).body.data;
  });

  it('needs platform:tenant:access, a reason and an existing tenant', async () => {
    expect((await startSupport(tenantA.id, readOnlyPlatformAdmin.token)).status).toBe(403);
    expect((await startSupport(tenantA.id, A)).status).toBe(403);
    expect((await startSupport(tenantA.id, platformAdmin.token, 'hm')).status).toBe(400);
    expect((await startSupport('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    const platformTenant = await prisma.tenant.findUnique({ where: { slug: '__platform' } });
    expect((await startSupport(platformTenant.id)).status).toBe(404);
  });

  it('starts a 30-minute read-only session and records it in the tenant’s audit log', async () => {
    const res = await startSupport(tenantA.id);
    expect(res.status).toBe(201);
    session = res.body.data;
    expect(session).toMatchObject({ readOnly: true, tenant: { id: tenantA.id, slug: `phase30-a-${RUN}` } });
    expect(session.refreshToken).toBeUndefined();
    const minutes = (new Date(session.expiresAt) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);

    const log = await prisma.auditLog.findFirst({ where: { tenantId: tenantA.id, resource: 'support_session', resourceId: session.sessionId } });
    expect(log).toMatchObject({ action: 'LOGIN', userId: platformAdmin.userId });
    expect(log.newValue).toMatchObject({ reason: 'Customer asked for help with orders', readOnly: true });
  });

  it('can read what a tenant admin reads', async () => {
    expect((await api.get('/workspace', session.accessToken)).body.data.id).toBe(tenantA.id);
    expect((await api.get('/customers', session.accessToken)).status).toBe(200);
    expect((await api.get('/audit-logs', session.accessToken)).status).toBe(200);

    const me = await api.get('/auth/me', session.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ id: platformAdmin.userId, scope: 'support', tenant: { id: tenantA.id }, support: { sessionId: session.sessionId, readOnly: true } });
    expect(me.body.data.permissions).toContain('customer:read');
    expect(me.body.data.permissions.every((p) => p.endsWith(':read'))).toBe(true);
  });

  it('cannot change anything', async () => {
    const writes = [
      api.post('/customers', session.accessToken, { email: `sup-${RUN}@shop.test`, firstName: 'S', lastName: 'U' }),
      api.patch('/workspace', session.accessToken, { name: 'Changed by support' }),
      api.patch('/workspace/settings', session.accessToken, { currency: 'USD' }),
      api.delete(`/workspace/domains/${(await api.get('/workspace/domains', A)).body.data[0].id}`, session.accessToken),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SUPPORT_READ_ONLY');
    }
    expect((await api.get('/workspace', A)).body.data.name).toBe('Ravi Furniture');
  });

  it('stays out of personal endpoints and the other tenants', async () => {
    for (const path of ['/auth/sessions', '/notifications', '/notification-preferences']) {
      const res = await api.get(path, session.accessToken);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SUPPORT_TOKEN_FORBIDDEN');
    }
    expect((await api.get(`/customers/${customerB.id}`, session.accessToken)).status).toBe(404);
    expect((await api.get('/platform/tenants', session.accessToken)).status).toBe(403);
  });

  it('logs every request in the tenant’s activity log under the platform admin', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const views = await prisma.activityLog.findMany({ where: { tenantId: tenantA.id, action: 'support.view', userId: platformAdmin.userId } });
    const descriptions = views.map((v) => v.description);
    expect(descriptions).toEqual(expect.arrayContaining(['GET /api/v1/workspace', 'GET /api/v1/customers', 'POST /api/v1/customers']));
    expect(views.every((v) => v.metadata.supportSessionId === session.sessionId)).toBe(true);
    expect(views.find((v) => v.description === 'POST /api/v1/customers').metadata.statusCode).toBe(403);
  });

  it('only its owner can end it, and ending it cuts the token off at once', async () => {
    expect((await api.delete(`/platform/support-sessions/${session.sessionId}`, readOnlyPlatformAdmin.token)).status).toBe(403);
    const other = await createPlatformAdmin(app, prisma, { suffix: `p30other_${RUN}` });
    try {
      expect((await api.delete(`/platform/support-sessions/${session.sessionId}`, other.token)).status).toBe(404);
    } finally {
      await other.cleanup();
    }

    expect((await api.delete(`/platform/support-sessions/${session.sessionId}`, platformAdmin.token)).status).toBe(200);
    const after = await api.get('/workspace', session.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
    expect((await api.delete(`/platform/support-sessions/${session.sessionId}`, platformAdmin.token)).status).toBe(200);
  });

  it('ends when the tenant is suspended, and cannot start on a suspended tenant', async () => {
    const live = (await startSupport(tenantB.id)).body.data;
    expect((await api.get('/workspace', live.accessToken)).status).toBe(200);

    await api.patch(`/platform/tenants/${tenantB.id}/status`, platformAdmin.token, { status: 'SUSPENDED' });
    try {
      expect((await api.get('/workspace', live.accessToken)).status).toBe(401);
      const blocked = await startSupport(tenantB.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('TENANT_INACTIVE');
    } finally {
      await api.patch(`/platform/tenants/${tenantB.id}/status`, platformAdmin.token, { status: 'ACTIVE' });
    }
  });

  it('ends when the session expires', async () => {
    const live = (await startSupport(tenantA.id)).body.data;
    await prisma.supportSession.update({ where: { id: live.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api.get('/workspace', live.accessToken)).status).toBe(401);
  });
});
