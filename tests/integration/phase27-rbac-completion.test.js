import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase27#Pass123';

let platformAdmin;
const tenants = {};

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email} failed: ${res.status}`);
  return { token: res.body.data.accessToken, userId: res.body.data.user.id };
}

async function provisionTenant(key) {
  const adminEmail = `p27-${key}-admin-${RUN}@test.local`;
  const created = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Phase 27 ${key}`, slug: `phase27-${key}-${RUN}`, status: 'ACTIVE', admin: { email: adminEmail, password: PASSWORD, firstName: 'Ada', lastName: key } });
  const tenantId = created.body.data.tenant.id;
  const admin = await login(adminEmail);
  const permissions = await prisma.permission.findMany({ where: { tenantId } });
  const roles = await prisma.role.findMany({ where: { tenantId } });
  const perm = (name) => permissions.find((p) => p.name === name).id;
  const role = (name) => roles.find((r) => r.name === name).id;
  return { tenantId, admin, perm, role, permissionCount: permissions.length };
}

async function registerStaff(tenantId, label) {
  const email = `p27-${label}-${RUN}@test.local`;
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, firstName: 'Sam', lastName: label, tenantId });
  return login(email);
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p27_${RUN}` });
  tenants.a = await provisionTenant('a');
  tenants.b = await provisionTenant('b');
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: [tenants.a?.tenantId, tenants.b?.tenantId].filter(Boolean) } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 27 — GET /permissions pagination', () => {
  it('returns the whole catalog with meta by default', async () => {
    const res = await request(app).get('/api/v1/permissions').set(bearer(tenants.a.admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(tenants.a.permissionCount);
    expect(res.body.meta).toEqual({ page: 1, limit: 100, total: tenants.a.permissionCount, totalPages: 1 });
  });

  it('pages and filters by resource', async () => {
    const page2 = await request(app).get('/api/v1/permissions?page=2&limit=5').set(bearer(tenants.a.admin.token));
    const all = await request(app).get('/api/v1/permissions').set(bearer(tenants.a.admin.token));
    const product = await request(app).get('/api/v1/permissions?resource=product').set(bearer(tenants.a.admin.token));

    expect(page2.body.data).toEqual(all.body.data.slice(5, 10));
    expect(page2.body.meta.totalPages).toBe(Math.ceil(tenants.a.permissionCount / 5));
    expect(product.body.data.map((p) => p.name).sort()).toEqual(['product:create', 'product:delete', 'product:read', 'product:update']);
  });

  it('rejects an invalid page size', async () => {
    const res = await request(app).get('/api/v1/permissions?limit=1000').set(bearer(tenants.a.admin.token));
    expect(res.status).toBe(400);
  });
});

describe('Phase 27 — role permission replace and remove', () => {
  let roleId;

  beforeAll(async () => {
    const res = await request(app).post('/api/v1/roles').set(bearer(tenants.a.admin.token)).send({ name: `editor-${RUN}` });
    roleId = res.body.data.id;
  });

  const names = (res) => res.body.data.map((p) => p.name).sort();

  it('PUT replaces the whole set, including clearing it', async () => {
    const { perm } = tenants.a;
    const first = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.a.admin.token))
      .send({ permissionIds: [perm('product:read'), perm('product:update')] });
    const second = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.a.admin.token))
      .send({ permissionIds: [perm('product:update'), perm('order:read'), perm('order:read')] });

    expect(first.status).toBe(200);
    expect(names(first)).toEqual(['product:read', 'product:update']);
    expect(names(second)).toEqual(['order:read', 'product:update']);

    const cleared = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.a.admin.token)).send({ permissionIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toEqual([]);
  });

  it('PUT with a cross-tenant permission changes nothing', async () => {
    await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.a.admin.token)).send({ permissionIds: [tenants.a.perm('product:read')] });

    const res = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.a.admin.token))
      .send({ permissionIds: [tenants.a.perm('order:read'), tenants.b.perm('order:read')] });
    const role = await request(app).get(`/api/v1/roles/${roleId}`).set(bearer(tenants.a.admin.token));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PERMISSION_IDS');
    expect(role.body.data.permissions.map((p) => p.name)).toEqual(['product:read']);
  });

  it('DELETE removes one permission, then 404s when it is no longer assigned', async () => {
    const productRead = tenants.a.perm('product:read');
    const removed = await request(app).delete(`/api/v1/roles/${roleId}/permissions/${productRead}`).set(bearer(tenants.a.admin.token));
    const again = await request(app).delete(`/api/v1/roles/${roleId}/permissions/${productRead}`).set(bearer(tenants.a.admin.token));

    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual([]);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('PERMISSION_NOT_ASSIGNED');
  });

  it('built-in roles are system roles and cannot be changed', async () => {
    const adminRole = tenants.a.role('admin');
    const put = await request(app).put(`/api/v1/roles/${adminRole}/permissions`).set(bearer(tenants.a.admin.token)).send({ permissionIds: [] });
    const del = await request(app).delete(`/api/v1/roles/${adminRole}/permissions/${tenants.a.perm('role:update')}`).set(bearer(tenants.a.admin.token));

    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    expect(del.status).toBe(403);
  });

  it('another tenant cannot touch the role', async () => {
    const put = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(tenants.b.admin.token)).send({ permissionIds: [] });
    const del = await request(app).delete(`/api/v1/roles/${roleId}/permissions/${tenants.a.perm('order:read')}`).set(bearer(tenants.b.admin.token));

    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it('requires role:update', async () => {
    const staff = await registerStaff(tenants.a.tenantId, 'noperm');
    const res = await request(app).put(`/api/v1/roles/${roleId}/permissions`).set(bearer(staff.token)).send({ permissionIds: [] });
    expect(res.status).toBe(403);
  });
});

describe('Phase 27 — removing roles from users', () => {
  let staff;
  let customRoleId;

  beforeAll(async () => {
    staff = await registerStaff(tenants.a.tenantId, 'staff');
    const role = await request(app).post('/api/v1/roles').set(bearer(tenants.a.admin.token)).send({ name: `viewer-${RUN}` });
    customRoleId = role.body.data.id;
    await request(app).put(`/api/v1/roles/${customRoleId}/permissions`).set(bearer(tenants.a.admin.token)).send({ permissionIds: [tenants.a.perm('product:read')] });
  });

  it('access appears and disappears immediately with the role', async () => {
    expect((await request(app).get('/api/v1/products').set(bearer(staff.token))).status).toBe(403);

    await request(app).post(`/api/v1/users/${staff.userId}/roles`).set(bearer(tenants.a.admin.token)).send({ roleIds: [customRoleId] });
    expect((await request(app).get('/api/v1/products').set(bearer(staff.token))).status).toBe(200);

    const removed = await request(app).delete(`/api/v1/users/${staff.userId}/roles/${customRoleId}`).set(bearer(tenants.a.admin.token));
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual([]);
    expect((await request(app).get('/api/v1/products').set(bearer(staff.token))).status).toBe(403);
  });

  it('role permission changes reach existing holders immediately', async () => {
    await request(app).post(`/api/v1/users/${staff.userId}/roles`).set(bearer(tenants.a.admin.token)).send({ roleIds: [customRoleId] });
    expect((await request(app).get('/api/v1/products').set(bearer(staff.token))).status).toBe(200);

    await request(app).delete(`/api/v1/roles/${customRoleId}/permissions/${tenants.a.perm('product:read')}`).set(bearer(tenants.a.admin.token));
    expect((await request(app).get('/api/v1/products').set(bearer(staff.token))).status).toBe(403);
  });

  it('404s for unassigned, unknown and cross-tenant targets', async () => {
    const memberRole = tenants.a.role('member');
    const notAssigned = await request(app).delete(`/api/v1/users/${staff.userId}/roles/${memberRole}`).set(bearer(tenants.a.admin.token));
    const unknownRole = await request(app).delete(`/api/v1/users/${staff.userId}/roles/00000000-0000-0000-0000-000000000000`).set(bearer(tenants.a.admin.token));
    const otherTenantUser = await request(app).delete(`/api/v1/users/${staff.userId}/roles/${customRoleId}`).set(bearer(tenants.b.admin.token));

    expect(notAssigned.status).toBe(404);
    expect(notAssigned.body.error.code).toBe('ROLE_NOT_ASSIGNED');
    expect(unknownRole.body.error.code).toBe('ROLE_NOT_FOUND');
    expect(otherTenantUser.status).toBe(404);
    expect(otherTenantUser.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('never removes admin from the last admin, but allows it once another admin exists', async () => {
    const adminRole = tenants.a.role('admin');
    const blocked = await request(app).delete(`/api/v1/users/${tenants.a.admin.userId}/roles/${adminRole}`).set(bearer(tenants.a.admin.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LAST_ADMIN_ROLE');

    await request(app).post(`/api/v1/users/${staff.userId}/roles`).set(bearer(tenants.a.admin.token)).send({ roleIds: [adminRole] });
    const allowed = await request(app).delete(`/api/v1/users/${staff.userId}/roles/${adminRole}`).set(bearer(tenants.a.admin.token));
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.map((r) => r.name)).not.toContain('admin');
  });
});

describe('Phase 27 — /auth/me authorization summary', () => {
  it('tenant admin gets roles and the sorted, unique permission names', async () => {
    const res = await request(app).get('/api/v1/auth/me').set(bearer(tenants.a.admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r) => r.name)).toEqual(['admin']);
    expect(res.body.data.roles[0].isSystem).toBe(true);
    const { permissions } = res.body.data;
    expect(permissions).toHaveLength(tenants.a.permissionCount);
    expect(permissions).toEqual([...new Set(permissions)].sort());
    expect(permissions).toEqual(expect.arrayContaining(['product:read', 'role:update', 'jobs:manage']));
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('user without roles gets empty lists', async () => {
    const staff = await registerStaff(tenants.b.tenantId, 'me-empty');
    const res = await request(app).get('/api/v1/auth/me').set(bearer(staff.token));

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual([]);
    expect(res.body.data.permissions).toEqual([]);
  });
});
