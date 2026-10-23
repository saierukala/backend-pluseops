import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase33#Pass123';
const ADMIN_PASSWORD = 'Phase33#Admin!Pass';

let root;
let viewer;
let tenant;
let T;
let planCode;
const createdAdminIds = [];

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

async function platformLogin(email, password) {
  return request(app).post('/api/v1/auth/login').send({ email, password, scope: 'platform' });
}

beforeAll(async () => {
  root = await createPlatformAdmin(app, prisma, { suffix: `p33root_${RUN}` });
  viewer = await createPlatformAdmin(app, prisma, { suffix: `p33view_${RUN}`, permissions: ['platform:tenant:read'] });
  planCode = `p33-${RUN}`;
  const created = await api.post('/platform/tenants', root.token, {
    name: 'Phase 33 shop', slug: `phase33-${RUN}`, status: 'ACTIVE', plan: 'pro',
    admin: { email: `p33-admin-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' },
  });
  tenant = created.body.data.tenant;
  T = (await request(app).post('/api/v1/auth/login').send({ email: `p33-admin-${RUN}@test.local`, password: PASSWORD })).body.data.accessToken;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: tenant?.id } });
  await prisma.user.deleteMany({ where: { id: { in: createdAdminIds } } });
  await prisma.plan.deleteMany({ where: { code: { startsWith: 'p33-' } } });
  await root?.cleanup();
  await viewer?.cleanup();
  await disconnectDatabase();
});

describe('Phase 33 — plans and limits', () => {
  it('lists the default plans with tenant counts, hiding the internal platform plan', async () => {
    const res = await api.get('/platform/plans', root.token);
    expect(res.status).toBe(200);
    const codes = res.body.data.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['free', 'pro', 'enterprise']));
    expect(codes).not.toContain('platform');
    expect(res.body.data.find((p) => p.code === 'pro')).toMatchObject({ limits: { users: null, products: null, warehouses: null, ordersPerMonth: null } });
    expect(res.body.data.find((p) => p.code === 'pro').tenantCount).toBeGreaterThanOrEqual(1);
  });

  it('creates and updates a plan; codes are unique and validated', async () => {
    const res = await api.post('/platform/plans', root.token, { code: planCode, name: 'Tiny', limits: { products: 1, warehouses: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: planCode, limits: { products: 1, warehouses: 1, users: null, ordersPerMonth: null } });
    expect((await api.post('/platform/plans', root.token, { code: planCode, name: 'Dup' })).status).toBe(409);
    expect((await api.post('/platform/plans', root.token, { code: 'platform', name: 'X' })).status).toBe(400);
    expect((await api.post('/platform/plans', root.token, { code: 'bad code!', name: 'X' })).status).toBe(400);
    expect((await api.post('/platform/plans', root.token, { code: `${planCode}-x`, name: 'X', limits: { seats: 3 } })).status).toBe(400);

    const upd = await api.patch(`/platform/plans/${planCode}`, root.token, { limits: { users: 2 } });
    expect(upd.body.data.limits).toEqual({ users: 2, products: 1, warehouses: 1, ordersPerMonth: null });
    expect((await api.patch('/platform/plans/nope', root.token, { name: 'X' })).status).toBe(404);
  });

  it('only assigns existing, active plans', async () => {
    expect((await api.patch(`/platform/tenants/${tenant.id}/plan`, root.token, { plan: 'gold' })).body.error.code).toBe('PLAN_NOT_FOUND');
    expect((await api.patch(`/platform/tenants/${tenant.id}`, root.token, { plan: 'gold' })).status).toBe(400);
    expect((await api.patch(`/platform/tenants/${tenant.id}/plan`, root.token, { plan: 'platform' })).body.error.code).toBe('PLAN_RESERVED');
    const res = await api.patch(`/platform/tenants/${tenant.id}/plan`, root.token, { plan: planCode });
    expect(res.status).toBe(200);
    expect(res.body.data.plan.code).toBe(planCode);
  });

  it('enforces plan limits with PLAN_LIMIT_REACHED', async () => {
    expect((await api.post('/products', T, { name: `First ${RUN}`, status: 'ACTIVE' })).status).toBe(201);
    const second = await api.post('/products', T, { name: `Second ${RUN}`, status: 'ACTIVE' });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { resource: 'products', limit: 1, used: 1, plan: planCode } });

    expect((await api.post('/warehouses', T, { name: 'One', code: `W1-${RUN}` })).status).toBe(201);
    expect((await api.post('/warehouses', T, { name: 'Two', code: `W2-${RUN}` })).body.error.code).toBe('PLAN_LIMIT_REACHED');

    // users: the admin is 1 of 2
    expect((await request(app).post('/api/v1/auth/register').send({ email: `p33-u1-${RUN}@test.local`, password: PASSWORD, firstName: 'U', lastName: 'One', tenantId: tenant.id })).status).toBe(201);
    const third = await request(app).post('/api/v1/auth/register').send({ email: `p33-u2-${RUN}@test.local`, password: PASSWORD, firstName: 'U', lastName: 'Two', tenantId: tenant.id });
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect((await api.post(`/platform/tenants/${tenant.id}/admin`, root.token, { email: `p33-a2-${RUN}@test.local`, password: PASSWORD, firstName: 'A', lastName: 'Two' })).status).toBe(403);
  });

  it('raising a limit (or null = unlimited) lifts the block', async () => {
    await api.patch(`/platform/plans/${planCode}`, root.token, { limits: { products: null } });
    expect((await api.post('/products', T, { name: `Second ${RUN}`, status: 'ACTIVE' })).status).toBe(201);
  });

  it('reports a tenant’s usage against its plan', async () => {
    const res = await api.get(`/platform/tenants/${tenant.id}/usage`, viewer.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plan: { code: planCode, limits: { users: 2, warehouses: 1 } }, usage: { users: 2, products: 2, warehouses: 1, ordersPerMonth: 0 } });
    expect(res.body.data.lastActivityAt).not.toBeNull();
  });

  it('needs billing permissions to change plans', async () => {
    expect((await api.get('/platform/plans', viewer.token)).status).toBe(403);
    expect((await api.post('/platform/plans', viewer.token, { code: `${planCode}-v`, name: 'V' })).status).toBe(403);
    expect((await api.patch(`/platform/tenants/${tenant.id}/plan`, viewer.token, { plan: 'pro' })).status).toBe(403);
    expect((await api.get('/platform/plans', T)).status).toBe(403);
  });
});

describe('Phase 33 — overview and tenant table', () => {
  it('summarises the platform', async () => {
    const res = await api.get('/platform/overview', viewer.token);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.tenants.byStatus.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(d.tenants.total).toBe(Object.values(d.tenants.byStatus).reduce((a, b) => a + b, 0));
    expect(d.tenants.byPlan[planCode]).toBe(1);
    expect(d.tenants.byPlan.platform).toBeUndefined();
    expect(d.tenants.newByMonth.at(-1)).toMatchObject({ month: new Date().toISOString().slice(0, 7) });
    expect(d.users.active).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(d.revenue.total)).toBe(true);
    expect((await api.get('/platform/overview', T)).status).toBe(403);
  });

  it('tenant list rows carry active users and last activity', async () => {
    const res = await api.get(`/platform/tenants?search=phase33-${RUN}`, viewer.token);
    expect(res.body.data).toEqual([expect.objectContaining({ id: tenant.id, usersCount: 2, lastActivityAt: expect.any(String) })]);
  });
});

describe('Phase 33 — platform admins', () => {
  let added;

  it('lists platform roles and admins', async () => {
    const roles = await api.get('/platform/roles', root.token);
    expect(roles.status).toBe(200);
    expect(roles.body.data.find((r) => r.name === `test_platform_p33root_${RUN}`).permissions).toContain('platform:admin:manage');
    const admins = await api.get('/platform/admins', root.token);
    expect(admins.body.data.map((a) => a.id)).toEqual(expect.arrayContaining([root.userId, viewer.userId]));
    expect(JSON.stringify(admins.body)).not.toMatch(/passwordHash/);
  });

  it('adds a platform admin who can sign in to the platform', async () => {
    const roleId = (await api.get('/platform/roles', root.token)).body.data.find((r) => r.name === `test_platform_p33root_${RUN}`).id;
    const res = await api.post('/platform/admins', root.token, { email: `P33-New-${RUN}@test.local`, password: ADMIN_PASSWORD, firstName: 'Nia', lastName: 'New', roleId });
    expect(res.status).toBe(201);
    added = res.body.data;
    createdAdminIds.push(added.id);
    expect(added).toMatchObject({ email: `p33-new-${RUN}@test.local`, roles: [{ id: roleId }] });
    const login = await platformLogin(added.email, ADMIN_PASSWORD);
    expect(login.status).toBe(200);
    added.token = login.body.data.accessToken;
    expect((await api.get('/platform/tenants', added.token)).status).toBe(200);
  });

  it('rejects weak passwords, taken emails and unknown roles', async () => {
    const base = { password: ADMIN_PASSWORD, firstName: 'X', lastName: 'Y' };
    expect((await api.post('/platform/admins', root.token, { ...base, email: `weak-${RUN}@test.local`, password: 'Short#1a' })).status).toBe(400);
    expect((await api.post('/platform/admins', root.token, { ...base, email: `p33-admin-${RUN}@test.local` })).status).toBe(409);
    expect((await api.post('/platform/admins', root.token, { ...base, email: `role-${RUN}@test.local`, roleId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('PLATFORM_ROLE_NOT_FOUND');
  });

  it('only admin managers can add or remove admins', async () => {
    expect((await api.get('/platform/admins', viewer.token)).status).toBe(403);
    expect((await api.post('/platform/admins', viewer.token, { email: `v-${RUN}@test.local`, password: ADMIN_PASSWORD, firstName: 'V', lastName: 'V' })).status).toBe(403);
    expect((await api.delete(`/platform/admins/${root.userId}`, viewer.token)).status).toBe(403);
  });

  it('cannot remove yourself', async () => {
    const res = await api.delete(`/platform/admins/${root.userId}`, root.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('removing an admin cuts their access immediately', async () => {
    const res = await api.delete(`/platform/admins/${added.id}`, root.token);
    expect(res.status).toBe(200);
    expect((await api.get('/platform/tenants', added.token)).status).toBe(401);
    expect((await platformLogin(added.email, ADMIN_PASSWORD)).status).not.toBe(200);
    expect((await api.get('/platform/admins', root.token)).body.data.map((a) => a.id)).not.toContain(added.id);
    expect((await api.delete(`/platform/admins/${added.id}`, root.token)).status).toBe(404);
  });
});

describe('Phase 33 — platform audit trail', () => {
  it('records platform actions with actor, tenant and details', async () => {
    const res = await api.get(`/platform/audit-logs?tenantId=${tenant.id}`, root.token);
    expect(res.status).toBe(200);
    const actions = res.body.data.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.create', 'tenant.plan']));
    const planChange = res.body.data.find((r) => r.action === 'tenant.plan');
    expect(planChange).toMatchObject({ actor: { id: root.userId }, tenant: { id: tenant.id }, details: { from: 'pro', to: planCode } });
  });

  it('filters by action and actor, newest first', async () => {
    const res = await api.get(`/platform/audit-logs?action=platform_admin.remove&actorUserId=${root.userId}`, root.token);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((r) => r.action === 'platform_admin.remove')).toBe(true);
    const all = (await api.get('/platform/audit-logs?limit=5', root.token)).body.data;
    const times = all.map((r) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('is only for platform auditors', async () => {
    expect((await api.get('/platform/audit-logs', viewer.token)).status).toBe(403);
    expect((await api.get('/platform/audit-logs', T)).status).toBe(403);
  });
});
