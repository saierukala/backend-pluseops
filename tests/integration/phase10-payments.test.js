import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';

const app = createApp();
const prisma = getPrismaClient();

function webhookSecret() {
  return env.PAYMENT_WEBHOOK_SECRET || 'test-webhook-secret-min-32-chars-long-for-testing';
}
function signPayload(payload) {
  const secret = webhookSecret();
  const str = JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

async function hashPassword(p) { const { hash } = await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tenantId, email) { const passwordHash = await hashPassword('SecurePass123!'); return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } }); }
async function login(email, tenantId) { const r = await request(app).post('/api/v1/auth/login').send({ email, password: 'SecurePass123!', tenantId }); return r.body.data.accessToken; }

async function setupPaymentPerms(tenantId) {
  const perms = [
    { resource: 'payment', action: 'create' },
    { resource: 'payment', action: 'read' },
    { resource: 'payment', action: 'confirm' },
    { resource: 'payment', action: 'refund' },
    { resource: 'product', action: 'create' },
    { resource: 'product', action: 'read' },
    { resource: 'order', action: 'create' },
    { resource: 'order', action: 'read' },
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
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: 'payadmin' } }, update: {}, create: { tenantId, name: 'payadmin' } });
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

describe('Phase 10 - Payment & Transaction Processing', () => {
  let tenantAId, tenantBId, userAId, userBId, tokenA, tokenB;
  let warehouseAId, warehouseBId;
  let productAId, variantAId;
  let customerAId, customerBId;
  let orderBId;

  beforeAll(async () => {
    const ta = await createTenant(`pay-a-${Date.now()}`);
    const tb = await createTenant(`pay-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua = await createUser(tenantAId, `pay-a-${Date.now()}@a.com`);
    const ub = await createUser(tenantBId, `pay-b-${Date.now()}@b.com`);
    userAId = ua.id; userBId = ub.id;
    const ra = await setupPaymentPerms(tenantAId);
    const rb = await setupPaymentPerms(tenantBId);
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);

    let r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'WH-Pay-A', code: `PWH-A-${Date.now()}` });
    warehouseAId = r.body.data.id;
    r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: 'WH-Pay-B', code: `PWH-B-${Date.now()}` });
    warehouseBId = r.body.data.id;

    r = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `Pay Product ${Date.now()}`, status: 'ACTIVE' });
    productAId = r.body.data.id;
    r = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `PAY-SKU-${Date.now()}`, price: '123.45', status: 'ACTIVE' });
    variantAId = r.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantAId, warehouseId: warehouseAId, quantityChanged: 100, reason: 'INITPAY' });

    const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: `Pay Product B ${Date.now()}`, status: 'ACTIVE' });
    const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `PAY-SKU-B-${Date.now()}`, price: '99.00', status: 'ACTIVE' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseBId, quantityChanged: 100, reason: 'INITPAYB' });

    const ca = await prisma.customer.create({ data: { tenantId: tenantAId, email: `paycustA-${Date.now()}@a.com`, firstName: 'Pay', lastName: 'A' } });
    const cb = await prisma.customer.create({ data: { tenantId: tenantBId, email: `paycustB-${Date.now()}@b.com`, firstName: 'Pay', lastName: 'B' } });
    customerAId = ca.id; customerBId = cb.id;

    // Create orders for payments
    let ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 2 }] });
    // keep orderBId for cross-tenant tests, orderAId not needed separately
    void ord.body.data.id;
    // order for tenant B
    const custB = await prisma.customer.findFirst({ where: { tenantId: tenantBId } });
    const varBId = varB.body.data.id;
    ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: custB.id, items: [{ productVariantId: varBId, warehouseId: warehouseBId, quantity: 1 }] });
    orderBId = ord.body.data.id;
  });

  afterAll(async () => {
    await prisma.paymentWebhookEvent.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.paymentTransaction.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.refund.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.payment.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
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

  describe('Payment creation', () => {
    it('POST /api/v1/payments/create - successful creation uses server-side order total', async () => {
      // Create a fresh order for this test
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const oId = ord.body.data.id;
      const expectedTotal = ord.body.data.total.toString();
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: oId });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tenantId).toBe(tenantAId);
      expect(res.body.data.orderId).toBe(oId);
      expect(parseFloat(res.body.data.amount).toFixed(2)).toBe(parseFloat(expectedTotal).toFixed(2));
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.currency).toBe('USD');
      // transaction created
      expect(res.body.data.transactions.length).toBeGreaterThan(0);
      expect(res.body.data.transactions[0].type).toBe('CHARGE');
      // Decimal stored as string but numeric equality via parseFloat
      expect(res.body.data.providerPaymentId).toBeDefined();
    });

    it('rejects invalid order id', async () => {
      const fakeId = crypto.randomUUID();
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: fakeId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('cross-tenant order rejected', async () => {
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: orderBId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('rejects client-supplied amount override (business-agnostic amount truth)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const oId = ord.body.data.id;
      // Try to send amount field which should be stripped/ignored by validation (strict mode will reject unknown keys)
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: oId, amount: '1.00' });
      // strict schema should reject extra field amount
      expect(res.status).toBe(400);
    });

    it('prevents duplicate pending payment for same order', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const oId = ord.body.data.id;
      const r1 = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: oId });
      expect(r1.status).toBe(201);
      const r2 = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: oId });
      expect(r2.status).toBe(400);
      expect(r2.body.error.code).toBe('PAYMENT_ALREADY_PENDING');
    });

    it('unauthorized create -> 403', async () => {
      const viewer = await createUser(tenantAId, `payviewer-${Date.now()}@a.com`);
      const readPerm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'payment', action: 'read' } } });
      const vRole = await prisma.role.create({ data: { tenantId: tenantAId, name: `payviewer-${Date.now()}` } });
      await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: vRole.id, permissionId: readPerm.id } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: vRole.id } });
      const viewerToken = await login(viewer.email, tenantAId);
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${viewerToken}`).send({ orderId: ord.body.data.id });
      expect(res.status).toBe(403);
    });

    it('unauthenticated -> 401', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const res = await request(app).post('/api/v1/payments/create').send({ orderId: ord.body.data.id });
      expect(res.status).toBe(401);
    });
  });

  describe('Payment retrieval', () => {
    it('GET /api/v1/payments/:id - tenant scoped success', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const id = pay.body.data.id;
      const res = await request(app).get(`/api/v1/payments/${id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data.tenantId).toBe(tenantAId);
      // does not leak webhook secret
      expect(JSON.stringify(res.body)).not.toContain(webhookSecret());
    });

    it('cross-tenant retrieval -> 404', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const res = await request(app).get(`/api/v1/payments/${pay.body.data.id}`).set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });

    it('invalid payment id -> 400 or 404 validation', async () => {
      const res = await request(app).get('/api/v1/payments/invalid-uuid').set('Authorization', `Bearer ${tokenA}`);
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('Payment confirmation', () => {
    it('POST /api/v1/payments/confirm - successful PENDING -> COMPLETED', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const id = pay.body.data.id;
      const beforeCount = await prisma.paymentTransaction.count({ where: { paymentId: id } });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: id });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      const afterCount = await prisma.paymentTransaction.count({ where: { paymentId: id } });
      expect(afterCount).toBe(beforeCount + 1);
      const txns = await prisma.paymentTransaction.findMany({ where: { paymentId: id }, orderBy: { createdAt: 'asc' } });
      expect(txns[txns.length - 1].status).toBe('COMPLETED');
    });

    it('confirm with simulateFailure -> FAILED', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id, simulateFailure: true });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('FAILED');
    });

    it('rejects confirmation of already COMPLETED (invalid transition)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('frontend cannot force SUCCESS via status field', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id, status: 'SUCCESS' });
      // strict schema should reject unknown status field
      expect(res.status).toBe(400);
      // Verify payment still PENDING (not forced to success)
      const get = await request(app).get(`/api/v1/payments/${pay.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(get.body.data.status).toBe('PENDING');
    });

    it('cross-tenant confirm -> 404', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenB}`).send({ paymentId: pay.body.data.id });
      expect(res.status).toBe(404);
    });

    it('transaction rollback on invalid transition leaves payment unchanged', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const id = pay.body.data.id;
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: id });
      const before = await prisma.payment.findFirst({ where: { id, tenantId: tenantAId } });
      expect(before.status).toBe('COMPLETED');
      const txnCountBefore = await prisma.paymentTransaction.count({ where: { paymentId: id } });
      const bad = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: id });
      expect(bad.status).toBe(400);
      const after = await prisma.payment.findFirst({ where: { id, tenantId: tenantAId } });
      expect(after.status).toBe('COMPLETED');
      const txnCountAfter = await prisma.paymentTransaction.count({ where: { paymentId: id } });
      expect(txnCountAfter).toBe(txnCountBefore);
    });
  });

  describe('Webhooks', () => {
    it('valid webhook -> processes and updates payment to COMPLETED', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const payload = { eventId: `evt_${Date.now()}_${crypto.randomUUID().slice(0,8)}`, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.duplicate).toBe(false);
      const got = await request(app).get(`/api/v1/payments/${pay.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(got.body.data.status).toBe('COMPLETED');
      // webhook event stored with uniqueness
      const evt = await prisma.paymentWebhookEvent.findFirst({ where: { eventId: payload.eventId } });
      expect(evt).toBeTruthy();
      expect(evt.tenantId).toBe(tenantAId);
    });

    it('invalid webhook signature -> 401', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const payload = { eventId: `evt_bad_${Date.now()}`, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', 'invalidsignature').send(payload);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('malformed webhook -> 400', async () => {
      const payload = { type: 'payment.succeeded' }; // missing eventId
      const sig = signPayload(payload);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect(res.status).toBe(400);
    });

    it('duplicate webhook safely ignored (idempotent)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const eventId = `evt_dup_${Date.now()}_${crypto.randomUUID().slice(0,6)}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      const r1 = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect(r1.status).toBe(200);
      expect(r1.body.duplicate).toBe(false);
      const countBefore = await prisma.paymentTransaction.count({ where: { paymentId: pay.body.data.id } });
      const eventCountBefore = await prisma.paymentWebhookEvent.count({ where: { eventId } });
      const r2 = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect(r2.status).toBe(200);
      expect(r2.body.duplicate).toBe(true);
      const countAfter = await prisma.paymentTransaction.count({ where: { paymentId: pay.body.data.id } });
      expect(countAfter).toBe(countBefore);
      const eventCountAfter = await prisma.paymentWebhookEvent.count({ where: { eventId } });
      expect(eventCountAfter).toBe(1);
      expect(eventCountBefore).toBe(1);
    });

    it('concurrent duplicate webhook handled safely (race)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const eventId = `evt_conc_${Date.now()}_${crypto.randomUUID().slice(0,6)}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      const txnCountBefore = await prisma.paymentTransaction.count({ where: { paymentId: pay.body.data.id } });
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload));
      }
      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.status === 200);
      expect(successes.length).toBe(5);
      const txnCountAfter = await prisma.paymentTransaction.count({ where: { paymentId: pay.body.data.id } });
      // Only one additional transaction should have been created (first)
      expect(txnCountAfter).toBe(txnCountBefore + 1);
      const evtCount = await prisma.paymentWebhookEvent.count({ where: { eventId } });
      expect(evtCount).toBe(1);
      const dupCount = results.filter((r) => r.body.duplicate === true).length;
      expect(dupCount).toBe(4);
    });

    it('webhook uses DB uniqueness constraint not just SELECT-then-INSERT (verified via concurrent test)', async () => {
      // This is verified by previous concurrent test; ensure unique index exists
      const indexes = await prisma.$queryRaw`
        SELECT indexname FROM pg_indexes WHERE tablename = 'payment_webhook_events' AND indexname LIKE '%event_id%'
      `;
      expect(indexes.length).toBeGreaterThan(0);
    });

    it('idempotent transaction behavior: no duplicate state transition', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const eventId = `evt_idem_${Date.now()}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      const status1 = (await prisma.payment.findFirst({ where: { id: pay.body.data.id } })).status;
      await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      const status2 = (await prisma.payment.findFirst({ where: { id: pay.body.data.id } })).status;
      expect(status1).toBe('COMPLETED');
      expect(status2).toBe('COMPLETED');
    });
  });

  describe('Refunds', () => {
    it('POST /:id/refund - successful partial refund', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const amount = pay.body.data.amount;
      const half = (parseFloat(amount) / 2).toFixed(2);
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: half, reason: 'Partial' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PARTIALLY_REFUNDED');
      expect(res.body.data.refunds.length).toBe(1);
      expect(parseFloat(res.body.data.refunds[0].amount).toFixed(2)).toBe(half);
      // transaction history preserved
      const txns = await prisma.paymentTransaction.findMany({ where: { paymentId: pay.body.data.id } });
      expect(txns.some((t) => t.type === 'REFUND')).toBe(true);
    });

    it('successful full refund after partial', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 2 }] });
      // order total = 123.45*2 = 246.90
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const total = parseFloat(pay.body.data.amount);
      const half = (total / 2).toFixed(2);
      const secondHalf = (total - parseFloat(half)).toFixed(2);
      await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: half });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: secondHalf });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REFUNDED');
      const refunds = await prisma.refund.findMany({ where: { paymentId: pay.body.data.id } });
      let sum = 0; for (const r of refunds) sum += parseFloat(r.amount.toString());
      expect(sum.toFixed(2)).toBe(total.toFixed(2));
    });

    it('rejects excessive refund amount', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const excessive = (parseFloat(pay.body.data.amount) + 10).toFixed(2);
      const beforeRefunds = await prisma.refund.count({ where: { paymentId: pay.body.data.id } });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: excessive });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('EXCESSIVE_REFUND');
      const afterRefunds = await prisma.refund.count({ where: { paymentId: pay.body.data.id } });
      expect(afterRefunds).toBe(beforeRefunds);
    });

    it('rejects refund on PENDING payment (invalid state)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: '10.00' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REFUND_STATE');
    });

    it('duplicate refund exceeding refundable is prevented via transaction', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const total = pay.body.data.amount.toString();
      const r1 = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: total });
      expect(r1.status).toBe(200);
      expect(r1.body.data.status).toBe('REFUNDED');
      const r2 = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: '1.00' });
      expect(r2.status).toBe(400);
      // ensure rollback: still REFUNDED and no new refund created
      const count = await prisma.refund.count({ where: { paymentId: pay.body.data.id } });
      expect(count).toBe(1);
    });

    it('cross-tenant refund -> 404', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenB}`).send({ amount: '10.00' });
      expect(res.status).toBe(404);
    });

    it('unauthorized refund -> 403', async () => {
      const viewer = await createUser(tenantAId, `refundviewer-${Date.now()}@a.com`);
      const readPerm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'payment', action: 'read' } } });
      const vRole = await prisma.role.create({ data: { tenantId: tenantAId, name: `refviewer-${Date.now()}` } });
      await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: vRole.id, permissionId: readPerm.id } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: vRole.id } });
      const viewerToken = await login(viewer.email, tenantAId);
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${viewerToken}`).send({ amount: '10.00' });
      expect(res.status).toBe(403);
    });

    it('refund preserves audit history (payment transaction not overwritten)', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const beforeTxns = await prisma.paymentTransaction.findMany({ where: { paymentId: pay.body.data.id }, orderBy: { createdAt: 'asc' } });
      const beforeIds = beforeTxns.map((t) => t.id);
      await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: '10.00' });
      const afterTxns = await prisma.paymentTransaction.findMany({ where: { paymentId: pay.body.data.id }, orderBy: { createdAt: 'asc' } });
      expect(afterTxns.length).toBe(beforeIds.length + 1);
      for (const id of beforeIds) expect(afterTxns.some((t) => t.id === id)).toBe(true);
    });

    it('uses Decimal monetary values - refund 0.01 precision', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const res = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: '0.01' });
      expect(res.status).toBe(200);
      const stored = await prisma.refund.findFirst({ where: { paymentId: pay.body.data.id }, orderBy: { createdAt: 'desc' } });
      expect(parseFloat(stored.amount.toString()).toFixed(2)).toBe('0.01');
    });
  });

  describe('Security & Isolation', () => {
    it('Tenant A cannot refund Tenant B payment (already tested) and cannot read B payment', async () => {
      const ordB = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: customerBId, items: [{ productVariantId: (await prisma.productVariant.findFirst({ where: { tenantId: tenantBId } })).id, warehouseId: warehouseBId, quantity: 1 }] });
      const payB = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenB}`).send({ orderId: ordB.body.data.id });
      const res = await request(app).get(`/api/v1/payments/${payB.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });

    it('sensitive provider data not leaked via webhook secret', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const got = await request(app).get(`/api/v1/payments/${pay.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(JSON.stringify(got.body)).not.toContain(webhookSecret());
      expect(got.body.data.providerPaymentId).toBeDefined();
    });

    it('malformed payment request rejected (missing orderId)', async () => {
      const res = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({});
      expect(res.status).toBe(400);
    });

    it('invalid payment state transition via confirm on terminal REFUNDED', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      const total = pay.body.data.amount.toString();
      await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: total });
      const res = await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay.body.data.id });
      expect(res.status).toBe(400);
    });

    it('business-agnostic: payment works for generic product (no industry fields)', async () => {
      // Already tested via generic variant; just ensure payment module does not require industry concept
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      expect(pay.status).toBe(201);
      expect(pay.body.data.amount).toBeDefined();
    });
  });

  describe('Database & Tenant isolation checks', () => {
    it('tenant isolation enforced via DB tenant_id column for payments', async () => {
      const ordA = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const payA = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ordA.body.data.id });
      const countA = await prisma.payment.count({ where: { tenantId: tenantAId } });
      await prisma.payment.count({ where: { tenantId: tenantBId } });
      // Ensure both have payments but they are isolated
      expect(countA).toBeGreaterThan(0);
      // Direct DB query bypassing tenant context should still respect tenant_id filter
      const leak = await prisma.payment.findFirst({ where: { id: payA.body.data.id, tenantId: tenantBId } });
      expect(leak).toBeNull();
    });

    it('uniqueness enforcement for webhook eventId per tenant', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const eventId = `evt_uniq_${Date.now()}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      // direct DB duplicate insert should fail with P2002
      await expect(prisma.paymentWebhookEvent.create({ data: { tenantId: tenantAId, paymentId: pay.body.data.id, eventId, providerEventId: eventId, type: 'payment.succeeded', payload } })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('payment transaction history remains auditable after webhook and refund', async () => {
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord.body.data.id });
      const eventId = `evt_hist_${Date.now()}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId: pay.body.data.id, tenantId: tenantAId };
      const sig = signPayload(payload);
      await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      // Need to ensure payment is completed via webhook; webhook processing may already set COMPLETED even though confirm not called
      // For this test, create fresh order/payment otherwise webhook would be idempotent on same payment after prior COMPLETED check?
      // Use new order/pay for refund audit
      const ord2 = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantAId, warehouseId: warehouseAId, quantity: 1 }] });
      const pay2 = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: ord2.body.data.id });
      await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${tokenA}`).send({ paymentId: pay2.body.data.id });
      await request(app).post(`/api/v1/payments/${pay2.body.data.id}/refund`).set('Authorization', `Bearer ${tokenA}`).send({ amount: '10.00' });
      const txns = await prisma.paymentTransaction.findMany({ where: { paymentId: pay2.body.data.id } });
      expect(txns.length).toBeGreaterThanOrEqual(3); // initial PENDING, COMPLETED, REFUND
    });
  });
});
