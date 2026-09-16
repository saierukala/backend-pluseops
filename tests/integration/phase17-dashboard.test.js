import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient } from '../../src/config/database.js';
import { disconnectRedis } from '../../src/config/redis.js';
import { CacheService } from '../../src/common/cache/cache.service.js';
import { dashboardOverviewKey } from '../../src/common/cache/cache.keys.js';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service.js';
import { CACHE_TTL } from '../../src/common/cache/cache.config.js';

const app = createApp();
const prisma = getPrismaClient();

class FakeRedis {
  constructor() {
    this.store = new Map();
    this.ttl = new Map();
    this.failNext = null;
  }
  async get(key) {
    if (this.failNext === 'get') { this.failNext = null; throw new Error('Redis GET failure'); }
    const val = this.store.get(key);
    if (val === undefined) return null;
    const exp = this.ttl.get(key);
    if (exp && Date.now() > exp) {
      this.store.delete(key);
      this.ttl.delete(key);
      return null;
    }
    return val;
  }
  async set(key, value, ...args) {
    if (this.failNext === 'set') { this.failNext = null; throw new Error('Redis SET failure'); }
    this.store.set(key, value);
    const exIndex = args.indexOf('EX');
    if (exIndex !== -1) {
      const ttl = args[exIndex + 1];
      this.ttl.set(key, Date.now() + ttl * 1000);
    }
    return 'OK';
  }
  async del(...keys) {
    if (this.failNext === 'del') { this.failNext = null; throw new Error('Redis DEL failure'); }
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) { this.ttl.delete(k); count++; }
    }
    return count;
  }
  async scan(cursor, ...args) {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx !== -1 ? args[matchIdx + 1] : '*';
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const keys = [...this.store.keys()].filter((k) => regex.test(k));
    return ['0', keys];
  }
  simulateFailure(op) { this.failNext = op; }
}

async function hashPassword(password) {
  const { hash } = await import('argon2');
  return hash(password);
}
async function createTenant(slug) {
  return prisma.tenant.create({ data: { name: `Tenant ${slug}`, slug, status: 'ACTIVE' } });
}
async function createUser(tenantId, email) {
  const passwordHash = await hashPassword('SecurePass123!');
  return prisma.user.create({
    data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } },
  });
}
async function login(email, tenantId) {
  const r = await request(app).post('/api/v1/auth/login').send({ email, password: 'SecurePass123!', tenantId });
  return r.body.data.accessToken;
}
async function ensurePermission(tenantId, resource, action) {
  return prisma.permission.upsert({
    where: { tenantId_resource_action: { tenantId, resource, action } },
    update: {},
    create: { tenantId, name: `${resource}:${action}`, resource, action },
  });
}
async function setupDashboardPerms(tenantId) {
  const perm = await ensurePermission(tenantId, 'dashboard', 'read');
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: 'dashadmin' } },
    update: {},
    create: { tenantId, name: 'dashadmin' },
  });
  await prisma.rolePermission.upsert({
    where: { tenantId_roleId_permissionId: { tenantId, roleId: role.id, permissionId: perm.id } },
    update: {},
    create: { tenantId, roleId: role.id, permissionId: perm.id },
  });
  return role;
}
async function setupNoDashboardRole(tenantId) {
  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: 'noperm' } },
    update: {},
    create: { tenantId, name: 'noperm' },
  });
  return role;
}

