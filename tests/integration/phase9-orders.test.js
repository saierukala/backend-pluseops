import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(p) { const { hash } = await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tenantId, email) { const passwordHash = await hashPassword('SecurePass123!'); return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } }); }
async function login(email, tenantId) { const r = await request(app).post('/api/v1/auth/login').send({ email, password: 'SecurePass123!', tenantId }); return r.body.data.accessToken; }
async function setupPerms(tenantId) {
  const perms = [
    { resource: 'product', action: 'create' }, { resource: 'product', action: 'read' },
    { resource: 'order', action: 'create' }, { resource: 'order', action: 'read' }, { resource: 'order', action: 'update' }, { resource: 'order', action: 'cancel' },
    { resource: 'warehouse', action: 'create' }, { resource: 'warehouse', action: 'read' },
    { resource: 'inventory', action: 'read' }, { resource: 'inventory', action: 'update' },
    { resource: 'customer', action: 'create' }, { resource: 'customer', action: 'read' },
  ];
  for (const p of perms) {
    await prisma.permission.upsert({ where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } }, update: {}, create: { tenantId, name: `${p.resource}:${p.action}`, resource: p.resource, action: p.action } });
  }
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: 'admin' } }, update: {}, create: { tenantId, name: 'admin' } });
  for (const p of perms) {
    const perm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } } });
    await prisma.rolePermission.upsert({ where: { tenantId_roleId_permissionId: { tenantId, roleId: role.id, permissionId: perm.id } }, update: {}, create: { tenantId, roleId: role.id, permissionId: perm.id } });
  }
  return role;
}

