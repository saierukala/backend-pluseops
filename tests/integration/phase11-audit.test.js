import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(p) { const { hash } = await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tenantId, email) {
  const passwordHash = await hashPassword('SecurePass123!');
  return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } });
}
async function login(email, tenantId) {
  const r = await request(app).post('/api/v1/auth/login').send({ email, password: 'SecurePass123!', tenantId });
  return r.body.data.accessToken;
}

async function setupAuditPerms(tenantId) {
  const perms = [
    { resource: 'audit', action: 'read' },
    { resource: 'activity', action: 'read' },
    { resource: 'user', action: 'read' },
    { resource: 'user', action: 'update' },
    { resource: 'user', action: 'delete' },
    { resource: 'order', action: 'create' },
    { resource: 'order', action: 'read' },
    { resource: 'order', action: 'update' },
    { resource: 'order', action: 'cancel' },
    { resource: 'product', action: 'create' },
    { resource: 'product', action: 'read' },
    { resource: 'warehouse', action: 'create' },
    { resource: 'warehouse', action: 'read' },
    { resource: 'inventory', action: 'update' },
    { resource: 'inventory', action: 'read' },
  ];
  for (const p of perms) {
    await prisma.permission.upsert({
      where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } },
      update: {},
      create: { tenantId, name: `${p.resource}:${p.action}`, resource: p.resource, action: p.action },
    });
  }
  const roleName = `auditadmin-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: roleName } }, update: {}, create: { tenantId, name: roleName } });
  for (const p of perms) {
    const perm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } } });
    await prisma.rolePermission.upsert({
      where: { tenantId_roleId_permissionId: { tenantId, roleId: role.id, permissionId: perm.id } },
      update: {},
      create: { tenantId, roleId: role.id, permissionId: perm.id },
    });
  }
  return role;
}

describe('Phase 11 - Audit & Activity Logs', () => {
  let tenantAId, tenantBId, userAId, userBId, tokenA, tokenB;
  let warehouseAId, variantAId, productAId, customerAId;
  let warehouseBId, variantBId, customerBId;

  beforeAll(async () => {
    const ta = await createTenant(`audit-a-${Date.now()}`);
    const tb = await createTenant(`audit-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua = await createUser(tenantAId, `audit-a-${Date.now()}@a.com`);
    const ub = await createUser(tenantBId, `audit-b-${Date.now()}@b.com`);
    userAId = ua.id; userBId = ub.id;
    const ra = await setupAuditPerms(tenantAId);
    const rb = await setupAuditPerms(tenantBId);
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);

    // Setup product/variant/warehouse/customer for tenant A
    let r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'WH-Audit-A', code: `WHA-${Date.now()}` });
    warehouseAId = r.body.data.id;
    r = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `Audit Product ${Date.now()}`, status: 'ACTIVE' });
    productAId = r.body.data.id;
    r = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `AUDIT-SKU-${Date.now()}`, price: '50.00', status: 'ACTIVE' });
    variantAId = r.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantAId, warehouseId: warehouseAId, quantityChanged: 100, reason: 'INIT_AUDIT' });
    const ca = await prisma.customer.create({ data: { tenantId: tenantAId, email: `auditcustA-${Date.now()}@a.com`, firstName: 'Audit', lastName: 'A' } });
    customerAId = ca.id;

    // Tenant B fixtures
    r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: 'WH-Audit-B', code: `WHB-${Date.now()}` });
    warehouseBId = r.body.data.id;
    r = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: `Audit Product B ${Date.now()}`, status: 'ACTIVE' });
    const prodB = r.body.data.id;
    r = await request(app).post(`/api/v1/products/${prodB}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `AUDIT-SKU-B-${Date.now()}`, price: '30.00', status: 'ACTIVE' });
    variantBId = r.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: variantBId, warehouseId: warehouseBId, quantityChanged: 100, reason: 'INIT_B' });
    const cb = await prisma.customer.create({ data: { tenantId: tenantBId, email: `auditcustB-${Date.now()}@b.com`, firstName: 'Audit', lastName: 'B' } });
    customerBId = cb.id;

    // Create baseline audit records by performing a user update and order creation for each tenant
    // Tenant A baseline
    await request(app).patch(`/api/v1/users/${userAId}`).set('Authorization', `Bearer ${tokenA}`).set('User-Agent', 'test-agent-a').send({ firstName: 'BaselineA' });
    let ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).set('User-Agent', 'test-agent-a').send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
    void ord.body.data.id;
    // Tenant B baseline
    await request(app).patch(`/api/v1/users/${userBId}`).set('Authorization', `Bearer ${tokenB}`).set('User-Agent', 'test-agent-b').send({ firstName: 'BaselineB' });
    ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: customerBId, items: [{ productVariantId: variantBId, warehouseId: warehouseBId, quantity: 1 }] });
    void ord.body.data.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.activityLog.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.orderStatusHistory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.orderItem.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.inventoryMovement.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.inventory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.warehouseInventory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.warehouse.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.customer.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.productVariant.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.product.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.userRole.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.rolePermission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.role.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.permission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  describe('Authentication & Authorization', () => {
    it('GET /api/v1/audit-logs unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/audit-logs');
      expect(res.status).toBe(401);
    });
    it('GET /api/v1/activity-logs unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/activity-logs');
      expect(res.status).toBe(401);
    });
    it('GET /api/v1/activity-logs/:id unauthenticated -> 401', async () => {
      const res = await request(app).get(`/api/v1/activity-logs/${crypto.randomUUID()}`);
      expect(res.status).toBe(401);
    });
    it('unauthorized user without audit:read -> 403', async () => {
      const viewer = await createUser(tenantAId, `auditviewer-${Date.now()}@a.com`);
      // only give user:read, no audit/activity perms
      const perm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'user', action: 'read' } } });
      const role = await prisma.role.create({ data: { tenantId: tenantAId, name: `viewer-${Date.now()}` } });
      await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: role.id, permissionId: perm.id } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: role.id } });
      const vToken = await login(viewer.email, tenantAId);
      const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${vToken}`);
      expect(res.status).toBe(403);
      const res2 = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${vToken}`);
      expect(res2.status).toBe(403);
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant A can read own audit logs', async () => {
      const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const log of res.body.data) expect(log.tenantId).toBe(tenantAId);
    });
    it('Tenant B can read own audit logs', async () => {
      const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.tenantId).toBe(tenantBId);
    });
    it('Tenant A can read own activity logs', async () => {
      const res = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.tenantId).toBe(tenantAId);
    });
    it('Tenant B can read own activity logs', async () => {
      const res = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.tenantId).toBe(tenantBId);
    });
    it('Tenant A cannot read Tenant B audit logs (isolation)', async () => {
      const resA = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenA}`);
      const idsA = new Set(resA.body.data.map((l) => l.id));
      const resB = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenB}`);
      for (const log of resB.body.data) expect(idsA.has(log.id)).toBe(false);
    });
    it('Tenant A cannot read Tenant B activity logs (isolation)', async () => {
      const resA = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      const idsA = new Set(resA.body.data.map((l) => l.id));
      const resB = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenB}`);
      for (const log of resB.body.data) expect(idsA.has(log.id)).toBe(false);
    });
    it('GET /api/v1/activity-logs/:id cross-tenant -> 404 safe', async () => {
      const list = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      expect(list.body.data.length).toBeGreaterThan(0);
      const idA = list.body.data[0].id;
      const res = await request(app).get(`/api/v1/activity-logs/${idA}`).set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ACTIVITY_LOG_NOT_FOUND');
    });
    it('GET /api/v1/activity-logs/:id owner succeeds', async () => {
      const list = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      const idA = list.body.data[0].id;
      const res = await request(app).get(`/api/v1/activity-logs/${idA}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(idA);
      expect(res.body.data.tenantId).toBe(tenantAId);
    });
    it('client tenant_id cannot override authenticated tenant context', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ tenant_id: tenantBId, tenantId: tenantBId }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.tenantId).toBe(tenantAId);
    });
  });

  describe('Validation', () => {
    it('malformed UUID for activity detail -> 400', async () => {
      const res = await request(app).get('/api/v1/activity-logs/not-a-uuid').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('invalid pagination -> 400', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ page: -1 }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
      const res2 = await request(app).get('/api/v1/activity-logs').query({ limit: 9999 }).set('Authorization', `Bearer ${tokenA}`);
      expect(res2.status).toBe(400);
    });
    it('invalid filter action -> 400', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ action: 'INVALID_ACTION_XYZ' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('invalid date filter -> 400', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ from: 'not-a-date' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('pagination works and returns meta', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ page: 1, limit: 1 }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.meta).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.limit).toBe(1);
    });
    it('filtering by action', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ action: 'CREATE' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.action).toBe('CREATE');
    });
    it('filtering by resource', async () => {
      const res = await request(app).get('/api/v1/audit-logs').query({ resource: 'user' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const log of res.body.data) expect(log.resource).toBe('user');
    });
  });

  describe('Security - No sensitive data', () => {
    it('audit logs do not expose passwords/tokens/secrets', async () => {
      const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenA}`);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr.toLowerCase()).not.toContain('passwordhash');
      expect(bodyStr).not.toContain('refresh');
      expect(bodyStr.toLowerCase()).not.toContain('secret');
    });
    it('activity logs do not expose secrets', async () => {
      const res = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr.toLowerCase()).not.toContain('password');
      expect(bodyStr.toLowerCase()).not.toContain('token');
    });
    it('sensitive fields are redacted when stored via audit', async () => {
      // Try to trigger an audit that contains sensitive fields via user update? We cannot send password, but we can test sanitizer directly via DB
      // Create an audit record manually with sensitive payload and ensure retrieval redacted? Instead test via direct service sanitization
      // Use the API: attempt to create a log via internal service not exposed; so verify that DB records don't contain raw password even if passed via API body
      // We test that old_value/new_value redact sensitive keys if we directly insert via repository is not relevant - we test that user update does not store password
      await request(app).patch(`/api/v1/users/${userAId}`).set('Authorization', `Bearer ${tokenA}`).send({ firstName: 'RedactTest' });
      const latest = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId }, orderBy: { createdAt: 'desc' } });
      const str = JSON.stringify(latest);
      expect(str.toLowerCase()).not.toContain('passwordhash');
      expect(str.toLowerCase()).not.toContain('token');
    });
    it('passwords/tokens are not persisted even if passed in old/new values (sanitizer)', async () => {
      // Directly test sanitizer via audit service by creating a log with sensitive data using prisma raw insert to simulate what service would do
      // Instead we test that the audit service redacts: create via service with sensitive newValue
      const { auditService } = await import('../../src/modules/audit/audit.service.js');
      const created = await auditService.logAudit({
        tenantId: tenantAId, userId: userAId, action: 'UPDATE', resource: 'test', resourceId: crypto.randomUUID(),
        oldValue: { password: 'secret123', token: 'abc', normal: 'keep' },
        newValue: { passwordHash: 'hashvalue', apiSecret: 'shhh', keep: 'yes' },
        ipAddress: '127.0.0.1', userAgent: 'jest',
      });
      expect(created.oldValue.password).toBe('[REDACTED]');
      expect(created.oldValue.token).toBe('[REDACTED]');
      expect(created.oldValue.normal).toBe('keep');
      expect(created.newValue.passwordHash).toBe('[REDACTED]');
      expect(created.newValue.apiSecret).toBe('[REDACTED]');
      expect(created.newValue.keep).toBe('yes');
      // cleanup
      await prisma.auditLog.delete({ where: { id: created.id } });
    });
  });

  describe('Mutation -> Audit/Activity records', () => {
    it('successful user update -> audit and activity exist with correct fields', async () => {
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const beforeActivity = await prisma.activityLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).patch(`/api/v1/users/${userAId}`).set('Authorization', `Bearer ${tokenA}`).set('User-Agent', 'phase11-test-agent').send({ lastName: 'AuditVerified' });
      expect(res.status).toBe(200);
      const afterAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const afterActivity = await prisma.activityLog.count({ where: { tenantId: tenantAId } });
      expect(afterAudit).toBe(beforeAudit + 1);
      expect(afterActivity).toBe(beforeActivity + 1);
      const latestAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId }, orderBy: { createdAt: 'desc' } });
      expect(latestAudit.tenantId).toBe(tenantAId);
      expect(latestAudit.userId).toBe(userAId);
      expect(latestAudit.action).toBe('UPDATE');
      expect(latestAudit.resource).toBe('user');
      expect(latestAudit.resourceId).toBe(userAId);
      expect(latestAudit.createdAt).toBeDefined();
      expect(latestAudit.oldValue).toBeDefined();
      expect(latestAudit.newValue).toBeDefined();
      expect(latestAudit.ipAddress).toBeDefined();
      // userAgent may be present
      expect(latestAudit.userAgent).toBe('phase11-test-agent');
      const latestActivity = await prisma.activityLog.findFirst({ where: { tenantId: tenantAId }, orderBy: { createdAt: 'desc' } });
      expect(latestActivity.tenantId).toBe(tenantAId);
      expect(latestActivity.userId).toBe(userAId);
      expect(latestActivity.action).toBe('user.update');
      expect(latestActivity.createdAt).toBeDefined();
    });

    it('successful order creation -> audit and activity with correct tenant/user/action/resource', async () => {
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const beforeActivity = await prisma.activityLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).set('User-Agent', 'order-agent').send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      expect(res.status).toBe(201);
      const orderId = res.body.data.id;
      const latestAudit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, resource: 'order', resourceId: orderId } });
      expect(latestAudit).not.toBeNull();
      expect(latestAudit.tenantId).toBe(tenantAId);
      expect(latestAudit.userId).toBe(userAId);
      expect(latestAudit.action).toBe('CREATE');
      expect(latestAudit.resource).toBe('order');
      expect(latestAudit.resourceId).toBe(orderId);
      expect(latestAudit.newValue).toBeDefined();
      expect(latestAudit.oldValue).toBeNull();
      const latestActivity = await prisma.activityLog.findFirst({ where: { tenantId: tenantAId, action: 'order.create' }, orderBy: { createdAt: 'desc' } });
      expect(latestActivity).not.toBeNull();
      expect(latestActivity.tenantId).toBe(tenantAId);
      expect(latestActivity.userId).toBe(userAId);
      expect(latestActivity.metadata.orderId).toBe(orderId);
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId } })).toBe(beforeAudit + 1);
      expect(await prisma.activityLog.count({ where: { tenantId: tenantAId } })).toBe(beforeActivity + 1);
    });

    it('order status update -> audit/activity', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const orderId = ord.body.data.id;
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).patch(`/api/v1/orders/${orderId}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'CONFIRMED' });
      expect(res.status).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, resource: 'order', resourceId: orderId, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
      expect(audit).not.toBeNull();
      expect(audit.oldValue.status).toBe('PENDING');
      expect(audit.newValue.status).toBe('CONFIRMED');
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId } })).toBe(beforeAudit + 1);
    });

    it('order cancel -> audit/activity', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const orderId = ord.body.data.id;
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({ reason: 'test cancel' });
      expect(res.status).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, resource: 'order', resourceId: orderId, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
      expect(audit).not.toBeNull();
      expect(audit.newValue.status).toBe('CANCELLED');
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId } })).toBe(beforeAudit + 1);
    });

    it('user delete -> audit delete', async () => {
      const tempUser = await createUser(tenantAId, `todelete-${Date.now()}@a.com`);
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).delete(`/api/v1/users/${tempUser.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId, resource: 'user', resourceId: tempUser.id, action: 'DELETE' } });
      expect(audit).not.toBeNull();
      expect(audit.tenantId).toBe(tenantAId);
      expect(audit.userId).toBe(userAId);
      expect(audit.oldValue).toBeDefined();
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId } })).toBe(beforeAudit + 1);
    });

    it('failed/rolled-back mutation does not leave false audit record', async () => {
      // Attempt order creation with insufficient stock - should fail and not create audit for that order
      const beforeAudit = await prisma.auditLog.count({ where: { tenantId: tenantAId } });
      const beforeActivity = await prisma.activityLog.count({ where: { tenantId: tenantAId } });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 99999 }] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(await prisma.auditLog.count({ where: { tenantId: tenantAId } })).toBe(beforeAudit);
      expect(await prisma.activityLog.count({ where: { tenantId: tenantAId } })).toBe(beforeActivity);
      // Ensure no order was created with that huge quantity
      const orders = await prisma.order.findMany({ where: { tenantId: tenantAId } });
      for (const o of orders) expect(o.total.toString()).not.toBe('99999');
    });

    it('timestamps exist on audit/activity records', async () => {
      const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantAId }, orderBy: { createdAt: 'desc' } });
      expect(audit.createdAt).toBeInstanceOf(Date);
      const activity = await prisma.activityLog.findFirst({ where: { tenantId: tenantAId }, orderBy: { createdAt: 'desc' } });
      expect(activity.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('API response format', () => {
    it('GET /api/v1/audit-logs returns correct format with pagination', async () => {
      const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.message).toBeDefined();
    });
    it('GET /api/v1/activity-logs returns correct format with pagination', async () => {
      const res = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toBeDefined();
    });
    it('GET /api/v1/activity-logs/:id returns correct format', async () => {
      const list = await request(app).get('/api/v1/activity-logs').set('Authorization', `Bearer ${tokenA}`);
      const id = list.body.data[0].id;
      const res = await request(app).get(`/api/v1/activity-logs/${id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data.tenantId).toBe(tenantAId);
    });
    it('GET /api/v1/activity-logs/:id not found -> 404', async () => {
      const res = await request(app).get(`/api/v1/activity-logs/${crypto.randomUUID()}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });
  });
});
