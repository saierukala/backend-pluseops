import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient } from '../../src/config/database.js';
import { disconnectRedis } from '../../src/config/redis.js';
import { CacheService } from '../../src/common/cache/cache.service.js';
import { analyticsKey } from '../../src/common/cache/cache.keys.js';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service.js';
import { CACHE_TTL } from '../../src/common/cache/cache.config.js';

const app = createApp();
const prisma = getPrismaClient();

class FakeRedis {
  constructor() { this.store = new Map(); this.ttl = new Map(); this.failNext = null; }
  async get(key) { if (this.failNext === 'get') { this.failNext = null; throw new Error('Redis GET failure'); } const val = this.store.get(key); if (val === undefined) return null; const exp = this.ttl.get(key); if (exp && Date.now() > exp) { this.store.delete(key); this.ttl.delete(key); return null; } return val; }
  async set(key, value, ...args) { if (this.failNext === 'set') { this.failNext = null; throw new Error('Redis SET failure'); } this.store.set(key, value); const exIndex = args.indexOf('EX'); if (exIndex !== -1) { const ttl = args[exIndex + 1]; this.ttl.set(key, Date.now() + ttl * 1000); } return 'OK'; }
  async del(...keys) { if (this.failNext === 'del') { this.failNext = null; throw new Error('Redis DEL failure'); } let count=0; for (const k of keys) { if(this.store.delete(k)) {this.ttl.delete(k); count++;} } return count; }
  async scan(cursor, ...args) { const matchIdx = args.indexOf('MATCH'); const pattern = matchIdx !== -1 ? args[matchIdx+1] : '*'; const regex = new RegExp('^' + pattern.replace(/\*/g,'.*') + '$'); const keys=[...this.store.keys()].filter(k=>regex.test(k)); return ['0', keys]; }
  simulateFailure(op) { this.failNext = op; }
}

async function hashPassword(p) { const {hash}=await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data:{name:`Tenant ${slug}`, slug, status:'ACTIVE'}}); }
async function createUser(tenantId,email) { const ph=await hashPassword('SecurePass123!'); return prisma.user.create({data:{tenantId,email,passwordHash:ph,firstName:'Test',lastName:'User',memberships:{create:{tenantId}}}}); }
async function login(email,tenantId) { const r=await request(app).post('/api/v1/auth/login').send({email,password:'SecurePass123!',tenantId}); return r.body.data.accessToken; }
async function ensurePermission(tenantId,resource,action){ return prisma.permission.upsert({where:{tenantId_resource_action:{tenantId,resource,action}},update:{},create:{tenantId,name:`${resource}:${action}`,resource,action}}); }
async function setupAnalyticsPerms(tenantId){ const perm=await ensurePermission(tenantId,'analytics','read'); const role=await prisma.role.upsert({where:{tenantId_name:{tenantId,name:'analyticsadmin'}},update:{},create:{tenantId,name:'analyticsadmin'}}); await prisma.rolePermission.upsert({where:{tenantId_roleId_permissionId:{tenantId,roleId:role.id,permissionId:perm.id}},update:{},create:{tenantId,roleId:role.id,permissionId:perm.id}}); return role; }
async function setupNoPermRole(tenantId){ const role=await prisma.role.upsert({where:{tenantId_name:{tenantId,name:'noperm_a18'}},update:{},create:{tenantId,name:'noperm_a18'}}); return role; }