describe('Phase 09 - Order Management', () => {
  let tenantAId, tenantBId, userAId, userBId, tokenA, tokenB;
  let warehouseAId, warehouseBId;
  let productAId, variantA1Id, variantA2Id;
  let customerAId, customerBId;
  let viewerToken;

  beforeAll(async () => {
    const ta = await createTenant(`phase9-a-${Date.now()}`);
    const tb = await createTenant(`phase9-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua = await createUser(tenantAId, `a-${Date.now()}@a.com`);
    const ub = await createUser(tenantBId, `b-${Date.now()}@b.com`);
    userAId = ua.id; userBId = ub.id;
    const ra = await setupPerms(tenantAId);
    const rb = await setupPerms(tenantBId);
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);

    // warehouses
    let r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'WH-A', code: `WHA-${Date.now()}` });
    warehouseAId = r.body.data.id;
    r = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: 'WH-B', code: `WHB-${Date.now()}` });
    warehouseBId = r.body.data.id;

    // product + variants for tenant A
    r = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `Order Product ${Date.now()}`, status: 'ACTIVE' });
    productAId = r.body.data.id;
    r = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `ORD-SKU-1-${Date.now()}`, price: '100.00', status: 'ACTIVE' });
    variantA1Id = r.body.data.id;
    r = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `ORD-SKU-2-${Date.now()}`, price: '200.00', status: 'ACTIVE' });
    variantA2Id = r.body.data.id;

    // ensure inventory
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseAId, quantityChanged: 100, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseAId, quantityChanged: 100, reason: 'INIT' });

    // customers via prisma (no API yet)
    const ca = await prisma.customer.create({ data: { tenantId: tenantAId, email: `custA-${Date.now()}@a.com`, firstName: 'Cust', lastName: 'A' } });
    const cb = await prisma.customer.create({ data: { tenantId: tenantBId, email: `custB-${Date.now()}@b.com`, firstName: 'Cust', lastName: 'B' } });
    customerAId = ca.id; customerBId = cb.id;

    // viewer with only order:read
    const viewer = await createUser(tenantAId, `viewer-${Date.now()}@a.com`);
    const readPerm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'order', action: 'read' } } });
    const vRole = await prisma.role.create({ data: { tenantId: tenantAId, name: `viewer-ord-${Date.now()}` } });
    await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: vRole.id, permissionId: readPerm.id } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: vRole.id } });
    viewerToken = await login(viewer.email, tenantAId);
  });

  afterAll(async () => {
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

  describe('Order creation', () => {
    it('POST /api/v1/orders - successful order creation with single item', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 2 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tenantId).toBe(tenantAId);
      expect(res.body.data.customerId).toBe(customerAId);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].productVariantId).toBe(variantA1Id);
      expect(res.body.data.items[0].quantity).toBe(2);
      expect(res.body.data.status).toBe('PENDING');
      // snapshot checks
      const item = res.body.data.items[0];
      expect(item.skuSnapshot).toBeDefined();
      expect(item.productNameSnapshot).toBeDefined();
      expect(item.unitPrice).toBeDefined();
      expect(item.lineTotal).toBeDefined();
      // inventory reduced: 100 -> 98
      const inv = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      expect(inv.quantity).toBe(98);
      // movement created
      const mov = await prisma.inventoryMovement.findFirst({ where: { tenantId: tenantAId, referenceType: 'ORDER', referenceId: res.body.data.id } });
      expect(mov).toBeTruthy();
      expect(mov.type).toBe('ORDER_RESERVATION');
      expect(mov.quantityChanged).toBe(-2);
    });

    it('POST /api/v1/orders - successful order with multiple items and correct totals', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [
          { productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1, discount: '5.00', tax: '2.00' },
          { productVariantId: variantA2Id, warehouseId: warehouseAId, quantity: 2, discount: '0', tax: '0' },
        ],
        shippingTotal: '10.00',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.items.length).toBe(2);
      // calculations: variant1 price 100*1 -5 +2 =97, variant2 200*2=400, subtotal 100+400=500, discount 5, tax 2, shipping 10 => total 507
      expect(parseFloat(res.body.data.subtotal)).toBe(500);
      expect(parseFloat(res.body.data.discountTotal)).toBe(5);
      expect(parseFloat(res.body.data.taxTotal)).toBe(2);
      expect(parseFloat(res.body.data.shippingTotal)).toBe(10);
      expect(parseFloat(res.body.data.total)).toBe(507);
      const item1 = res.body.data.items.find((i) => i.productVariantId === variantA1Id);
      const item2 = res.body.data.items.find((i) => i.productVariantId === variantA2Id);
      expect(parseFloat(item1.unitPrice)).toBe(100);
      expect(item1.quantity).toBe(1);
      expect(parseFloat(item1.lineTotal)).toBe(97);
      expect(parseFloat(item2.unitPrice)).toBe(200);
      expect(parseFloat(item2.lineTotal)).toBe(400);
      // verify snapshots preserved
      expect(item1.skuSnapshot).toBeTruthy();
      expect(item1.productNameSnapshot).toBeTruthy();
      expect(item1.variantNameSnapshot).toBeTruthy();
      expect(item1.attributeSnapshot).toBeDefined();
    });

    it('preserves snapshots after catalog change (write-once)', async () => {
      // Create order then change variant price, verify snapshot unchanged
      const beforeRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const orderId = beforeRes.body.data.id;
      const unitPriceBefore = beforeRes.body.data.items[0].unitPrice.toString();
      // change variant price
      await prisma.productVariant.update({ where: { id: variantA1Id }, data: { price: '999.00' } });
      const getRes = await request(app).get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(getRes.body.data.items[0].unitPrice.toString()).toBe(unitPriceBefore);
      expect(getRes.body.data.items[0].unitPrice.toString()).not.toBe('999.00');
      // revert price
      await prisma.productVariant.update({ where: { id: variantA1Id }, data: { price: '100.00' } });
    });

    it('rejects insufficient inventory and rolls back', async () => {
      // current inventory for variantA1: after previous orders 98-1-1 =96? Let's get current
      const invBefore = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      const orderCountBefore = await prisma.order.count({ where: { tenantId: tenantAId } });
      const movementCountBefore = await prisma.inventoryMovement.count({ where: { tenantId: tenantAId, referenceType: 'ORDER' } });
      const statusHistoryBefore = await prisma.orderStatusHistory.count({ where: { tenantId: tenantAId } });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 999 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      const invAfter = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      expect(invAfter.quantity).toBe(invBefore.quantity);
      const orderCountAfter = await prisma.order.count({ where: { tenantId: tenantAId } });
      expect(orderCountAfter).toBe(orderCountBefore);
      const movementCountAfter = await prisma.inventoryMovement.count({ where: { tenantId: tenantAId, referenceType: 'ORDER' } });
      expect(movementCountAfter).toBe(movementCountBefore);
      const statusAfter = await prisma.orderStatusHistory.count({ where: { tenantId: tenantAId } });
      expect(statusAfter).toBe(statusHistoryBefore);
    });

    it('validates variant is tenant-scoped and active', async () => {
      // create variant in tenant B
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'ProdB', status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseBId, quantityChanged: 10, reason: 'INIT' });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: varB.body.data.id, warehouseId: warehouseAId, quantity: 1 }],
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');

      // inactive variant
      const draftVar = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `DRAFT-${Date.now()}`, price: '10.00', status: 'DRAFT' });
      // need inventory for this variant to avoid insufficient stock before status check, but status check should happen first
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: draftVar.body.data.id, warehouseId: warehouseAId, quantityChanged: 10, reason: 'INIT' });
      const res2 = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: draftVar.body.data.id, warehouseId: warehouseAId, quantity: 1 }],
      });
      expect(res2.status).toBe(400);
      expect(res2.body.error.code).toBe('VARIANT_NOT_SELLABLE');
    });

    it('rejects client-supplied productId instead of variant', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
        productId: productAId,
      });
      expect(res.status).toBe(400);
    });

    it('ignores client-supplied authoritative price and uses DB price', async () => {
      // Even if client tries to send unitPrice in body (stripped), server uses DB price 100.00
      // We test by sending extra field unitPrice in items (will be stripped)
      const res2 = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1, unitPrice: '1.00' }],
      });
      expect(res2.status).toBe(201);
      expect(parseFloat(res2.body.data.items[0].unitPrice)).toBe(100);
      expect(parseFloat(res2.body.data.items[0].unitPrice)).not.toBe(1);
    });

    it('client-supplied tenantId cannot override context', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        tenantId: tenantBId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      // Should succeed and create order in tenant A, not B
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) {
        expect(res.body.data.tenantId).toBe(tenantAId);
        expect(res.body.data.tenantId).not.toBe(tenantBId);
      }
    });

    it('validates warehouse tenant isolation', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseBId, quantity: 1 }],
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WAREHOUSE_NOT_FOUND');
    });

    it('creates inventory movement with correct math', async () => {
      const invBefore = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA2Id, warehouseId: warehouseAId } });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA2Id, warehouseId: warehouseAId, quantity: 3 }],
      });
      expect(res.status).toBe(201);
      const mov = await prisma.inventoryMovement.findFirst({ where: { tenantId: tenantAId, referenceType: 'ORDER', referenceId: res.body.data.id } });
      expect(mov.quantityBefore).toBe(invBefore.quantity);
      expect(mov.quantityAfter).toBe(invBefore.quantity - 3);
      expect(mov.quantityAfter).toBe(mov.quantityBefore + mov.quantityChanged);
      expect(mov.quantityChanged).toBe(-3);
    });
  });

  describe('Order listing and detail', () => {
    it('GET /api/v1/orders - tenant scoped pagination', async () => {
      const res = await request(app).get('/api/v1/orders?page=1&limit=5').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.data.every((o) => o.tenantId === tenantAId)).toBe(true);
    });

    it('GET /api/v1/orders - filters by status', async () => {
      const res = await request(app).get('/api/v1/orders?status=PENDING').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((o) => o.status === 'PENDING')).toBe(true);
    });

    it('GET /api/v1/orders/:id - returns order with items and snapshots', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      const res = await request(app).get(`/api/v1/orders/${id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].skuSnapshot).toBeDefined();
      expect(res.body.data.items[0].productNameSnapshot).toBeDefined();
      expect(res.body.data.items[0].unitPrice).toBeDefined();
    });

    it('GET /api/v1/orders/:id/history - returns status history', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      const res = await request(app).get(`/api/v1/orders/${id}/history`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].toStatus).toBe('PENDING');
    });
  });

  describe('Status transitions', () => {
    it('PATCH /api/v1/orders/:id/status - successful valid transition PENDING -> CONFIRMED', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      const res = await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'CONFIRMED', reason: 'Payment confirmed' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CONFIRMED');
      const hist = await request(app).get(`/api/v1/orders/${id}/history`).set('Authorization', `Bearer ${tokenA}`);
      expect(hist.body.data.some((h) => h.fromStatus === 'PENDING' && h.toStatus === 'CONFIRMED')).toBe(true);
    });

    it('PATCH /api/v1/orders/:id/status - rejects invalid transition', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      const res = await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'DELIVERED' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('PATCH prevents transition from terminal CANCELLED', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      await request(app).post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({});
      const res = await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'CONFIRMED' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });
  });

  describe('Cancellation', () => {
    it('POST /api/v1/orders/:id/cancel - successful cancellation restores inventory and creates movement', async () => {
      const invBefore = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 2 }],
      });
      const id = createRes.body.data.id;
      const invAfterOrder = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      expect(invAfterOrder.quantity).toBe(invBefore.quantity - 2);
      const cancelRes = await request(app).post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({ reason: 'Customer request' });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('CANCELLED');
      const invAfterCancel = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: variantA1Id, warehouseId: warehouseAId } });
      expect(invAfterCancel.quantity).toBe(invBefore.quantity);
      const mov = await prisma.inventoryMovement.findMany({ where: { tenantId: tenantAId, referenceType: 'ORDER', referenceId: id, type: 'ORDER_RELEASE' } });
      expect(mov.length).toBe(1);
      expect(mov[0].quantityChanged).toBe(2);
      expect(mov[0].quantityAfter).toBe(mov[0].quantityBefore + mov[0].quantityChanged);
      const hist = await request(app).get(`/api/v1/orders/${id}/history`).set('Authorization', `Bearer ${tokenA}`);
      expect(hist.body.data.some((h) => h.toStatus === 'CANCELLED')).toBe(true);
    });

    it('POST /api/v1/orders/:id/cancel - rejects invalid cancellation from terminal status', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'CONFIRMED' });
      await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'PROCESSING' });
      await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'SHIPPED' });
      const res = await request(app).post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CANCELLATION_NOT_ALLOWED');
    });

    it('cancelled order inventory restoration is atomic', async () => {
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({
        customerId: customerAId,
        items: [{ productVariantId: variantA2Id, warehouseId: warehouseAId, quantity: 1 }],
      });
      const id = createRes.body.data.id;
      const movCountBeforeCancel = await prisma.inventoryMovement.count({ where: { tenantId: tenantAId, referenceType: 'ORDER', referenceId: id } });
      expect(movCountBeforeCancel).toBe(1);
      await request(app).post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({});
      const movCountAfter = await prisma.inventoryMovement.count({ where: { tenantId: tenantAId, referenceType: 'ORDER', referenceId: id } });
      expect(movCountAfter).toBe(2); // reservation + release
    });
  });

  describe('Authorization', () => {
    it('unauthorized read -> 403', async () => {
      await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${viewerToken}`);
      // viewer has order:read, so should succeed - create a no-perm user
      const noPermUser = await createUser(tenantAId, `noperm-${Date.now()}@a.com`);
      const noPermRole = await prisma.role.create({ data: { tenantId: tenantAId, name: `noperm-${Date.now()}` } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: noPermUser.id, roleId: noPermRole.id } });
      const noPermToken = await login(noPermUser.email, tenantAId);
      const res2 = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${noPermToken}`);
      expect(res2.status).toBe(403);
      // viewer can read but cannot create
      const resCreate = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${viewerToken}`).send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }] });
      expect(resCreate.status).toBe(403);
    });

    it('unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/orders');
      expect(res.status).toBe(401);
      const res2 = await request(app).post('/api/v1/orders').send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }] });
      expect(res2.status).toBe(401);
    });

    it('order:create vs order:read separation', async () => {
      const resRead = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${viewerToken}`);
      expect(resRead.status).toBe(200);
      // order:update vs cancel
      const createRes = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }] });
      const id = createRes.body.data.id;
      const resUpdateViewer = await request(app).patch(`/api/v1/orders/${id}/status`).set('Authorization', `Bearer ${viewerToken}`).send({ status: 'CONFIRMED' });
      expect(resUpdateViewer.status).toBe(403);
      const resCancelViewer = await request(app).post(`/api/v1/orders/${id}/cancel`).set('Authorization', `Bearer ${viewerToken}`).send({});
      expect(resCancelViewer.status).toBe(403);
    });
  });

  describe('Tenant isolation', () => {
    it('Tenant A cannot read Tenant B orders', async () => {
      const createB = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: customerBId, items: [{ productVariantId: (await prisma.productVariant.findFirst({ where: { tenantId: tenantBId } }))?.id || variantA1Id, warehouseId: warehouseBId, quantity: 1 }] });
      // If createB fails due to variant, create product for B
      let orderBId;
      if (createB.status === 201) {
        orderBId = createB.body.data.id;
      } else {
        // create variant for B
        const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'ProdB', status: 'ACTIVE' });
        const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
        await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseBId, quantityChanged: 10, reason: 'INIT' });
        const custB = await prisma.customer.findFirst({ where: { tenantId: tenantBId } });
        const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: custB.id, items: [{ productVariantId: varB.body.data.id, warehouseId: warehouseBId, quantity: 1 }] });
        orderBId = ord.body.data.id;
      }
      const res = await request(app).get(`/api/v1/orders/${orderBId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('Tenant B cannot read Tenant A orders', async () => {
      const createA = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }] });
      const id = createA.body.data.id;
      const res = await request(app).get(`/api/v1/orders/${id}`).set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });

    it('Tenant A cannot use Tenant B variant', async () => {
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: `ProdB2 ${Date.now()}`, status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `BV-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseBId, quantityChanged: 10, reason: 'INIT' });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: varB.body.data.id, warehouseId: warehouseAId, quantity: 1 }] });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    it('Tenant A cannot use Tenant B warehouse', async () => {
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseBId, quantity: 1 }] });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WAREHOUSE_NOT_FOUND');
    });

    it('Tenant A cannot cancel Tenant B order', async () => {
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: `ProdB3 ${Date.now()}`, status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `BC-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseBId, quantityChanged: 10, reason: 'INIT' });
      const custB = await prisma.customer.findFirst({ where: { tenantId: tenantBId } });
      const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`).send({ customerId: custB.id, items: [{ productVariantId: varB.body.data.id, warehouseId: warehouseBId, quantity: 1 }] });
      const res = await request(app).post(`/api/v1/orders/${ord.body.data.id}/cancel`).set('Authorization', `Bearer ${tokenA}`).send({});
      expect(res.status).toBe(404);
    });

    it('order list is tenant isolated both directions', async () => {
      const listA = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`);
      const listB = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${tokenB}`);
      expect(listA.body.data.every((o) => o.tenantId === tenantAId)).toBe(true);
      expect(listB.body.data.every((o) => o.tenantId === tenantBId)).toBe(true);
    });

    it('history is tenant isolated', async () => {
      const createA = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: variantA1Id, warehouseId: warehouseAId, quantity: 1 }] });
      const id = createA.body.data.id;
      const histB = await request(app).get(`/api/v1/orders/${id}/history`).set('Authorization', `Bearer ${tokenB}`);
      expect(histB.status).toBe(404);
    });

    it('manipulated JWT tenant cannot access', async () => {
      const { sign } = await import('jsonwebtoken');
      const { env } = await import('../../src/config/env.js');
      const secret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
      const forged = sign({ sub: userBId, tenantId: tenantAId, sessionId: 'fake', email: 'forge@a.com' }, secret, { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api' });
      const res = await request(app).get('/api/v1/orders').set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });
  });

  describe('Concurrency', () => {
    it('concurrent orders against limited inventory - exactly 5 succeed, inventory never negative', async () => {
      // create variant with limited stock 5
      const prod = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `ConcProd ${Date.now()}`, status: 'ACTIVE' });
      const varRes = await request(app).post(`/api/v1/products/${prod.body.data.id}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `CONCORD-${Date.now()}`, price: '50.00', status: 'ACTIVE' });
      const vid = varRes.body.data.id;
      // reset inventory to exactly 5 (adjust to 5 regardless of current)
      const currentInv = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: vid, warehouseId: warehouseAId } });
      const currentQty = currentInv?.quantity || 0;
      const deltaTo5 = 5 - currentQty;
      if (deltaTo5 !== 0) {
        await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: vid, warehouseId: warehouseAId, quantityChanged: deltaTo5, reason: 'SET5' });
      }
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: vid, warehouseId: warehouseAId, quantity: 1 }] }));
      }
      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.status === 201);
      const failures = results.filter((r) => r.status !== 201);
      expect(successes.length).toBe(5);
      expect(failures.length).toBe(5);
      for (const f of failures) {
        expect(f.status).toBe(400);
        expect(f.body.error.code).toBe('INSUFFICIENT_STOCK');
      }
      const invAfter = await prisma.inventory.findFirst({ where: { tenantId: tenantAId, productVariantId: vid, warehouseId: warehouseAId } });
      expect(invAfter.quantity).toBe(0);
      expect(invAfter.quantity).toBeGreaterThanOrEqual(0);
      // verify movement count = 5 reservations
      const movs = await prisma.inventoryMovement.findMany({ where: { tenantId: tenantAId, productVariantId: vid, warehouseId: warehouseAId, type: 'ORDER_RESERVATION' } });
      // At least 5 movements for this variant (may include initial adjust movements, filter by ORDER type)
      const orderMovs = movs.filter((m) => m.referenceType === 'ORDER');
      expect(orderMovs.length).toBe(5);
      for (const m of orderMovs) {
        expect(m.quantityAfter).toBe(m.quantityBefore + m.quantityChanged);
      }
      // verify no partial orders: count orders with this variant
      const orders = await prisma.order.findMany({ where: { tenantId: tenantAId }, include: { items: true } });
      const concOrders = orders.filter((o) => o.items.some((i) => i.productVariantId === vid));
      expect(concOrders.length).toBe(5);
      for (const o of concOrders) {
        expect(o.items.length).toBe(1);
        expect(o.status).toBe('PENDING');
      }
    });

    it('no duplicate/inconsistent movements', async () => {
      const allMovs = await prisma.inventoryMovement.findMany({ where: { tenantId: tenantAId, type: 'ORDER_RESERVATION' } });
      for (const m of allMovs) {
        expect(m.quantityAfter).toBe(m.quantityBefore + m.quantityChanged);
        expect(m.quantityAfter).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Business-agnostic', () => {
    it('order works for generic product without industry-specific fields', async () => {
      const prod = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `Generic ${Date.now()}`, status: 'ACTIVE' });
      const v = await request(app).post(`/api/v1/products/${prod.body.data.id}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `GEN-${Date.now()}`, price: '77.77', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: v.body.data.id, warehouseId: warehouseAId, quantityChanged: 10, reason: 'INIT' });
      const res = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items: [{ productVariantId: v.body.data.id, warehouseId: warehouseAId, quantity: 1 }] });
      expect(res.status).toBe(201);
      expect(res.body.data.items[0].skuSnapshot).toBe(v.body.data.sku);
    });
  });
});
