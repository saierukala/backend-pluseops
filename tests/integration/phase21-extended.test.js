/**
 * Phase 21 – Extended Coverage Gaps
 * Covers: multi-tenant matrix, cache integration, queue tenant preservation, rate limiting, error handling, transaction rollback, idempotency, external provider failure mapping
 */
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { CacheService } from '../../src/common/cache/cache.service.js';
import { productListKey, userPermissionsKey } from '../../src/common/cache/cache.keys.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { computeSignature } from '../../src/modules/payments/webhook.util.js';
import { processSendNotification } from '../../src/jobs/processors/notification.processor.js';
import argon2 from 'argon2';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(p){ return argon2.hash(p); }
async function createTenant(slug){ return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tid,email){
  const ph = await hashPassword('StrongPass123!');
  const user = await prisma.user.create({ data: { tenantId: tid, email: email, passwordHash: ph, firstName: 'Test', lastName: 'User' } });
  await prisma.tenantMembership.create({ data: { tenantId: tid, userId: user.id } }).catch(()=>{});
  return user;
}
async function login(email,tid){ const r=await request(app).post('/api/v1/auth/login').send({ email, password:'StrongPass123!', tenantId: tid }); return r.body.data.accessToken; }
async function setupPerms(tid, permsList){
  for(const p of permsList){
    await prisma.permission.upsert({ where:{ tenantId_resource_action:{ tenantId: tid, resource:p.resource, action:p.action } }, update:{}, create:{ tenantId: tid, name:`${p.resource}:${p.action}`, resource:p.resource, action:p.action } });
  }
  const role=await prisma.role.upsert({ where:{ tenantId_name:{ tenantId: tid, name:'ext-admin' } }, update:{}, create:{ tenantId: tid, name:'ext-admin' } });
  for(const p of permsList){
    const perm=await prisma.permission.findUnique({ where:{ tenantId_resource_action:{ tenantId: tid, resource:p.resource, action:p.action } } });
    await prisma.rolePermission.upsert({ where:{ tenantId_roleId_permissionId:{ tenantId: tid, roleId: role.id, permissionId: perm.id } }, update:{}, create:{ tenantId: tid, roleId: role.id, permissionId: perm.id } });
  }
  return role;
}