describe('Phase 18 - Analytics & Reporting', () => {
  let tenantAId, tenantBId, tenantRefundId;
  let userAId, userBId, userNoPermId, userRefundId;
  let tokenA, tokenB, tokenNoPerm, tokenRefund;
  let productAId, variantAId, variantA2Id, categoryAId, warehouseAId, customerAId;
  let productBId, variantBId, warehouseBId, customerBId;
  // refund tenant helpers (no unused vars)

  beforeAll(async () => {
    const ts = Date.now();
    const ta = await createTenant(`ana-a-${ts}`);
    const tb = await createTenant(`ana-b-${ts}`);
    const tr = await createTenant(`ana-refund-${ts}`);
    tenantAId = ta.id; tenantBId = tb.id; tenantRefundId = tr.id;

    const ua = await createUser(tenantAId, `ana-a-${ts}@a.com`);
    const ub = await createUser(tenantBId, `ana-b-${ts}@b.com`);
    const un = await createUser(tenantAId, `noperm-${ts}@a.com`);
    const ur = await createUser(tenantRefundId, `ana-refund-${ts}@r.com`);
    userAId = ua.id; userBId = ub.id; userNoPermId = un.id; userRefundId = ur.id;

    const ra = await setupAnalyticsPerms(tenantAId);
    const rb = await setupAnalyticsPerms(tenantBId);
    const rr = await setupAnalyticsPerms(tenantRefundId);
    const rn = await setupNoPermRole(tenantAId);
    await prisma.userRole.create({data:{tenantId:tenantAId,userId:userAId,roleId:ra.id}});
    await prisma.userRole.create({data:{tenantId:tenantBId,userId:userBId,roleId:rb.id}});
    await prisma.userRole.create({data:{tenantId:tenantRefundId,userId:userRefundId,roleId:rr.id}});
    await prisma.userRole.create({data:{tenantId:tenantAId,userId:userNoPermId,roleId:rn.id}});

    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);
    tokenNoPerm = await login(un.email, tenantAId);
    tokenRefund = await login(ur.email, tenantRefundId);

    // Seed tenant A data
    const wh = await prisma.warehouse.create({data:{tenantId:tenantAId,name:`WH-A-${ts}`,code:`WA-${ts}`}}); warehouseAId = wh.id;
    const cat = await prisma.category.create({data:{tenantId:tenantAId,name:`Cat A ${ts}`,slug:`cat-a-${ts}`}}); categoryAId = cat.id;
    const product = await prisma.product.create({data:{tenantId:tenantAId,name:`Prod A ${ts}`,status:'ACTIVE',basePrice:'100.00'}}); productAId = product.id;
    await prisma.productCategory.create({data:{tenantId:tenantAId,productId:productAId,categoryId:categoryAId,isPrimary:true}});
    const variant = await prisma.productVariant.create({data:{tenantId:tenantAId,productId:productAId,sku:`SKU-A-${ts}`,price:'50.00',status:'ACTIVE'}}); variantAId = variant.id;
    const variant2 = await prisma.productVariant.create({data:{tenantId:tenantAId,productId:productAId,sku:`SKU-A2-${ts}`,price:'30.00',status:'ACTIVE'}}); variantA2Id = variant2.id;
    await prisma.inventory.create({data:{tenantId:tenantAId,productVariantId:variantAId,warehouseId:warehouseAId,quantity:100}});
    await prisma.inventory.create({data:{tenantId:tenantAId,productVariantId:variantA2Id,warehouseId:warehouseAId,quantity:3}});
    await prisma.warehouseInventory.create({data:{tenantId:tenantAId,warehouseId:warehouseAId,productVariantId:variantAId,quantity:100}});
    await prisma.warehouseInventory.create({data:{tenantId:tenantAId,warehouseId:warehouseAId,productVariantId:variantA2Id,quantity:3}});
    const cust = await prisma.customer.create({data:{tenantId:tenantAId,email:`cust-a-${ts}@a.com`,firstName:'Cust',lastName:'A'}}); customerAId=cust.id;

    // Create orders for tenant A with known totals
    const order1 = await prisma.order.create({data:{tenantId:tenantAId,customerId:customerAId,status:'PENDING',subtotal:'50.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'50.00',currency:'USD',createdAt:new Date('2026-08-10T10:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantAId,orderId:order1.id,productVariantId:variantAId,productNameSnapshot:product.name,variantNameSnapshot:variant.sku,skuSnapshot:variant.sku,unitPrice:'50.00',quantity:1,discount:'0',tax:'0',lineTotal:'50.00',createdAt:new Date('2026-08-10T10:00:00Z')}});
    const order2 = await prisma.order.create({data:{tenantId:tenantAId,customerId:customerAId,status:'DELIVERED',subtotal:'60.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'60.00',currency:'USD',createdAt:new Date('2026-08-11T10:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantAId,orderId:order2.id,productVariantId:variantA2Id,productNameSnapshot:product.name,variantNameSnapshot:variant2.sku,skuSnapshot:variant2.sku,unitPrice:'30.00',quantity:2,discount:'0',tax:'0',lineTotal:'60.00',createdAt:new Date('2026-08-11T10:00:00Z')}});
    await prisma.payment.create({data:{tenantId:tenantAId,orderId:order1.id,amount:'50.00',currency:'USD',status:'COMPLETED',provider:'mock',providerPaymentId:`pay-a1-${ts}`,createdAt:new Date('2026-08-10T10:00:00Z')}});
    await prisma.payment.create({data:{tenantId:tenantAId,orderId:order2.id,amount:'60.00',currency:'USD',status:'PENDING',provider:'mock',providerPaymentId:`pay-a2-${ts}`,createdAt:new Date('2026-08-11T10:00:00Z')}});
    await prisma.refund.create({data:{tenantId:tenantAId,paymentId:(await prisma.payment.findFirst({where:{tenantId:tenantAId,providerPaymentId:`pay-a1-${ts}`}})).id,amount:'10.00',currency:'USD',status:'COMPLETED',reason:'partial'}});

    // Tenant B data distinct
    const whB = await prisma.warehouse.create({data:{tenantId:tenantBId,name:`WH-B-${ts}`,code:`WB-${ts}`}}); warehouseBId = whB.id;
    const prodB = await prisma.product.create({data:{tenantId:tenantBId,name:`Prod B ${ts}`,status:'ACTIVE',basePrice:'200.00'}}); productBId = prodB.id;
    const varB = await prisma.productVariant.create({data:{tenantId:tenantBId,productId:productBId,sku:`SKU-B-${ts}`,price:'200.00',status:'ACTIVE'}}); variantBId = varB.id;
    await prisma.inventory.create({data:{tenantId:tenantBId,productVariantId:variantBId,warehouseId:warehouseBId,quantity:999}});
    const custB = await prisma.customer.create({data:{tenantId:tenantBId,email:`cust-b-${ts}@b.com`,firstName:'Cust',lastName:'B'}}); customerBId = custB.id;
    const orderB = await prisma.order.create({data:{tenantId:tenantBId,customerId:customerBId,status:'CONFIRMED',subtotal:'200.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'200.00',currency:'USD',createdAt:new Date('2026-08-12T10:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantBId,orderId:orderB.id,productVariantId:variantBId,productNameSnapshot:prodB.name,variantNameSnapshot:varB.sku,skuSnapshot:varB.sku,unitPrice:'200.00',quantity:1,discount:'0',tax:'0',lineTotal:'200.00'}});
    await prisma.payment.create({data:{tenantId:tenantBId,orderId:orderB.id,amount:'200.00',currency:'USD',status:'COMPLETED',provider:'mock',providerPaymentId:`pay-b-${ts}`}});

    // Dedicated refund tenant: deterministic revenue/refund semantics
    // Use isolated tenantRefundId to avoid polluting tenantA totals
    await prisma.warehouse.create({data:{tenantId:tenantRefundId,name:`WH-R-${ts}`,code:`WR-${ts}`}});
    const prodR = await prisma.product.create({data:{tenantId:tenantRefundId,name:`Prod R ${ts}`,status:'ACTIVE',basePrice:'100.00'}});
    const varR = await prisma.productVariant.create({data:{tenantId:tenantRefundId,productId:prodR.id,sku:`SKU-R-${ts}`,price:'100.00',status:'ACTIVE'}});
    const custR = await prisma.customer.create({data:{tenantId:tenantRefundId,email:`cust-r-${ts}@r.com`,firstName:'Cust',lastName:'R'}});
    // Orders/payments with distinct timestamps
    const orderR1 = await prisma.order.create({data:{tenantId:tenantRefundId,customerId:custR.id,status:'DELIVERED',subtotal:'100.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'100.00',currency:'USD',createdAt:new Date('2026-08-15T10:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantRefundId,orderId:orderR1.id,productVariantId:varR.id,productNameSnapshot:prodR.name,variantNameSnapshot:varR.sku,skuSnapshot:varR.sku,unitPrice:'100.00',quantity:1,discount:'0',tax:'0',lineTotal:'100.00'}});
    const orderR2 = await prisma.order.create({data:{tenantId:tenantRefundId,customerId:custR.id,status:'DELIVERED',subtotal:'50.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'50.00',currency:'USD',createdAt:new Date('2026-08-20T10:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantRefundId,orderId:orderR2.id,productVariantId:varR.id,productNameSnapshot:prodR.name,variantNameSnapshot:varR.sku,skuSnapshot:varR.sku,unitPrice:'50.00',quantity:1,discount:'0',tax:'0',lineTotal:'50.00'}});
    // Payments: one inside August, one outside (July), one inside later
    const payInside = await prisma.payment.create({data:{tenantId:tenantRefundId,orderId:orderR1.id,amount:'100.00',currency:'USD',status:'COMPLETED',provider:'mock',providerPaymentId:`pay-r-inside-${ts}`,createdAt:new Date('2026-08-15T12:00:00Z')}});
    const payOutside = await prisma.payment.create({data:{tenantId:tenantRefundId,orderId:orderR2.id,amount:'50.00',currency:'USD',status:'COMPLETED',provider:'mock',providerPaymentId:`pay-r-outside-${ts}`,createdAt:new Date('2026-07-01T12:00:00Z')}});
    void orderR1; void payInside;
    // Refunds: one inside August (20th), one outside July, one associated with July payment but created in August (to test refund date vs payment date)
    await prisma.refund.create({data:{tenantId:tenantRefundId,paymentId:payInside.id,amount:'10.00',currency:'USD',status:'COMPLETED',reason:'inside',createdAt:new Date('2026-08-16T12:00:00Z'),updatedAt:new Date('2026-08-16T12:00:00Z')}});
    await prisma.refund.create({data:{tenantId:tenantRefundId,paymentId:payOutside.id,amount:'5.00',currency:'USD',status:'COMPLETED',reason:'outside',createdAt:new Date('2026-07-02T12:00:00Z'),updatedAt:new Date('2026-07-02T12:00:00Z')}});
    // Refund associated with July payment but created inside August - should count when querying August range (refund timestamp semantics)
    await prisma.refund.create({data:{tenantId:tenantRefundId,paymentId:payOutside.id,amount:'7.00',currency:'USD',status:'COMPLETED',reason:'cross',createdAt:new Date('2026-08-18T12:00:00Z'),updatedAt:new Date('2026-08-18T12:00:00Z')}});
    // Additional UTC grouping edge: order at 23:00 UTC should bucket to same UTC day, not next day in IST
    const orderUTCEdge = await prisma.order.create({data:{tenantId:tenantRefundId,customerId:custR.id,status:'PENDING',subtotal:'25.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'25.00',currency:'USD',createdAt:new Date('2026-08-10T23:00:00Z')}});
    await prisma.orderItem.create({data:{tenantId:tenantRefundId,orderId:orderUTCEdge.id,productVariantId:varR.id,productNameSnapshot:prodR.name,variantNameSnapshot:varR.sku,skuSnapshot:varR.sku,unitPrice:'25.00',quantity:1,discount:'0',tax:'0',lineTotal:'25.00'}});
    // Week grouping edge: orders in same UTC week
    await prisma.order.create({data:{tenantId:tenantRefundId,customerId:custR.id,status:'PENDING',subtotal:'30.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'30.00',currency:'USD',createdAt:new Date('2026-08-03T01:00:00Z')}});
    await prisma.order.create({data:{tenantId:tenantRefundId,customerId:custR.id,status:'PENDING',subtotal:'30.00',discountTotal:'0',taxTotal:'0',shippingTotal:'0',total:'30.00',currency:'USD',createdAt:new Date('2026-08-04T01:00:00Z')}});
  }, 60000);

  afterAll(async () => { await disconnectRedis(); });

  describe('GET /api/v1/analytics/overview', () => {
    it('overview success returns aggregated tenant data', async () => {
      const res = await request(app).get('/api/v1/analytics/overview').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.orders).toBeDefined();
      expect(res.body.data.sales).toBeDefined();
      expect(res.body.data.customers).toBeDefined();
      expect(res.body.data.inventory).toBeDefined();
      expect(res.body.data.revenue).toBeDefined();
      expect(res.body.data.revenue.completedRevenue).toBe('50.00');
      expect(res.body.data.orders.total).toBeGreaterThanOrEqual(2);
      expect(['HIT','MISS']).toContain(res.headers['x-cache']);
    });
    it('unauthenticated ->401', async () => {
      const res = await request(app).get('/api/v1/analytics/overview');
      expect(res.status).toBe(401);
    });
    it('without permission ->403', async () => {
      const res = await request(app).get('/api/v1/analytics/overview').set('Authorization', `Bearer ${tokenNoPerm}`);
      expect(res.status).toBe(403);
    });
    it('tenant isolation', async () => {
      const ra = await request(app).get('/api/v1/analytics/overview').set('Authorization', `Bearer ${tokenA}`);
      const rb = await request(app).get('/api/v1/analytics/overview').set('Authorization', `Bearer ${tokenB}`);
      expect(ra.body.data.revenue.completedRevenue).not.toBe(rb.body.data.revenue.completedRevenue);
      expect(ra.body.data.inventory.totalQuantity).not.toBe(rb.body.data.inventory.totalQuantity);
    });
    it('ignores client tenantId', async () => {
      const res = await request(app).get(`/api/v1/analytics/overview?tenantId=${tenantBId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.revenue.completedRevenue).toBe('50.00');
    });
    it('invalid date ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/overview?from=invalid-date').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
    it('invalid date range from>to ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/overview?from=2026-08-20&to=2026-08-10').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/analytics/sales', () => {
    it('sales success with date range and groupBy day', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?from=2026-08-01&to=2026-08-31&groupBy=day').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.summary.orderCount).toBeGreaterThanOrEqual(2);
      expect(res.body.pagination).toBeDefined();
      expect(res.headers['x-cache']).toBeDefined();
    });
    it('sales category filtering', async () => {
      const res = await request(app).get(`/api/v1/analytics/sales?category=${categoryAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.orderCount).toBeGreaterThanOrEqual(1);
    });
    it('sales product filtering', async () => {
      const res = await request(app).get(`/api/v1/analytics/sales?product=${productAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.orderCount).toBeGreaterThanOrEqual(2);
    });
    it('sales status filtering', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?status=PENDING').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      // Should have at least 1 pending
      expect(res.body.summary.orderCount).toBeGreaterThanOrEqual(1);
    });
    it('invalid groupBy ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?groupBy=invalid').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('invalid pagination ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?page=0&limit=200').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('tenant isolation sales', async () => {
      const ra = await request(app).get('/api/v1/analytics/sales').set('Authorization', `Bearer ${tokenA}`);
      const rb = await request(app).get('/api/v1/analytics/sales').set('Authorization', `Bearer ${tokenB}`);
      expect(ra.body.summary.totalSales).not.toBe(rb.body.summary.totalSales);
    });
  });

  describe('GET /api/v1/analytics/orders', () => {
    it('orders success', async () => {
      const res = await request(app).get('/api/v1/analytics/orders').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.total).toBeGreaterThanOrEqual(2);
    });
    it('orders grouped by month', async () => {
      const res = await request(app).get('/api/v1/analytics/orders?groupBy=month').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
    it('orders status filter', async () => {
      const res = await request(app).get('/api/v1/analytics/orders?status=DELIVERED').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.byStatus.DELIVERED).toBeGreaterThanOrEqual(1);
    });
    it('invalid status ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/orders?status=INVALID').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/analytics/inventory', () => {
    it('inventory success', async () => {
      const res = await request(app).get('/api/v1/analytics/inventory').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.totalQuantity).toBeGreaterThanOrEqual(103);
      expect(res.body.summary.lowStockItems).toBeGreaterThanOrEqual(1);
      expect(res.body.pagination).toBeDefined();
    });
    it('inventory product filter', async () => {
      const res = await request(app).get(`/api/v1/analytics/inventory?product=${productAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.variants).toBeGreaterThanOrEqual(2);
    });
    it('inventory category filter', async () => {
      const res = await request(app).get(`/api/v1/analytics/inventory?category=${categoryAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
    });
    it('inventory warehouse filter', async () => {
      const res = await request(app).get(`/api/v1/analytics/inventory?warehouseId=${warehouseAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.totalQuantity).toBe(103);
    });
    it('invalid product id ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/inventory?product=not-a-uuid').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/analytics/customers', () => {
    it('customers success', async () => {
      const res = await request(app).get('/api/v1/analytics/customers').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.totalCustomers).toBeGreaterThanOrEqual(1);
      expect(res.body.pagination).toBeDefined();
    });
    it('customers groupBy day', async () => {
      const res = await request(app).get('/api/v1/analytics/customers?groupBy=day').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.buckets).toBeDefined();
    });
  });

  describe('GET /api/v1/analytics/revenue', () => {
    it('revenue success', async () => {
      const res = await request(app).get('/api/v1/analytics/revenue').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.grossRevenue).toBe('50.00');
      expect(res.body.summary.totalRefunded).toBe('10.00');
      expect(res.body.summary.netRevenue).toBe('40.00');
      expect(res.body.summary.paymentCount).toBeGreaterThanOrEqual(1);
    });
    it('revenue grouped', async () => {
      const res = await request(app).get('/api/v1/analytics/revenue?groupBy=day').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
    it('revenue date range filtering', async () => {
      const res = await request(app).get('/api/v1/analytics/revenue?from=2026-08-10&to=2026-08-10').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.grossRevenue).toBe('50.00');
    });
    it('invalid date range ->400', async () => {
      const res = await request(app).get('/api/v1/analytics/revenue?from=2026-08-20&to=2026-08-10').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
  });

  describe('Redis caching', () => {
    it('cache miss then hit via service', async () => {
      const fake = new FakeRedis(); const cache=new CacheService(fake); const svc=new AnalyticsService({cacheService:cache});
      const keyParams={from:'2026-08-01',to:'2026-08-31',groupBy:'day',page:1,limit:20};
      const first=await svc.getSales(tenantAId,keyParams);
      expect(first.cacheHit).toBe(false);
      const second=await svc.getSales(tenantAId,keyParams);
      expect(second.cacheHit).toBe(true);
      expect(second.data.summary.totalSales).toBe(first.data.summary.totalSales);
    });
    it('tenant-specific cache keys isolation', async () => {
      const kA=analyticsKey(tenantAId,'sales',{from:'',to:'',groupBy:'',category:'',product:'',status:'',warehouseId:'',page:'1',limit:'20'});
      const kB=analyticsKey(tenantBId,'sales',{from:'',to:'',groupBy:'',category:'',product:'',status:'',warehouseId:'',page:'1',limit:'20'});
      expect(kA).not.toBe(kB);
      expect(kA).toContain(tenantAId);
      expect(kB).toContain(tenantBId);
    });
    it('Redis failure fallback', async () => {
      const fake=new FakeRedis(); const cache=new CacheService(fake); const svc=new AnalyticsService({cacheService:cache});
      fake.simulateFailure('get');
      const res=await svc.getOverview(tenantAId,{});
      expect(res.data.orders).toBeDefined();
      expect(res.cacheHit).toBe(false);
      fake.simulateFailure('set');
      const res2=await svc.getOverview(tenantAId,{});
      expect(res2.data.orders).toBeDefined();
    });
    it('analytics cache keys use TTL and are tenant-safe', async () => {
      expect(CACHE_TTL.ANALYTICS_OVERVIEW).toBeGreaterThan(0);
      expect(CACHE_TTL.ANALYTICS_OVERVIEW).toBeLessThan(600);
      const key=analyticsKey(tenantAId,'overview',{from:'',to:'',groupBy:'',category:'',product:'',status:'',warehouseId:'',page:'1',limit:'20'});
      expect(key).not.toMatch(/password|token|secret/i);
    });
  });

  describe('Repository error handling', () => {
    it('repository failure propagates safely', async () => {
      const fake=new FakeRedis(); const cache=new CacheService(fake);
      const svc=new AnalyticsService({cacheService:cache});
      // mock repository to throw
      svc.repository.getOverview = async () => { throw new Error('DB failure'); };
      await expect(svc.getOverview(tenantAId,{})).rejects.toThrow('DB failure');
    });
  });

  describe('Aggregation correctness', () => {
    it('order totals aggregated correctly', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?from=2026-08-10&to=2026-08-10').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.summary.totalSales).toBe('50.00');
      const res2 = await request(app).get('/api/v1/analytics/sales?from=2026-08-11&to=2026-08-11').set('Authorization', `Bearer ${tokenA}`);
      expect(res2.body.summary.totalSales).toBe('60.00');
    });
    it('inventory aggregation correct', async () => {
      const res = await request(app).get('/api/v1/analytics/inventory').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.summary.totalQuantity).toBe(103);
    });
    it('grouping buckets produce correct counts', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?from=2026-08-01&to=2026-08-31&groupBy=day').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      const buckets = res.body.data.map(d=>d.bucket);
      expect(buckets.every((b) => !Number.isNaN(Date.parse(b)))).toBe(true);
      const totalOrders = res.body.data.reduce((sum, b) => sum + (b.orderCount || 0), 0);
      expect(totalOrders).toBeGreaterThanOrEqual(2);
    });
    it('UTC grouping is deterministic (day bucket is UTC midnight)', async () => {
      const res = await request(app).get('/api/v1/analytics/sales?from=2026-08-10&to=2026-08-10&groupBy=day').set('Authorization', `Bearer ${tokenRefund}`);
      // TenantRefund has order at 2026-08-10T23:00:00Z which should bucket to 2026-08-10 UTC, not 2026-08-11
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].bucket).toBe('2026-08-10T00:00:00.000Z');
      expect(res.body.data[0].orderCount).toBe(1);
      // Verify service uses UTC conversion in SQL (code inspection) - must not rely on DB timezone
      const fs = await import('node:fs');
      const repo = fs.readFileSync('src/modules/analytics/analytics.repository.js','utf8');
      // All grouped queries must use explicit UTC conversion
      const utcMatches = (repo.match(/AT TIME ZONE 'UTC'/g) || []).length;
      expect(utcMatches).toBeGreaterThanOrEqual(8);
      expect(repo).toMatch(/date_trunc.*AT TIME ZONE 'UTC'/);
      // Ensure grouping trunc values are allowlisted via GROUP_BY_MAP
      expect(repo).toMatch(/GROUP_BY_MAP/);
    });
    it('UTC week/month grouping buckets are UTC-aligned', async () => {
      const resWeek = await request(app).get('/api/v1/analytics/sales?from=2026-08-01&to=2026-08-31&groupBy=week').set('Authorization', `Bearer ${tokenRefund}`);
      expect(resWeek.status).toBe(200);
      for (const b of resWeek.body.data) {
        const d = new Date(b.bucket);
        expect(d.getUTCHours()).toBe(0);
        expect(d.getUTCMinutes()).toBe(0);
      }
      const resMonth = await request(app).get('/api/v1/analytics/sales?from=2026-08-01&to=2026-09-30&groupBy=month').set('Authorization', `Bearer ${tokenRefund}`);
      expect(resMonth.status).toBe(200);
      for (const b of resMonth.body.data) {
        const d = new Date(b.bucket);
        expect(d.getUTCDate()).toBe(1);
        expect(d.getUTCHours()).toBe(0);
      }
    });
  });

  describe('Revenue / Refund Date Semantics (deterministic)', () => {
    it('payment inside range counted, outside not', async () => {
      const inside = await request(app).get('/api/v1/analytics/revenue?from=2026-08-15&to=2026-08-15').set('Authorization', `Bearer ${tokenRefund}`);
      expect(inside.body.summary.grossRevenue).toBe('100.00');
      const outside = await request(app).get('/api/v1/analytics/revenue?from=2026-07-01&to=2026-07-01').set('Authorization', `Bearer ${tokenRefund}`);
      expect(outside.body.summary.grossRevenue).toBe('50.00');
      const none = await request(app).get('/api/v1/analytics/revenue?from=2026-06-01&to=2026-06-30').set('Authorization', `Bearer ${tokenRefund}`);
      expect(none.body.summary.grossRevenue).toBe('0.00');
    });
    it('refund inside range counted, outside not', async () => {
      // No refunds on 2026-08-15, but refund on 2026-08-16 and 2026-08-18 inside August
      const aug = await request(app).get('/api/v1/analytics/revenue?from=2026-08-01&to=2026-08-31').set('Authorization', `Bearer ${tokenRefund}`);
      // gross 100 (only Aug15 payment) + pending 25+30+30 not counted as COMPLETED, so gross 100, refunds 10+7=17 inside Aug, 5 outside July
      expect(aug.body.summary.grossRevenue).toBe('100.00');
      expect(aug.body.summary.totalRefunded).toBe('17.00');
      expect(aug.body.summary.netRevenue).toBe('83.00');
      const july = await request(app).get('/api/v1/analytics/revenue?from=2026-07-01&to=2026-07-31').set('Authorization', `Bearer ${tokenRefund}`);
      expect(july.body.summary.grossRevenue).toBe('50.00');
      expect(july.body.summary.totalRefunded).toBe('5.00');
      expect(july.body.summary.netRevenue).toBe('45.00');
    });
    it('refund associated with payment from different range counts by refund timestamp', async () => {
      // PayOutside is 2026-07-01, but its refund Cross is 2026-08-18 -> querying August should include Cross refund even though payment is July
      const res = await request(app).get('/api/v1/analytics/revenue?from=2026-08-18&to=2026-08-18').set('Authorization', `Bearer ${tokenRefund}`);
      expect(res.body.summary.grossRevenue).toBe('0.00');
      expect(res.body.summary.totalRefunded).toBe('7.00');
      expect(res.body.summary.netRevenue).toBe('-7.00');
    });
    it('refund date semantics tenant isolated', async () => {
      const ra = await request(app).get('/api/v1/analytics/revenue?from=2026-08-01&to=2026-08-31').set('Authorization', `Bearer ${tokenA}`);
      const rr = await request(app).get('/api/v1/analytics/revenue?from=2026-08-01&to=2026-08-31').set('Authorization', `Bearer ${tokenRefund}`);
      expect(ra.body.summary.totalRefunded).not.toBe(rr.body.summary.totalRefunded);
      expect(ra.body.summary.grossRevenue).not.toBe(rr.body.summary.grossRevenue);
    });
    it('netRevenue = gross - refunds', async () => {
      const res = await request(app).get('/api/v1/analytics/revenue').set('Authorization', `Bearer ${tokenRefund}`);
      const gross = parseFloat(res.body.summary.grossRevenue);
      const refund = parseFloat(res.body.summary.totalRefunded);
      const net = parseFloat(res.body.summary.netRevenue);
      expect(net).toBeCloseTo(gross - refund, 2);
      // Without range, total: gross 150 (100+50), refunds 22 (10+5+7), net 128
      expect(res.body.summary.grossRevenue).toBe('150.00');
      expect(res.body.summary.totalRefunded).toBe('22.00');
      expect(res.body.summary.netRevenue).toBe('128.00');
    });
    it('overview revenue respects same refund date filtering', async () => {
      const aug = await request(app).get('/api/v1/analytics/overview?from=2026-08-01&to=2026-08-31').set('Authorization', `Bearer ${tokenRefund}`);
      expect(aug.body.data.revenue.completedRevenue).toBe('100.00');
      expect(aug.body.data.revenue.totalRefunded).toBe('17.00');
      expect(aug.body.data.revenue.netRevenue).toBe('83.00');
      const july = await request(app).get('/api/v1/analytics/overview?from=2026-07-01&to=2026-07-31').set('Authorization', `Bearer ${tokenRefund}`);
      expect(july.body.data.revenue.completedRevenue).toBe('50.00');
      expect(july.body.data.revenue.totalRefunded).toBe('5.00');
    });
  });
});
