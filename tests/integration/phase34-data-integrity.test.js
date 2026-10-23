import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { LocalStorageProvider, storageSigningSecret } from '../../src/common/storage/local-storage.provider.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase34#Pass123';

let platformAdmin;
let tenantA;
let tenantB;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function createTenant(label) {
  const res = await request(app).post('/api/v1/platform/tenants').set(bearer(platformAdmin.token)).send({
    name: `Phase 34 ${label}`, slug: `phase34-${label}-${RUN}`, status: 'ACTIVE',
    admin: { email: `p34-${label}-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: label },
  });
  const login = await request(app).post('/api/v1/auth/login').send({ email: `p34-${label}-${RUN}@test.local`, password: PASSWORD });
  return { id: res.body.data.tenant.id, token: login.body.data.accessToken };
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p34_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
});

afterAll(async () => {
  const ids = [tenantA?.id, tenantB?.id].filter(Boolean);
  await prisma.order.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 34 — test database isolation', () => {
  it('runs on a *_test database, never the development one', () => {
    const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
    expect(name).toMatch(/_test$/);
  });
});

describe('Phase 34 — soft-deleted customer emails', () => {
  it('two active customers still cannot share an email; a deleted one frees it', async () => {
    const email = `reuse-${RUN}@shop.test`;
    const first = await prisma.customer.create({ data: { tenantId: tenantA.id, email, firstName: 'A', lastName: 'One' } });
    await expect(prisma.customer.create({ data: { tenantId: tenantA.id, email, firstName: 'B', lastName: 'Two' } })).rejects.toMatchObject({ code: 'P2002' });
    await prisma.customer.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const second = await prisma.customer.create({ data: { tenantId: tenantA.id, email, firstName: 'B', lastName: 'Two' } });
    expect(second.id).not.toBe(first.id);
  });
});

describe('Phase 34 — cross-tenant references are refused by the database', () => {
  let customerA;

  beforeAll(async () => {
    customerA = await prisma.customer.create({ data: { tenantId: tenantA.id, email: `xt-${RUN}@shop.test`, firstName: 'X', lastName: 'T' } });
  });

  it('rejects an order of tenant B pointing at a customer of tenant A', async () => {
    await expect(prisma.order.create({ data: { tenantId: tenantB.id, customerId: customerA.id, subtotal: '1.00', total: '1.00' } }))
      .rejects.toThrow(/cross-tenant reference: orders\.customer_id/);
  });

  it('rejects other relations too (address, cart, variant → product)', async () => {
    await expect(prisma.customerAddress.create({ data: { tenantId: tenantB.id, customerId: customerA.id, type: 'SHIPPING', line1: 'x', city: 'y', country: 'IN' } }))
      .rejects.toThrow(/cross-tenant/);
    const productA = await prisma.product.create({ data: { tenantId: tenantA.id, name: `XT ${RUN}` } });
    await expect(prisma.productVariant.create({ data: { tenantId: tenantB.id, productId: productA.id, sku: `XT-${RUN}`, price: '1.00' } }))
      .rejects.toThrow(/cross-tenant reference: product_variants\.product_id/);
  });

  it('rejects moving a child row to another tenant, and allows same-tenant writes', async () => {
    const order = await prisma.order.create({ data: { tenantId: tenantA.id, customerId: customerA.id, subtotal: '1.00', total: '1.00' } });
    await expect(prisma.order.update({ where: { id: order.id }, data: { tenantId: tenantB.id } })).rejects.toThrow(/cross-tenant/);
    await expect(prisma.order.update({ where: { id: order.id }, data: { status: 'PENDING' } })).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('still lets platform admins appear in a tenant’s audit log (deliberately unguarded)', async () => {
    await expect(prisma.auditLog.create({ data: { tenantId: tenantA.id, userId: platformAdmin.userId, action: 'LOGIN', resource: 'support_session' } })).resolves.toBeDefined();
  });
});

describe('Phase 34 — storage signing secret', () => {
  it('signed URLs are not signed with the JWT secret', async () => {
    expect(storageSigningSecret()).not.toBe(env.JWT_ACCESS_SECRET);
    const provider = new LocalStorageProvider();
    const key = `tenants/${tenantA.id}/reports/x.csv`;
    const url = new URL(await provider.getSignedUrl(key, 60), 'http://local');
    const expires = url.searchParams.get('expires');
    expect(LocalStorageProvider.verifySignedUrl(key, expires, url.searchParams.get('signature'))).toBe(true);
    const forged = crypto.createHmac('sha256', env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing').update(`${key}:${expires}`).digest('hex');
    expect(LocalStorageProvider.verifySignedUrl(key, expires, forged)).toBe(false);
  });

  const loadEnv = (vars) => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com', DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), ...vars },
    stdio: 'pipe',
  });

  it('is required in production and must differ from the JWT secret', () => {
    expect(() => loadEnv({})).toThrow(/STORAGE_SIGNING_SECRET/);
    expect(() => loadEnv({ STORAGE_SIGNING_SECRET: 'a'.repeat(40) })).toThrow(/must differ/);
    expect(() => loadEnv({ STORAGE_SIGNING_SECRET: 'c'.repeat(40) })).not.toThrow();
  });
});

describe('Phase 34 — conflicts are 409', () => {
  it('a business-rule conflict answers 409 with its code', async () => {
    const category = (await request(app).post('/api/v1/categories').set(bearer(tenantA.token)).send({ name: 'Parent', slug: `parent-${RUN}` })).body.data;
    await request(app).post('/api/v1/categories').set(bearer(tenantA.token)).send({ name: 'Child', slug: `child-${RUN}`, parentId: category.id });
    const res = await request(app).delete(`/api/v1/categories/${category.id}`).set(bearer(tenantA.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATEGORY_HAS_CHILDREN');
  });
});