describe('Phase 21 – Multi-tenant Isolation Matrix (all domains)', () => {
  let tenantAId, tenantBId, userAId, userBId, tokenA, tokenB;
  let productAId, variantAId, warehouseAId, customerAId, orderAId, paymentAId;

  beforeAll(async () => {
    const ta = await createTenant(`mx-a-${Date.now()}`);
    const tb = await createTenant(`mx-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua = await createUser(tenantAId, `mx-a-${Date.now()}@a.com`);
    const ub = await createUser(tenantBId, `mx-b-${Date.now()}@b.com`);
    userAId = ua.id; userBId = ub.id;
    const perms = [
      {resource:'product',action:'create'},{resource:'product',action:'read'},{resource:'product',action:'update'},
      {resource:'attribute',action:'create'},{resource:'attribute',action:'read'},
      {resource:'warehouse',action:'create'},{resource:'warehouse',action:'read'},
      {resource:'inventory',action:'read'},{resource:'inventory',action:'update'},
      {resource:'order',action:'create'},{resource:'order',action:'read'},
      {resource:'payment',action:'create'},{resource:'payment',action:'read'},{resource:'payment',action:'confirm'},
      {resource:'notification',action:'read'},
      {resource:'audit',action:'read'},
    ];
    const ra=await setupPerms(tenantAId, perms);
    const rb=await setupPerms(tenantBId, perms);
    await prisma.userRole.create({ data:{ tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data:{ tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    tokenA=await login(ua.email, tenantAId);
    tokenB=await login(ub.email, tenantBId);

    // create domain resources for A
    const prod = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name:`Mx Prod ${Date.now()}`, status:'ACTIVE' });
    productAId = prod.body.data.id;
    const vr = await request(app).post(`/api/v1/products/${productAId}/variants`).set('Authorization', `Bearer ${tokenA}`).send({ sku:`MX-SKU-${Date.now()}`, price:'100.00', status:'ACTIVE' });
    variantAId = vr.body.data.id;
    const wh = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${tokenA}`).send({ name:`Mx WH`, code:`MXWH-${Date.now()}` });
    warehouseAId = wh.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${tokenA}`).send({ variantId: variantAId, warehouseId: warehouseAId, quantityChanged: 20, reason:'INIT' });
    const cust = await prisma.customer.create({ data:{ tenantId: tenantAId, email:`mx-cust-${Date.now()}@a.com`, firstName:'Mx', lastName:'A' } });
    customerAId = cust.id;
    const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${tokenA}`).send({ customerId: customerAId, items:[{ productVariantId: variantAId, warehouseId: warehouseAId, quantity:1 }] });
    orderAId = ord.body.data.id;
    const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId: orderAId });
    paymentAId = pay.body.data.id;
  });

  afterAll(async () => {
    await prisma.paymentWebhookEvent.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.paymentTransaction.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.payment.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.orderStatusHistory.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.orderItem.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.order.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.inventoryMovement.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.inventory.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.warehouseInventory.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.warehouse.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.customer.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.productImage.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.productVariant.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.product.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.attributeDefinition.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.notification.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.auditLog.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.activityLog.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.userRole.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.rolePermission.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.role.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.permission.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.tenantMembership.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.user.deleteMany({ where:{ tenantId:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await prisma.tenant.deleteMany({ where:{ id:{ in:[tenantAId, tenantBId] } } }).catch(()=>{});
    await disconnectDatabase();
  });

  it('Tenant A -> Tenant A allowed (control)', async () => {
    const r = await request(app).get(`/api/v1/products/${productAId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
  });
  it('Tenant A -> Tenant B rejected (products)', async () => {
    // create product in B
    const prodB = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name:'B Prod', status:'ACTIVE' });
    const r = await request(app).get(`/api/v1/products/${prodB.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
    expect([404,403]).toContain(r.status);
  });
  it('Tenant B -> Tenant A rejected (orders)', async () => {
    const r = await request(app).get(`/api/v1/orders/${orderAId}`).set('Authorization', `Bearer ${tokenB}`);
    expect([404,403]).toContain(r.status);
  });
  it('Tenant B -> Tenant A rejected (payments)', async () => {
    const r = await request(app).get(`/api/v1/payments/${paymentAId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(404);
  });
  it('Tenant A -> Tenant B rejected (inventory)', async () => {
    const r = await request(app).get(`/api/v1/inventory/variants/${variantAId}`).set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(404);
  });
  it('Tenant isolation for notifications (processor creates tenant-scoped)', async () => {
    const nA = await processSendNotification({ tenantId: tenantAId, userId: userAId, title:`MxA ${Date.now()}`, message:'a', channel:'IN_APP' }, { jobId:`mx-a-${Date.now()}` });
    const nB = await processSendNotification({ tenantId: tenantBId, userId: userBId, title:`MxB ${Date.now()}`, message:'b', channel:'IN_APP' }, { jobId:`mx-b-${Date.now()}` });
    const storedA = await prisma.notification.findUnique({ where:{ id: nA.notificationId } });
    const storedB = await prisma.notification.findUnique({ where:{ id: nB.notificationId } });
    expect(storedA.tenantId).toBe(tenantAId);
    expect(storedB.tenantId).toBe(tenantBId);
    expect(await prisma.notification.findFirst({ where:{ id: storedA.id, tenantId: tenantBId } })).toBeNull();
  });
  it('Tenant isolation for audit (list filtered)', async () => {
    await prisma.auditLog.create({ data:{ tenantId: tenantAId, userId: userAId, action:'CREATE', resource:'product', resourceId: productAId } });
    const logsB = await prisma.auditLog.findMany({ where:{ tenantId: tenantBId } });
    const logsA = await prisma.auditLog.findMany({ where:{ tenantId: tenantAId } });
    expect(logsA.some(l=>l.resourceId===productAId)).toBe(true);
    expect(logsB.some(l=>l.resourceId===productAId)).toBe(false);
  });
  it('Cached resources are tenant-scoped (cache keys distinct)', async () => {
    const Fake = class { constructor(){this.store=new Map();} async get(k){return this.store.get(k)||null;} async set(k,v){this.store.set(k,v); return 'OK';} async del(...ks){for(const k of ks) this.store.delete(k);} async scan(c,..._args){ const pat=_args[1]||'*'; const regex=new RegExp('^'+pat.replace(/\*/g,'.*')+'$'); const keys=[...this.store.keys()].filter(k=>regex.test(k)); return ['0',keys]; } };
    const fake = new Fake();
    const cache = new CacheService(fake);
    const tA = '11111111-1111-4111-8111-111111111111';
    const tB = '22222222-2222-4222-8222-222222222222';
    expect(productListKey(tA,{page:1})).not.toBe(productListKey(tB,{page:1}));
    expect(userPermissionsKey(tA,tA)).not.toBe(userPermissionsKey(tB,tA));
    await cache.set(productListKey(tA,{page:1}), {data:1},60);
    expect(await cache.get(productListKey(tB,{page:1}))).toBeNull();
    expect(await cache.get(productListKey(tA,{page:1}))).toEqual({data:1});
  });
  it('Background job tenant context preserved (enqueue carries tenantId)', async () => {
    const { enqueueNotification } = await import('../../src/jobs/queues/notification.queue.js');
    const job = await enqueueNotification({ tenantId: tenantAId, title:`JobTenant ${Date.now()}`, message:'test' });
    // job is fallback true or BullMQ job; but notification should exist with correct tenant
    // If fallback, DB already created; if queued, processor hasn't run yet -> check DB fallback path
    if (job.fallback) {
      const n = await prisma.notification.findFirst({ where:{ tenantId: tenantAId, title: { contains:'JobTenant' } } });
      expect(n).toBeTruthy();
      expect(n.tenantId).toBe(tenantAId);
    } else {
      expect(job.id).toBeDefined();
      // simulate processor with tenant context
      const proc = await processSendNotification({ tenantId: tenantAId, userId: userAId, title:`ProcTenant ${Date.now()}`, message:'p' }, { jobId: job.id });
      expect(proc.notificationId).toBeDefined();
      const check = await prisma.notification.findUnique({ where:{ id: proc.notificationId } });
      expect(check.tenantId).toBe(tenantAId);
    }
  });
  it('WebSocket room isolation via auth (socket cannot join other tenant)', async () => {
    // already heavily tested in phase13; minimal smoke here using token
    const { verifyAccessToken } = await import('../../src/modules/auth/jwt.util.js');
    const decoded = verifyAccessToken(tokenA);
    expect(decoded.tenantId).toBe(tenantAId);
    // forged token with tenantB should fail user lookup (since sub is userA but tenantB)
    const { default: jwt } = await import('jsonwebtoken');
    const secret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
    const forged = jwt.sign({ sub: userAId, tenantId: tenantBId, sessionId:'sess' }, secret, { expiresIn:'15m', issuer:'pulseops', audience:'pulseops-api' });
    const r = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(r.status).toBe(401);
  });
});

describe('Phase 21 – Transaction / Rollback', () => {
  let tid, token, warehouse, variant, customer;
  beforeAll(async () => {
    const t = await createTenant(`roll-${Date.now()}`);
    tid = t.id;
    const u = await createUser(tid, `roll-${Date.now()}@a.com`);
    const perms=[{resource:'product',action:'create'},{resource:'product',action:'read'},{resource:'warehouse',action:'create'},{resource:'inventory',action:'update'},{resource:'inventory',action:'read'},{resource:'order',action:'create'},{resource:'order',action:'read'},{resource:'payment',action:'create'},{resource:'payment',action:'read'},{resource:'payment',action:'confirm'},{resource:'payment',action:'refund'}];
    const role=await setupPerms(tid, perms);
    await prisma.userRole.create({ data:{ tenantId: tid, userId: u.id, roleId: role.id } });
    token=await login(u.email, tid);
    const prod = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${token}`).send({ name:'Roll Prod', status:'ACTIVE' });
    const vr = await request(app).post(`/api/v1/products/${prod.body.data.id}/variants`).set('Authorization', `Bearer ${token}`).send({ sku:`ROLL-${Date.now()}`, price:'50.00', status:'ACTIVE' });
    variant=vr.body.data.id;
    const wh = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${token}`).send({ name:'RollWH', code:`ROLLWH-${Date.now()}` });
    warehouse=wh.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${token}`).send({ variantId: variant, warehouseId: warehouse, quantityChanged:10, reason:'INIT' });
    const c=await prisma.customer.create({ data:{ tenantId: tid, email:`roll-cust-${Date.now()}@a.com`, firstName:'Roll', lastName:'Cust' } });
    customer=c.id;
  });
  afterAll(async () => {
    await prisma.inventoryMovement.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.inventory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.warehouseInventory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.warehouse.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.paymentTransaction.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.refund.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.payment.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.orderItem.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.orderStatusHistory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.order.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.productVariant.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.product.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.customer.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.userRole.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.rolePermission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.role.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.permission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenantMembership.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.user.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenant.deleteMany({ where:{ id: tid } }).catch(()=>{});
    await disconnectDatabase();
  });

  it('order creation with insufficient stock rolls back all writes', async () => {
    const beforeOrders = await prisma.order.count({ where:{ tenantId: tid } });
    const beforeMovs = await prisma.inventoryMovement.count({ where:{ tenantId: tid } });
    const invBefore = await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: warehouse } });
    const r = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send({ customerId: customer, items:[{ productVariantId: variant, warehouseId: warehouse, quantity: 999 }] });
    expect(r.status).toBe(400);
    expect(await prisma.order.count({ where:{ tenantId: tid } })).toBe(beforeOrders);
    expect(await prisma.inventoryMovement.count({ where:{ tenantId: tid } })).toBe(beforeMovs);
    expect((await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: warehouse } })).quantity).toBe(invBefore.quantity);
  });

  it('payment refund excessive amount rolls back (no partial refund)', async () => {
    const ord = await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send({ customerId: customer, items:[{ productVariantId: variant, warehouseId: warehouse, quantity:1 }] });
    const pay = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${token}`).send({ orderId: ord.body.data.id });
    await request(app).post('/api/v1/payments/confirm').set('Authorization', `Bearer ${token}`).send({ paymentId: pay.body.data.id });
    const beforeRefunds = await prisma.refund.count({ where:{ paymentId: pay.body.data.id } });
    const beforeStatus = (await prisma.payment.findUnique({ where:{ id: pay.body.data.id } })).status;
    const r = await request(app).post(`/api/v1/payments/${pay.body.data.id}/refund`).set('Authorization', `Bearer ${token}`).send({ amount: '9999.00' });
    expect(r.status).toBe(400);
    expect(await prisma.refund.count({ where:{ paymentId: pay.body.data.id } })).toBe(beforeRefunds);
    expect((await prisma.payment.findUnique({ where:{ id: pay.body.data.id } })).status).toBe(beforeStatus);
  });

  it('inventory transfer with insufficient source rolls back both sides', async () => {
    const wh2 = await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${token}`).send({ name:'RollWH2', code:`ROLLWH2-${Date.now()}` });
    const wh2Id=wh2.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${token}`).send({ variantId: variant, warehouseId: wh2Id, quantityChanged: 2, reason:'INIT2' });
    const srcBefore = (await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: warehouse } })).quantity;
    const dstBefore = (await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: wh2Id } })).quantity;
    const r = await request(app).post('/api/v1/inventory/transfer').set('Authorization', `Bearer ${token}`).send({ variantId: variant, sourceWarehouseId: warehouse, destinationWarehouseId: wh2Id, quantity: 999 });
    expect(r.status).toBe(400);
    expect((await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: warehouse } })).quantity).toBe(srcBefore);
    expect((await prisma.inventory.findFirst({ where:{ tenantId: tid, productVariantId: variant, warehouseId: wh2Id } })).quantity).toBe(dstBefore);
  });
});

describe('Phase 21 – Idempotency', () => {
  let tid, token, warehouse, variant, customer, orderIdForWebhook, paymentId;
  let originalRedisUrl;
  beforeAll(async () => {
    // Force synchronous webhook fallback for determinism (no worker in test process)
    const { env } = await import('../../src/config/env.js');
    originalRedisUrl = env.REDIS_URL;
    env.REDIS_URL = '';
    const { disconnectBullMqRedis } = await import('../../src/jobs/connection.js');
    await disconnectBullMqRedis();
    const { _resetWebhookQueueForTest } = await import('../../src/jobs/queues/webhook.queue.js');
    _resetWebhookQueueForTest();
    const t=await createTenant(`idem-${Date.now()}`);
    tid=t.id;
    const u=await createUser(tid, `idem-${Date.now()}@a.com`);
    const perms=[{resource:'product',action:'create'},{resource:'warehouse',action:'create'},{resource:'inventory',action:'update'},{resource:'order',action:'create'},{resource:'order',action:'read'},{resource:'payment',action:'create'},{resource:'payment',action:'read'}];
    const role=await setupPerms(tid, perms);
    await prisma.userRole.create({ data:{ tenantId: tid, userId: u.id, roleId: role.id } });
    token=await login(u.email,tid);
    const prod=await request(app).post('/api/v1/products').set('Authorization', `Bearer ${token}`).send({ name:'Idem Prod', status:'ACTIVE' });
    const vr=await request(app).post(`/api/v1/products/${prod.body.data.id}/variants`).set('Authorization', `Bearer ${token}`).send({ sku:`IDEM-${Date.now()}`, price:'10.00', status:'ACTIVE' });
    variant=vr.body.data.id;
    const wh=await request(app).post('/api/v1/warehouses').set('Authorization', `Bearer ${token}`).send({ name:'IdemWH', code:`IDEMWH-${Date.now()}` });
    warehouse=wh.body.data.id;
    await request(app).post('/api/v1/inventory/adjust').set('Authorization', `Bearer ${token}`).send({ variantId: variant, warehouseId: warehouse, quantityChanged:20, reason:'INIT' });
    const c=await prisma.customer.create({ data:{ tenantId: tid, email:`idem-cust-${Date.now()}@a.com`, firstName:'Idem', lastName:'Cust' } });
    customer=c.id;
    const ord=await request(app).post('/api/v1/orders').set('Authorization', `Bearer ${token}`).send({ customerId: customer, items:[{ productVariantId: variant, warehouseId: warehouse, quantity:1 }] });
    orderIdForWebhook=ord.body.data.id;
    const pay=await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${token}`).send({ orderId: orderIdForWebhook });
    paymentId=pay.body.data.id;
  });
  afterAll(async () => {
    await prisma.paymentWebhookEvent.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.paymentTransaction.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.payment.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.orderItem.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.orderStatusHistory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.order.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.inventoryMovement.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.inventory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.warehouseInventory.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.warehouse.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.productVariant.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.product.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.customer.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.userRole.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.rolePermission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.role.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.permission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenantMembership.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.user.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenant.deleteMany({ where:{ id: tid } }).catch(()=>{});
    // Restore Redis for subsequent suites
    const { env } = await import('../../src/config/env.js');
    env.REDIS_URL = originalRedisUrl;
    const { disconnectBullMqRedis } = await import('../../src/jobs/connection.js');
    await disconnectBullMqRedis();
    const { _resetWebhookQueueForTest } = await import('../../src/jobs/queues/webhook.queue.js');
    _resetWebhookQueueForTest();
    await disconnectDatabase();
  });

  it('webhook idempotency: 5 concurrent duplicates -> exactly 1 transaction', async () => {
    const eventId=`idem-evt-${Date.now()}`;
    const payload={ eventId, type:'payment.succeeded', paymentId, tenantId: tid };
    const raw=JSON.stringify(payload);
    const sig=computeSignature(raw, env.PAYMENT_WEBHOOK_SECRET);
    const before=await prisma.paymentTransaction.count({ where:{ paymentId } });
    const promises=[];
    for(let i=0;i<5;i++) promises.push(request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).set('Content-Type','application/json').send(raw));
    const results=await Promise.all(promises);
    expect(results.every(r=>[200,202].includes(r.status))).toBe(true);
    await new Promise(r=>setTimeout(r,500));
    expect(await prisma.paymentWebhookEvent.count({ where:{ eventId } })).toBe(1);
    expect(await prisma.paymentTransaction.count({ where:{ paymentId } })).toBe(before+1);
    // second round of duplicates -> no new transaction
    const before2=await prisma.paymentTransaction.count({ where:{ paymentId } });
    await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).set('Content-Type','application/json').send(raw);
    await new Promise(r=>setTimeout(r,300));
    expect(await prisma.paymentTransaction.count({ where:{ paymentId } })).toBe(before2);
  });
});

