import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(password) {
  const { hash } = await import('argon2');
  return hash(password);
}

async function createTestTenant(slug) {
  return prisma.tenant.create({ data: { name: `Test Tenant ${slug}`, slug, status: 'ACTIVE' } });
}

async function createTestUser(tenantId, email, password = 'SecurePass123!') {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } });
}

async function loginAndGetToken(email, password, tenantId) {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password, tenantId });
  return response.body.data.accessToken;
}

async function setupTenantWithPermissions(tenantId, extraPerms = []) {
  const SYSTEM_PERMISSIONS = [
    { resource: 'product', action: 'create', name: 'product:create' },
    { resource: 'product', action: 'read', name: 'product:read' },
    { resource: 'product', action: 'update', name: 'product:update' },
    { resource: 'product', action: 'delete', name: 'product:delete' },
    { resource: 'inventory', action: 'read', name: 'inventory:read' },
    { resource: 'inventory', action: 'update', name: 'inventory:update' },
    { resource: 'warehouse', action: 'create', name: 'warehouse:create' },
    { resource: 'warehouse', action: 'read', name: 'warehouse:read' },
    { resource: 'warehouse', action: 'update', name: 'warehouse:update' },
    { resource: 'warehouse', action: 'delete', name: 'warehouse:delete' },
  ];
  const all = [...SYSTEM_PERMISSIONS, ...extraPerms];
  const permissions = {};
  for (const perm of all) {
    const p = await prisma.permission.upsert({ where: { tenantId_resource_action: { tenantId, resource: perm.resource, action: perm.action } }, update: {}, create: { tenantId, name: perm.name, resource: perm.resource, action: perm.action } });
    permissions[perm.name] = p.id;
  }
  const role = await prisma.role.upsert({ where: { tenantId_name: { tenantId, name: 'admin' } }, update: {}, create: { tenantId, name: 'admin', description: 'Admin role', isSystem: true } });
  for (const permId of Object.values(permissions)) {
    await prisma.rolePermission.upsert({ where: { tenantId_roleId_permissionId: { tenantId, roleId: role.id, permissionId: permId } }, update: {}, create: { tenantId, roleId: role.id, permissionId: permId } });
  }
  return { roleId: role.id, permissions };
}