describe('Phase 17 - API Orchestration / Dashboard', () => {
  let tenantAId, tenantBId;
  let userAId, userBId, userNoPermId;
  let tokenA, tokenB, tokenNoPerm;
  let warehouseAId;
  let productAId, variantAId;
  let customerAId;
  beforeAll(async () => {
    const ts = Date.now();
    const ta = await createTenant(`dash-a-${ts}`);
    const tb = await createTenant(`dash-b-${ts}`);
    tenantAId = ta.id; tenantBId = tb.id;

    const ua = await createUser(tenantAId, `dash-a-${ts}@a.com`);
    const ub = await createUser(tenantBId, `dash-b-${ts}@b.com`);
    const un = await createUser(tenantAId, `noperm-${ts}@a.com`);
    userAId = ua.id; userBId = ub.id; userNoPermId = un.id;

    const ra = await setupDashboardPerms(tenantAId);
    const rb = await setupDashboardPerms(tenantBId);
    const rn = await setupNoDashboardRole(tenantAId);
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userNoPermId, roleId: rn.id } });

    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);
    tokenNoPerm = await login(un.email, tenantAId);

    // Seed data for tenant A: warehouse, product/variant, customer, order, inventory, notification
    const wh = await prisma.warehouse.create({ data: { tenantId: tenantAId, name: `WH-Dash-A-${ts}`, code: `WDASH-A-${ts}` } });
    warehouseAId = wh.id;
    const product = await prisma.product.create({ data: { tenantId: tenantAId, name: `Prod Dash A ${ts}`, status: 'ACTIVE', basePrice: '100.00' } });
    productAId = product.id;
    const variant = await prisma.productVariant.create({ data: { tenantId: tenantAId, productId: productAId, sku: `SKU-DASH-A-${ts}`, price: '100.00', status: 'ACTIVE' } });
    variantAId = variant.id;
    await prisma.inventory.create({ data: { tenantId: tenantAId, productVariantId: variantAId, warehouseId: warehouseAId, quantity: 50 } });
    await prisma.warehouseInventory.create({ data: { tenantId: tenantAId, warehouseId: warehouseAId, productVariantId: variantAId, quantity: 50 } });
    // Additional variant for tenant A to test low-stock
    const variantLow = await prisma.productVariant.create({ data: { tenantId: tenantAId, productId: productAId, sku: `SKU-DASH-LOW-${ts}`, price: '10.00', status: 'ACTIVE' } });
    await prisma.inventory.create({ data: { tenantId: tenantAId, productVariantId: variantLow.id, warehouseId: warehouseAId, quantity: 2 } });
    await prisma.warehouseInventory.create({ data: { tenantId: tenantAId, warehouseId: warehouseAId, productVariantId: variantLow.id, quantity: 2 } });

    const customer = await prisma.customer.create({ data: { tenantId: tenantAId, email: `cust-dash-a-${ts}@a.com`, firstName: 'Cust', lastName: 'A' } });
    customerAId = customer.id;

    // Create an order directly for tenant A (pending) - enough to appear in dashboard
    const order = await prisma.order.create({
      data: { tenantId: tenantAId, customerId: customerAId, status: 'PENDING', subtotal: '100.00', discountTotal: '0', taxTotal: '0', shippingTotal: '0', total: '100.00', currency: 'USD' },
    });
    await prisma.orderItem.create({
      data: { tenantId: tenantAId, orderId: order.id, productVariantId: variantAId, productNameSnapshot: product.name, variantNameSnapshot: variant.sku, skuSnapshot: variant.sku, unitPrice: '100.00', quantity: 1, discount: '0', tax: '0', lineTotal: '100.00' },
    });
    await prisma.payment.create({ data: { tenantId: tenantAId, orderId: order.id, amount: '100.00', currency: 'USD', status: 'COMPLETED', provider: 'mock', providerPaymentId: `pay-dash-${ts}` } });
    await prisma.notification.create({ data: { tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'Dash A Notif', message: 'hello tenant A', channel: 'IN_APP' } });

    // Seed tenant B with distinct data to test isolation
    const whB = await prisma.warehouse.create({ data: { tenantId: tenantBId, name: `WH-Dash-B-${ts}`, code: `WDASH-B-${ts}` } });
    const prodB = await prisma.product.create({ data: { tenantId: tenantBId, name: `Prod Dash B ${ts}`, status: 'ACTIVE', basePrice: '200.00' } });
    const varB = await prisma.productVariant.create({ data: { tenantId: tenantBId, productId: prodB.id, sku: `SKU-DASH-B-${ts}`, price: '200.00', status: 'ACTIVE' } });
    await prisma.inventory.create({ data: { tenantId: tenantBId, productVariantId: varB.id, warehouseId: whB.id, quantity: 99 } });
    const custB = await prisma.customer.create({ data: { tenantId: tenantBId, email: `cust-dash-b-${ts}@b.com`, firstName: 'Cust', lastName: 'B' } });
    const orderB = await prisma.order.create({ data: { tenantId: tenantBId, customerId: custB.id, status: 'CONFIRMED', subtotal: '200.00', discountTotal: '0', taxTotal: '0', shippingTotal: '0', total: '200.00', currency: 'USD' } });
    await prisma.orderItem.create({ data: { tenantId: tenantBId, orderId: orderB.id, productVariantId: varB.id, productNameSnapshot: prodB.name, variantNameSnapshot: varB.sku, skuSnapshot: varB.sku, unitPrice: '200.00', quantity: 1, discount: '0', tax: '0', lineTotal: '200.00' } });
    await prisma.payment.create({ data: { tenantId: tenantBId, orderId: orderB.id, amount: '200.00', currency: 'USD', status: 'PENDING', provider: 'mock', providerPaymentId: `pay-dash-b-${ts}` } });
    await prisma.notification.create({ data: { tenantId: tenantBId, userId: userBId, type: 'WARNING', title: 'Dash B Notif', message: 'hello tenant B', channel: 'IN_APP' } });
    await prisma.notification.create({ data: { tenantId: tenantBId, type: 'INFO', title: 'B tenant wide', message: 'broadcast', channel: 'IN_APP' } });
  }, 60000);

  afterAll(async () => {
    await disconnectRedis();
    // Do not disconnectDatabase here; other suites may still need it. Just ensure prisma still connected for other tests if run together.
  });

  describe('Endpoint GET /api/v1/dashboard/overview', () => {
    it('successful authorized request returns aggregated data derived from modules', async () => {
      const res = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.tenantId).toBe(tenantAId);
      expect(res.body.data.generatedAt).toBeDefined();
      // Sections
      expect(res.body.data.orders).toBeDefined();
      expect(res.body.data.inventory).toBeDefined();
      expect(res.body.data.payments).toBeDefined();
      expect(res.body.data.users).toBeDefined();
      expect(res.body.data.notifications).toBeDefined();
      expect(res.body.data.products).toBeDefined();

      // Orders actually derived
      expect(res.body.data.orders.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.orders.recent.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.orders.byStatus.PENDING).toBeGreaterThanOrEqual(1);

      // Inventory derived
      expect(res.body.data.inventory.variants).toBeGreaterThanOrEqual(2);
      expect(res.body.data.inventory.warehouses).toBeGreaterThanOrEqual(1);
      expect(res.body.data.inventory.lowStockItems).toBeGreaterThanOrEqual(1);
      expect(res.body.data.inventory.totalQuantity).toBeGreaterThanOrEqual(52);

      // Payments derived
      expect(res.body.data.payments.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.payments.byStatus.COMPLETED).toBeGreaterThanOrEqual(1);

      // Users derived
      expect(res.body.data.users.total).toBeGreaterThanOrEqual(2); // userA + noperm user
      expect(res.body.data.users.recent.length).toBeGreaterThanOrEqual(1);

      // Notifications derived
      expect(res.body.data.notifications.total).toBeGreaterThanOrEqual(1);
      expect(res.body.data.notifications.recent[0].title).toBe('Dash A Notif');

      // Products derived
      expect(res.body.data.products.products).toBeGreaterThanOrEqual(1);
      expect(res.body.data.products.variants).toBeGreaterThanOrEqual(2);

      // Envelope message
      expect(res.body.message).toMatch(/Dashboard/);
      // x-cache header present
      expect(['HIT', 'MISS']).toContain(res.headers['x-cache']);
    });

    it('unauthenticated request returns 401', async () => {
      const res = await request(app).get('/api/v1/dashboard/overview');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toMatch(/UNAUTHORIZED|INVALID_TOKEN|TOKEN/);
    });

    it('authenticated unauthorized (without dashboard:read) returns 403', async () => {
      const res = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${tokenNoPerm}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('tenant isolation: Tenant A cannot obtain Tenant B data', async () => {
      const resA = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${tokenA}`);
      const resB = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${tokenB}`);
      expect(resA.body.data.tenantId).toBe(tenantAId);
      expect(resB.body.data.tenantId).toBe(tenantBId);
      expect(resA.body.data.tenantId).not.toBe(resB.body.data.tenantId);
      // Tenant A has COMPLETED payment, Tenant B has PENDING; verify isolation
      expect(resA.body.data.payments.byStatus.COMPLETED).toBeGreaterThanOrEqual(1);
      expect(resB.body.data.payments.byStatus.PENDING).toBeGreaterThanOrEqual(1);
      // Ensure recent notification titles are tenant-specific
      const titlesA = resA.body.data.notifications.recent.map((n) => n.title);
      const titlesB = resB.body.data.notifications.recent.map((n) => n.title);
      expect(titlesA).not.toEqual(expect.arrayContaining(['Dash B Notif']));
      expect(titlesB).not.toEqual(expect.arrayContaining(['Dash A Notif']));
      // Inventory isolation: quantities differ
      expect(resA.body.data.inventory.totalQuantity).not.toBe(resB.body.data.inventory.totalQuantity);
    });

    it('does not trust client-supplied tenantId query param', async () => {
      const res = await request(app).get(`/api/v1/dashboard/overview?tenantId=${tenantBId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.tenantId).toBe(tenantAId);
      expect(res.body.data.tenantId).not.toBe(tenantBId);
    });

    it('response envelope is consistent and does not leak internals', async () => {
      const res = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('message');
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toMatch(/prisma|stack|at DashboardService|passwordHash|secret/i);
      expect(res.body.error).toBeUndefined();
      expect(res.body.data.tenantId).toBeDefined();
    });

    it('invalid token returns 401', async () => {
      const res = await request(app).get('/api/v1/dashboard/overview').set('Authorization', 'Bearer invalid.token.here');
      expect(res.status).toBe(401);
    });
  });

  describe('Service orchestration', () => {
    it('does not make internal HTTP calls (code inspection)', async () => {
      const fs = await import('node:fs');
      const content = fs.readFileSync('src/modules/dashboard/dashboard.service.js', 'utf8');
      expect(content).not.toMatch(/fetch\s*\(|axios|http\.request|supertest|localhost.*\/api\/v1\/orders|localhost.*\/api\/v1\/inventory/);
      expect(content).toMatch(/Promise\.all/);
    });

    it('delegates to existing domain services via established boundaries (code inspection)', async () => {
      const fs = await import('node:fs');
      const content = fs.readFileSync('src/modules/dashboard/dashboard.service.js', 'utf8');
      // Must import and delegate to domain services, not direct Prisma
      expect(content).toMatch(/OrderService/);
      expect(content).toMatch(/InventoryService/);
      expect(content).toMatch(/PaymentService/);
      expect(content).toMatch(/UserService/);
      expect(content).toMatch(/NotificationService/);
      expect(content).toMatch(/ProductService/);
      expect(content).toMatch(/this\.orderService\.getOverview/);
      expect(content).toMatch(/this\.inventoryService\.getOverview/);
      expect(content).toMatch(/this\.paymentService\.getOverview/);
      expect(content).toMatch(/this\.userService\.getOverview/);
      expect(content).toMatch(/this\.notificationService\.getOverview/);
      expect(content).toMatch(/this\.productService\.getOverview/);
      // DashboardService must NOT contain direct Prisma domain queries
      expect(content).not.toMatch(/this\.prisma\.order\./);
      expect(content).not.toMatch(/this\.prisma\.payment\./);
      expect(content).not.toMatch(/this\.prisma\.inventory\./);
      expect(content).not.toMatch(/this\.prisma\.user\./);
      expect(content).not.toMatch(/this\.prisma\.notification\./);
      expect(content).not.toMatch(/this\.prisma\.product\./);
      expect(content).not.toMatch(/getPrismaClient/);
      expect(content).not.toMatch(/prisma\.order\.groupBy/);
      expect(content).not.toMatch(/prisma\.inventory\.count/);
    });

    it('runtime delegation: DashboardService calls domain service getOverview methods', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const calls = [];
      const mkSvc = (label, ret) => ({ getOverview: async (_tid) => { calls.push(label); return ret; } });
      const svc = new DashboardService({
        cacheService: cache,
        orderService: mkSvc('orders', { total: 1, byStatus: {}, revenueSum: '0.00', recent: [] }),
        inventoryService: mkSvc('inventory', { warehouses: 1, variants: 2, lowStockItems: 0, totalQuantity: 10 }),
        paymentService: mkSvc('payments', { total: 1, byStatus: {}, completedRevenue: '0.00', recent: [] }),
        userService: mkSvc('users', { total: 1, byStatus: {}, recent: [] }),
        notificationService: mkSvc('notifications', { total: 1, unread: 0, recent: [] }),
        productService: mkSvc('products', { products: 1, categories: 0, variants: 1 }),
      });
      const result = await svc.getOverview(tenantAId);
      expect(calls.sort()).toEqual(['inventory', 'notifications', 'orders', 'payments', 'products', 'users'].sort());
      expect(result.data.orders.total).toBe(1);
      expect(result.data.inventory.warehouses).toBe(1);
      expect(result.data.tenantId).toBe(tenantAId);
    });

    it('parallel execution: independent sections are fetched via Promise.allSettled', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      const start = Date.now();
      const result = await svc.getOverview(tenantAId);
      const elapsed = Date.now() - start;
      expect(result.data.orders).toBeDefined();
      // Should be reasonably fast (< 2s) if parallel
      expect(elapsed).toBeLessThan(2000);
    });

    it('domain services contain overview logic via repository (not DashboardService)', async () => {
      const fs = await import('node:fs');
      const orderRepo = fs.readFileSync('src/modules/orders/orders.repository.js', 'utf8');
      const orderSvc = fs.readFileSync('src/modules/orders/orders.service.js', 'utf8');
      expect(orderRepo).toMatch(/getOverview/);
      expect(orderSvc).toMatch(/getOverview/);
      const invRepo = fs.readFileSync('src/modules/inventory/inventory.repository.js', 'utf8');
      expect(invRepo).toMatch(/getOverview/);
      const payRepo = fs.readFileSync('src/modules/payments/payments.repository.js', 'utf8');
      expect(payRepo).toMatch(/getOverview/);
      const userRepo = fs.readFileSync('src/modules/users/users.repository.js', 'utf8');
      expect(userRepo).toMatch(/getOverview/);
      const notifRepo = fs.readFileSync('src/modules/notifications/notifications.repository.js', 'utf8');
      expect(notifRepo).toMatch(/getOverview/);
      const prodRepo = fs.readFileSync('src/modules/products/products.repository.js', 'utf8');
      expect(prodRepo).toMatch(/getOverview/);
    });
  });

  describe('Redis caching', () => {
    it('cache miss loads and caches; cache hit returns cached value', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });

      const key = dashboardOverviewKey(tenantAId);
      expect(await cache.get(key)).toBeNull();

      const first = await svc.getOverview(tenantAId);
      expect(first.cacheHit).toBe(false);
      expect(first.data.tenantId).toBe(tenantAId);
      const cached = await cache.get(key);
      expect(cached).not.toBeNull();
      expect(cached.tenantId).toBe(tenantAId);

      const second = await svc.getOverview(tenantAId);
      expect(second.cacheHit).toBe(true);
      expect(second.data.tenantId).toBe(tenantAId);
      // cached data equals first
      expect(second.data.orders.total).toBe(first.data.orders.total);
    });

    it('tenant-specific cache keys isolation', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });

      const keyA = dashboardOverviewKey(tenantAId);
      const keyB = dashboardOverviewKey(tenantBId);
      expect(keyA).not.toBe(keyB);

      await svc.getOverview(tenantAId);
      await svc.getOverview(tenantBId);
      const cachedA = await cache.get(keyA);
      const cachedB = await cache.get(keyB);
      expect(cachedA.tenantId).toBe(tenantAId);
      expect(cachedB.tenantId).toBe(tenantBId);
      expect(cachedA.tenantId).not.toBe(cachedB.tenantId);
    });

    it('invalidation removes cache', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      await svc.getOverview(tenantAId);
      const key = dashboardOverviewKey(tenantAId);
      expect(await cache.get(key)).not.toBeNull();
      await svc.invalidateCache(tenantAId);
      expect(await cache.get(key)).toBeNull();
    });

    it('Redis unavailable on GET falls back to DB and still returns data', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      fake.simulateFailure('get');
      const result = await svc.getOverview(tenantAId);
      expect(result.data.tenantId).toBe(tenantAId);
      expect(result.data.orders).toBeDefined();
      expect(result.cacheHit).toBe(false);
    });

    it('Redis unavailable on SET does not fail request', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      fake.simulateFailure('set');
      const result = await svc.getOverview(tenantAId);
      expect(result.data.tenantId).toBe(tenantAId);
      expect(result.data.orders.total).toBeGreaterThanOrEqual(1);
    });

    it('TTL config is sensible and cache key does not contain secrets', async () => {
      expect(CACHE_TTL.DASHBOARD_OVERVIEW).toBeGreaterThan(0);
      expect(CACHE_TTL.DASHBOARD_OVERVIEW).toBeLessThan(600);
      const key = dashboardOverviewKey(tenantAId);
      expect(key).not.toMatch(/password|token|secret/i);
      expect(key).toContain(tenantAId);
    });

    it('does not cache sensitive fields', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      await cache.set(dashboardOverviewKey(tenantAId), { id: '1', passwordHash: 'hash', token: 'secret', data: { ok: true } }, 60);
      const stored = await cache.get(dashboardOverviewKey(tenantAId));
      expect(stored.passwordHash).toBeUndefined();
      expect(stored.token).toBeUndefined();
      expect(stored.data.ok).toBe(true);
    });
  });

  describe('Error handling / partial failures', () => {
    it('partial failure: if one section fails, others still return with error marker', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      // Monkey-patch one section to fail
      const original = svc.getPaymentsOverview.bind(svc);
      svc.getPaymentsOverview = async () => { throw Object.assign(new Error('payments down'), { code: 'PAYMENTS_UNAVAILABLE', statusCode: 500 }); };
      const result = await svc.getOverview(tenantAId);
      expect(result.data.orders).toBeDefined();
      expect(result.data.payments.error).toBe(true);
      expect(result.data.payments.message).toMatch(/payments down/i);
      // Restore
      svc.getPaymentsOverview = original;
    });

    it('all sections failing throws', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const svc = new DashboardService({ cacheService: cache });
      svc.getOrdersOverview = async () => { throw new Error('fail1'); };
      svc.getInventoryOverview = async () => { throw new Error('fail2'); };
      svc.getPaymentsOverview = async () => { throw new Error('fail3'); };
      svc.getUsersOverview = async () => { throw new Error('fail4'); };
      svc.getNotificationsOverview = async () => { throw new Error('fail5'); };
      svc.getProductsOverview = async () => { throw new Error('fail6'); };
      await expect(svc.getOverview(tenantAId)).rejects.toThrow();
    });
  });

  describe('Authorization regression', () => {
    it('endpoint requires authentication and dashboard:read permission (403 without)', async () => {
      // Create a user with only order:read but not dashboard:read in tenant A
      const ts = Date.now();
      const user = await createUser(tenantAId, `orderonly-${ts}@a.com`);
      // give order:read only
      const permOrderRead = await ensurePermission(tenantAId, 'order', 'read');
      const role = await prisma.role.create({ data: { tenantId: tenantAId, name: `orderonly-${ts}` } });
      await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: role.id, permissionId: permOrderRead.id } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: user.id, roleId: role.id } });
      const token = await login(user.email, tenantAId);
      const res = await request(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});