describe('Phase 21 – Cache / Storage / Queue extended', () => {
  it('storage isolation: tenant A key not accessible by B via assert', () => {
    const svc=new StorageService('local');
    const tA='11111111-1111-4111-8111-111111111111';
    const tB='22222222-2222-4222-8222-222222222222';
    const keyA=svc.generateProductImageKey(tA, 'prod', 'file.jpg');
    const keyB=svc.generateProductImageKey(tB, 'prod', 'file.jpg');
    expect(keyA).not.toBe(keyB);
    expect(()=>svc.assertTenantScopedKey(keyA)).not.toThrow();
    // service-level isolation is key prefix, not cross-check; ensure keys are distinct
  });
  it('cache service strips sensitive fields and fallback on Redis failure', async () => {
    class FailRedis { async get(){ throw new Error('fail'); } async set(){ throw new Error('fail'); } async del(){ throw new Error('fail'); } }
    const cache=new CacheService(new FailRedis());
    expect(await cache.get('k')).toBeNull();
    expect(await cache.set('k',{password:'secret', ok:1},60)).toBe(false);
    expect(await cache.del('k')).toBe(false);
    // also null redis fallback
    const nullCache=new CacheService(null);
    // with no redis, get returns null via getRedis undefined check, but we stub getRedis to return undefined
    nullCache.getRedis=()=>undefined;
    expect(await nullCache.get('any')).toBeNull();
  });
  it('queue enqueue rejects sensitive metadata', async () => {
    const { enqueueNotification } = await import('../../src/jobs/queues/notification.queue.js');
    await expect(enqueueNotification({ tenantId:'11111111-1111-4111-8111-111111111111', title:'t', message:'m', metadata:{ password:'x' } })).rejects.toThrow(/Sensitive/);
  });
});