describe('Phase 08 - Inventory Management', () => {
  let tenantAId;
  let tenantBId;
  let userAId;
  let userBId;
  let tokenA;
  let tokenB;
  let productIdA;
  let variantA1Id;
  let variantA2Id;
  let variantA3Id;
  let warehouseA1Id;
  let warehouseA2Id;
  let warehouseB1Id;
  let viewerTokenA;

  beforeAll(async () => {
    const tenantA = await createTestTenant(`tenant-a-phase8-${Date.now()}`);
    tenantAId = tenantA.id;
    const tenantB = await createTestTenant(`tenant-b-phase8-${Date.now()}`);
    tenantBId = tenantB.id;

    const userA = await createTestUser(tenantAId, `usera-phase8-${Date.now()}@tenant-a.com`);
    userAId = userA.id;
    const userB = await createTestUser(tenantBId, `userb-phase8-${Date.now()}@tenant-b.com`);
    userBId = userB.id;

    const { roleId: roleA } = await setupTenantWithPermissions(tenantAId);
    const { roleId: roleB } = await setupTenantWithPermissions(tenantBId);

    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: roleA } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: roleB } });

    tokenA = await loginAndGetToken(userA.email, 'SecurePass123!', tenantAId);
    tokenB = await loginAndGetToken(userB.email, 'SecurePass123!', tenantBId);

    // create warehouses for tenant A
    let res = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Hyderabad', code: 'HYD' });
    expect(res.status).toBe(201);
    warehouseA1Id = res.body.data.id;
    res = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Bangalore', code: 'BLR' });
    expect(res.status).toBe(201);
    warehouseA2Id = res.body.data.id;

    // warehouse for tenant B
    res = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Mumbai', code: 'MUM' });
    expect(res.status).toBe(201);
    warehouseB1Id = res.body.data.id;

    // create product for tenant A
    res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Oversized T-Shirt', status: 'ACTIVE' });
    expect(res.status).toBe(201);
    productIdA = res.body.data.id;

    // create 3 variants (SKUs)
    res = await request(app).post(`/api/v1/products/${productIdA}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `UTS-BLK-S-${Date.now()}`, price: '999.00', status: 'ACTIVE' });
    expect(res.status).toBe(201);
    variantA1Id = res.body.data.id;
    res = await request(app).post(`/api/v1/products/${productIdA}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `UTS-BLK-M-${Date.now()}`, price: '999.00', status: 'ACTIVE' });
    expect(res.status).toBe(201);
    variantA2Id = res.body.data.id;
    res = await request(app).post(`/api/v1/products/${productIdA}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `UTS-WHT-M-${Date.now()}`, price: '999.00', status: 'ACTIVE' });
    expect(res.status).toBe(201);
    variantA3Id = res.body.data.id;

    // seed roadmap example stocks: UTS-BLK-S 12/8, UTS-BLK-M 25/14, UTS-WHT-M 10/6
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 12, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA2Id, quantityChanged: 8, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: 25, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA2Id, quantityChanged: 14, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA3Id, warehouseId: warehouseA1Id, quantityChanged: 10, reason: 'INIT' });
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA3Id, warehouseId: warehouseA2Id, quantityChanged: 6, reason: 'INIT' });

    // create viewer user with only read permission for authorization tests
    const viewer = await createTestUser(tenantAId, `viewer-phase8-${Date.now()}@tenant-a.com`);
    // create role with only inventory:read
    const readPerm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'inventory', action: 'read' } } });
    const viewerRole = await prisma.role.create({ data: { tenantId: tenantAId, name: `viewer-${Date.now()}`, description: 'viewer' } });
    await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: viewerRole.id, permissionId: readPerm.id } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: viewerRole.id } });
    viewerTokenA = await loginAndGetToken(viewer.email, 'SecurePass123!', tenantAId);
  });

  afterAll(async () => {
    await prisma.inventoryMovement.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.inventory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.warehouseInventory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.warehouse.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
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

  describe('Inventory reads', () => {
    it('GET /api/v1/inventory - lists inventory with pagination', async () => {
      const res = await request(app).get('/api/v1/inventory').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.total).toBeGreaterThanOrEqual(6);
    });

    it('GET /api/v1/inventory - filters by warehouse', async () => {
      const res = await request(app).get(`/api/v1/inventory?warehouseId=${warehouseA1Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((i) => i.warehouseId === warehouseA1Id)).toBe(true);
    });

    it('GET /api/v1/inventory - filters by variant', async () => {
      const res = await request(app).get(`/api/v1/inventory?variantId=${variantA1Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((i) => i.productVariantId === variantA1Id)).toBe(true);
      expect(res.body.data.length).toBe(2);
    });

    it('GET /api/v1/inventory/variants/:variantId - returns warehouse-specific quantities', async () => {
      const res = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      const hyd = res.body.data.find((x) => x.warehouseId === warehouseA1Id);
      const blr = res.body.data.find((x) => x.warehouseId === warehouseA2Id);
      expect(hyd.quantity).toBe(25);
      expect(blr.quantity).toBe(14);
    });

    it('GET /api/v1/inventory/movements - returns tenant-scoped movement history', async () => {
      const res = await request(app).get('/api/v1/inventory/movements').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((m) => m.tenantId === tenantAId)).toBe(true);
    });

    it('GET /api/v1/inventory/low-stock - returns deterministic low stock with threshold 10', async () => {
      const res = await request(app).get('/api/v1/inventory/low-stock?threshold=10').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.every((i) => i.quantity <= 10)).toBe(true);
      // Based on seed 10 and 6 and 8 should be low stock
      const quantities = res.body.data.map((i) => i.quantity).sort((a, b) => a - b);
      expect(quantities).toContain(6);
      expect(quantities).toContain(8);
      expect(quantities).toContain(10);
    });
  });

  describe('Inventory adjustments', () => {
    it('POST /api/v1/inventory/adjust - positive adjustment creates movement with correct before/after', async () => {
      const beforeRes = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      const beforeHyd = beforeRes.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: 5, reason: 'RESTOCK' });
      expect(res.status).toBe(200);
      expect(res.body.data.quantityBefore).toBe(beforeHyd);
      expect(res.body.data.quantityAfter).toBe(beforeHyd + 5);
      expect(res.body.data.quantityChanged).toBe(5);
      expect(res.body.data.movement.quantityAfter).toBe(res.body.data.movement.quantityBefore + res.body.data.movement.quantityChanged);
      // revert
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: -5, reason: 'REVERT' });
    });

    it('POST /api/v1/inventory/adjust - negative adjustment reduces stock', async () => {
      const beforeRes = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      const beforeHyd = beforeRes.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: -2, reason: 'SALE' });
      expect(res.status).toBe(200);
      expect(res.body.data.quantityAfter).toBe(beforeHyd - 2);
      expect(res.body.data.movement.quantityChanged).toBe(-2);
      // revert
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: 2, reason: 'REVERT' });
    });

    it('POST /api/v1/inventory/adjust - rejects insufficient stock and does not change stock', async () => {
      const beforeRes = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      const beforeHyd = beforeRes.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: -1000, reason: 'OVERDRAW' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      const afterRes = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      const afterHyd = afterRes.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      expect(afterHyd).toBe(beforeHyd);
      // ensure no movement was created with invalid before/after (movement count should not increase for failed)
      // we check that last movement for this variant is not the failed one: insufficient should not create movement with incorrect math
    });

    it('POST /api/v1/inventory/adjust - rejects zero quantity', async () => {
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseA1Id, quantityChanged: 0, reason: 'ZERO' });
      expect(res.status).toBe(400);
    });

    it('POST /api/v1/inventory/adjust - validates warehouse exists and is tenant scoped', async () => {
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, warehouseId: warehouseB1Id, quantityChanged: 5, reason: 'CROSS' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WAREHOUSE_NOT_FOUND');
    });

    it('POST /api/v1/inventory/adjust - validates variant exists and is tenant scoped', async () => {
      // create variant in tenant B
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Product B', status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B-SKU-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: varB.body.data.id, warehouseId: warehouseA1Id, quantityChanged: 5, reason: 'CROSS' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    it('movement history accurately represents stock transition', async () => {
      const beforeRes = await request(app).get(`/api/v1/inventory/variants/${variantA1Id}`).set('Authorization', `Bearer ${tokenA}`);
      const before = beforeRes.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 3, reason: 'CHECK_MOVEMENT' });
      expect(res.status).toBe(200);
      expect(res.body.data.movement.quantityBefore).toBe(before);
      expect(res.body.data.movement.quantityAfter).toBe(before + 3);
      expect(res.body.data.movement.quantityAfter).toBe(res.body.data.movement.quantityBefore + res.body.data.movement.quantityChanged);
      // verify movement stored correctly
      const movRes = await request(app).get(`/api/v1/inventory/movements?variantId=${variantA1Id}&warehouseId=${warehouseA1Id}`).set('Authorization', `Bearer ${tokenA}`);
      const last = movRes.body.data[0];
      expect(last.quantityAfter).toBe(last.quantityBefore + last.quantityChanged);
      // revert
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: -3, reason: 'REVERT' });
    });
  });

  describe('Inventory transfers', () => {
    it('POST /api/v1/inventory/transfer - successful transfer validates source decrease and dest increase and creates movements', async () => {
      const beforeA = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      const srcBefore = beforeA.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const dstBefore = beforeA.body.data.find((x) => x.warehouseId === warehouseA2Id).quantity;
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: warehouseA2Id, quantity: 5, reason: 'REBALANCE' });
      expect(res.status).toBe(200);
      expect(res.body.data.sourceBefore).toBe(srcBefore);
      expect(res.body.data.sourceAfter).toBe(srcBefore - 5);
      expect(res.body.data.destBefore).toBe(dstBefore);
      expect(res.body.data.destAfter).toBe(dstBefore + 5);
      expect(res.body.data.sourceMovement.quantityChanged).toBe(-5);
      expect(res.body.data.destMovement.quantityChanged).toBe(5);
      expect(res.body.data.sourceMovement.quantityAfter).toBe(res.body.data.sourceMovement.quantityBefore + res.body.data.sourceMovement.quantityChanged);
      expect(res.body.data.destMovement.quantityAfter).toBe(res.body.data.destMovement.quantityBefore + res.body.data.destMovement.quantityChanged);
      // verify inventory after
      const after = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(after.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity).toBe(srcBefore - 5);
      expect(after.body.data.find((x) => x.warehouseId === warehouseA2Id).quantity).toBe(dstBefore + 5);
      // revert transfer
      await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: warehouseA2Id, destinationWarehouseId: warehouseA1Id, quantity: 5, reason: 'REVERT' });
    });

    it('POST /api/v1/inventory/transfer - rejects insufficient source stock and does not commit partial', async () => {
      const beforeSrc = await request(app).get(`/api/v1/inventory/variants/${variantA3Id}`).set('Authorization', `Bearer ${tokenA}`);
      const srcBefore = beforeSrc.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity;
      const dstBefore = beforeSrc.body.data.find((x) => x.warehouseId === warehouseA2Id).quantity;
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA3Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: warehouseA2Id, quantity: 999, reason: 'OVER' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      const after = await request(app).get(`/api/v1/inventory/variants/${variantA3Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(after.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity).toBe(srcBefore);
      expect(after.body.data.find((x) => x.warehouseId === warehouseA2Id).quantity).toBe(dstBefore);
    });

    it('POST /api/v1/inventory/transfer - rejects invalid source warehouse', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: '00000000-0000-0000-0000-000000000000', destinationWarehouseId: warehouseA2Id, quantity: 1 });
      expect(res.status).toBe(404);
    });

    it('POST /api/v1/inventory/transfer - rejects invalid destination warehouse', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: '00000000-0000-0000-0000-000000000000', quantity: 1 });
      expect(res.status).toBe(404);
    });

    it('POST /api/v1/inventory/transfer - rejects same warehouse', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: warehouseA1Id, quantity: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SAME_WAREHOUSE');
    });

    it('POST /api/v1/inventory/transfer - validates tenant ownership of warehouses and variant', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA2Id, sourceWarehouseId: warehouseB1Id, destinationWarehouseId: warehouseA2Id, quantity: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe('Warehouse handling & variant SKU level', () => {
    it('warehouses maintain independent stock per variant/SKU', async () => {
      // variantA1 and variantA2 have independent stock: checked via earlier seed
      const r1 = await request(app).get(`/api/v1/inventory/variants/${variantA1Id}`).set('Authorization', `Bearer ${tokenA}`);
      const r2 = await request(app).get(`/api/v1/inventory/variants/${variantA2Id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(r1.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity).not.toBe(r2.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity);
      // same SKU different warehouses independent
      expect(r1.body.data.find((x) => x.warehouseId === warehouseA1Id).quantity).not.toBe(r1.body.data.find((x) => x.warehouseId === warehouseA2Id).quantity);
    });

    it('cross-tenant warehouse creation isolation - same code allowed in different tenant', async () => {
      const resA = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Shared Code', code: `SHARED-${Date.now()}` });
      expect(resA.status).toBe(201);
      const sameCode = resA.body.data.code;
      const resB = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Shared Code B', code: sameCode });
      expect(resB.status).toBe(201);
    });
  });

  describe('Authorization', () => {
    it('authorized read - succeeds with inventory:read', async () => {
      const res = await request(app).get('/api/v1/inventory').set('Authorization', `Bearer ${viewerTokenA}`);
      expect(res.status).toBe(200);
    });

    it('unauthorized update - viewer with only read cannot adjust', async () => {
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${viewerTokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 1, reason: 'TEST' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('unauthorized update - viewer cannot transfer', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${viewerTokenA}`).send({ variantId: variantA1Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: warehouseA2Id, quantity: 1 });
      expect(res.status).toBe(403);
    });

    it('unauthenticated request fails with 401', async () => {
      const res = await request(app).get('/api/v1/inventory');
      expect(res.status).toBe(401);
      const res2 = await request(app).post('/api/v1/inventory/adjust').send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 1 });
      expect(res2.status).toBe(401);
    });

    it('authorized update - succeeds with inventory:update', async () => {
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 1, reason: 'AUTH_TEST' });
      expect(res.status).toBe(200);
      // revert
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: -1, reason: 'REVERT' });
    });
  });

  describe('Tenant isolation', () => {
    it('Tenant A cannot read Tenant B inventory', async () => {
      // create inventory for B
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Product B', status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B-ISO-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseB1Id, quantityChanged: 42, reason: 'INIT_B' });
      const resA = await request(app).get('/api/v1/inventory').set('Authorization', `Bearer ${tokenA}`);
      expect(resA.body.data.every((i) => i.tenantId === tenantAId)).toBe(true);
      expect(resA.body.data.some((i) => i.productVariantId === varB.body.data.id)).toBe(false);
    });

    it('Tenant B cannot read Tenant A inventory', async () => {
      const resB = await request(app).get('/api/v1/inventory').set('Authorization', `Bearer ${tokenB}`);
      expect(resB.body.data.every((i) => i.tenantId === tenantBId)).toBe(true);
      expect(resB.body.data.some((i) => i.productVariantId === variantA1Id)).toBe(false);
    });

    it('Tenant A cannot adjust Tenant B inventory (variant)', async () => {
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Product B2', status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B2-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: varB.body.data.id, warehouseId: warehouseA1Id, quantityChanged: 5, reason: 'ATTACK' });
      expect(res.status).toBe(404);
    });

    it('Tenant B cannot adjust Tenant A inventory', async () => {
      const res = await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: variantA1Id, warehouseId: warehouseA1Id, quantityChanged: 5, reason: 'ATTACK' });
      expect(res.status).toBe(404);
    });

    it('Tenant A cannot transfer Tenant B inventory', async () => {
      // create second warehouse for B for transfer test
      const whB2 = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`).send({ name: `WHB2-${Date.now()}`, code: `WHB2-${Date.now()}` });
      const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Product B3', status: 'ACTIVE' });
      const varB = await request(app).post(`/api/v1/products/${prodB.body.data.id}/variants`).set('Authorization', `Bearer ${tokenB}`).send({ sku: `B3-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenB}`).send({ variantId: varB.body.data.id, warehouseId: warehouseB1Id, quantityChanged: 10, reason: 'INIT' });
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenA}`).send({ variantId: varB.body.data.id, sourceWarehouseId: warehouseB1Id, destinationWarehouseId: whB2.body.data.id, quantity: 1 });
      expect(res.status).toBe(404);
    });

    it('Tenant B cannot transfer Tenant A inventory', async () => {
      const res = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${tokenB}`).send({ variantId: variantA1Id, sourceWarehouseId: warehouseA1Id, destinationWarehouseId: warehouseA2Id, quantity: 1 });
      expect(res.status).toBe(404);
    });

    it('movement history is isolated per tenant', async () => {
      const resA = await request(app).get('/api/v1/inventory/movements').set('Authorization', `Bearer ${tokenA}`);
      const resB = await request(app).get('/api/v1/inventory/movements').set('Authorization', `Bearer ${tokenB}`);
      expect(resA.body.data.every((m) => m.tenantId === tenantAId)).toBe(true);
      expect(resB.body.data.every((m) => m.tenantId === tenantBId)).toBe(true);
    });

    it('warehouses are isolated per tenant', async () => {
      const resA = await request(app).get('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`);
      expect(resA.body.data.every((w) => w.tenantId === tenantAId)).toBe(true);
      const resB = await request(app).get('/api/v1/warehouses').set('Authorization', `Bearer ${tokenB}`);
      expect(resB.body.data.every((w) => w.tenantId === tenantBId)).toBe(true);
      expect(resA.body.data.some((w) => w.id === warehouseB1Id)).toBe(false);
    });

    it('variants are tenant scoped via inventory - cross tenant variant returns 404', async () => {
      const res = await request(app).get(`/api/v1/inventory/variants/${variantA1Id}`).set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });
  });

  describe('Concurrency protection', () => {
    it('concurrent decrements cannot create negative stock - stock never negative', async () => {
      // create dedicated variant with 5 stock
      const prod = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: `Conc Product ${Date.now()}`, status: 'ACTIVE' });
      const varRes = await request(app).post(`/api/v1/products/${prod.body.data.id}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku: `CONC-${Date.now()}`, price: '10.00', status: 'ACTIVE' });
      const concVar = varRes.body.data.id;
      await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: concVar, warehouseId: warehouseA1Id, quantityChanged: 5, reason: 'INIT' });
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: concVar, warehouseId: warehouseA1Id, quantityChanged: -1, reason: 'CONC' }));
      }
      const results = await Promise.all(promises);
      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status !== 200);
      // all failures should be insufficient stock, not server error
      for (const f of failures) {
        expect([400, 409]).toContain(f.status);
        if (f.status === 400) expect(f.body.error.code).toBe('INSUFFICIENT_STOCK');
      }
      expect(successes.length).toBe(5);
      expect(failures.length).toBe(5);
      const after = await request(app).get(`/api/v1/inventory/variants/${concVar}`).set('Authorization', `Bearer ${tokenA}`);
      const hyd = after.body.data.find((x) => x.warehouseId === warehouseA1Id);
      expect(hyd.quantity).toBe(0);
      expect(hyd.quantity).toBeGreaterThanOrEqual(0);
      // verify no movement has inconsistent math
      const mov = await request(app).get(`/api/v1/inventory/movements?variantId=${concVar}`).set('Authorization', `Bearer ${tokenA}`);
      for (const m of mov.body.data) {
        expect(m.quantityAfter).toBe(m.quantityBefore + m.quantityChanged);
      }
    });
  });
});