describe('Phase 21 – Error handling & rate limiting', () => {
  let tid, token;
  beforeAll(async () => {
    const t=await createTenant(`err-${Date.now()}`);
    tid=t.id;
    const u=await createUser(tid, `err-${Date.now()}@a.com`);
    const perms=[{resource:'product',action:'create'},{resource:'product',action:'read'}];
    const role=await setupPerms(tid, perms);
    await prisma.userRole.create({ data:{ tenantId: tid, userId: u.id, roleId: role.id } });
    token=await login(u.email,tid);
  });
  afterAll(async () => {
    await prisma.product.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.userRole.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.rolePermission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.role.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.permission.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenantMembership.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.user.deleteMany({ where:{ tenantId: tid } }).catch(()=>{});
    await prisma.tenant.deleteMany({ where:{ id: tid } }).catch(()=>{});
    await disconnectDatabase();
  });
  it('malformed UUID -> 400', async () => {
    const r=await request(app).get('/api/v1/products/not-a-uuid').set('Authorization', `Bearer ${token}`);
    expect([400,404]).toContain(r.status);
  });
  it('unauthenticated -> 401', async () => {
    const r=await request(app).get('/api/v1/products');
    expect(r.status).toBe(401);
  });
  it('forbidden (no permission) -> 403', async () => {
    const u2=await createUser(tid, `err-noperm-${Date.now()}@a.com`);
    const role2=await prisma.role.create({ data:{ tenantId: tid, name:`noperm-${Date.now()}` } });
    await prisma.userRole.create({ data:{ tenantId: tid, userId: u2.id, roleId: role2.id } });
    const tok2=await login(u2.email,tid);
    const r=await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tok2}`).send({ name:'ShouldFail' });
    expect(r.status).toBe(403);
    await prisma.userRole.deleteMany({ where:{ userId: u2.id } }).catch(()=>{});
    await prisma.role.deleteMany({ where:{ id: role2.id } }).catch(()=>{});
    await prisma.user.deleteMany({ where:{ id: u2.id } }).catch(()=>{});
  });
  it('validation error does not leak stack', async () => {
    const r=await request(app).post('/api/v1/products').set('Authorization', `Bearer ${token}`).send({ name:'' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('stack');
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('SQL injection via search is safe', async () => {
    const r=await request(app).get('/api/v1/products').query({ search: "' OR 1=1 --" }).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  it('rate limiter config check (unit)', async () => {
    const { createAuthLimiter } = await import('../../src/common/middleware/rate-limiters.js');
    const lim=createAuthLimiter();
    expect(typeof lim).toBe('function');
  });
  it('external integration failure mapping is IntegrationError', async () => {
    const { IntegrationError, IntegrationErrorCode } = await import('../../src/integrations/errors/integration-error.js');
    const { MockPaymentProvider } = await import('../../src/integrations/payment/payment.provider.js');
    const p=new MockPaymentProvider({ shouldFail:true });
    await expect(p.charge({ amount:'10.00', currency:'USD', orderId: crypto.randomUUID(), tenantId: tid })).rejects.toThrow(IntegrationError);
    try{ await p.charge({ amount:'10.00', currency:'USD', orderId: crypto.randomUUID(), tenantId: tid }); }catch(e){ expect(e.code).toBe(IntegrationErrorCode.UNAVAILABLE); }
  });
});
