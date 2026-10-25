import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { gstCents } from '../../src/modules/orders/gst.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase37#Pass123';
const SHOPPER_PASSWORD = 'Shopper37#Pass123';

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(token ? bearer(token) : {}).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
};

let platformAdmin;
let tenant;
let token;
let customerId;
let variantId;
let warehouseId;

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p37_${RUN}` });
  const email = `p37-admin-${RUN}@test.local`;
  const created = await api.post('/platform/tenants', platformAdmin.token, {
    name: 'Phase 37', slug: `phase37-${RUN}`, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' },
  });
  tenant = created.body.data.tenant;
  token = (await api.post('/auth/login', null, { email, password: PASSWORD })).body.data.accessToken;

  warehouseId = (await api.post('/warehouses', token, { name: 'Main', code: 'MAIN' })).body.data.id;
  const product = (await api.post('/products', token, { name: 'Kettle', status: 'ACTIVE', basePrice: '59.00' })).body.data;
  variantId = (await api.post(`/products/${product.id}/variants`, token, { sku: `KET-${RUN}`, price: '59.00', status: 'ACTIVE' })).body.data.id;
  await api.post('/inventory/adjust', token, { variantId, warehouseId, quantityChanged: 50 });
  customerId = (await api.post('/customers', token, { email: `buyer-${RUN}@example.com`, firstName: 'Bea', lastName: 'Buyer' })).body.data.id;
});

afterAll(async () => {
  if (tenant?.id) await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 37 — GST arithmetic', () => {
  it('rounds GST half-up to the paisa and ignores non-positive amounts', () => {
    expect(gstCents(11800, 18)).toBe(2124); // ₹118.00 × 18% = ₹21.24
    expect(gstCents(1, 18)).toBe(0); // 0.18 paise rounds down
    expect(gstCents(3, 18)).toBe(1); // 0.54 paise rounds up
    expect(gstCents(10000, 12.5)).toBe(1250);
    expect(gstCents(0, 18)).toBe(0);
    expect(gstCents(10000, 0)).toBe(0);
  });
});

describe('Phase 37 — rupees by default', () => {
  it('orders default to INR when the workspace has no currency', async () => {
    const order = await api.post('/orders', token, { customerId, items: [{ productVariantId: variantId, warehouseId, quantity: 1 }] });
    expect(order.status).toBe(201);
    expect(order.body.data.currency).toBe('INR');
  });

  it('the public store reports INR and its GST rate', async () => {
    const store = await api.get(`/storefront/${tenant.slug}`);
    expect(store.status).toBe(200);
    expect(store.body.data).toMatchObject({ currency: 'INR', gstRatePercent: 0 });
  });
});

describe('Phase 37 — GST on orders', () => {
  beforeAll(async () => {
    const res = await api.patch('/workspace/settings', token, { gstRatePercent: 18 });
    expect(res.status).toBe(200);
    expect(res.body.data.gstRatePercent).toBe(18);
  });

  it('adds 18% GST per line on the value after discount and records the rate', async () => {
    const res = await api.post('/orders', token, {
      customerId,
      items: [{ productVariantId: variantId, warehouseId, quantity: 2, discount: '10.00' }],
      shippingTotal: '40.00',
    });
    expect(res.status).toBe(201);
    // 2 × 59 = 118, minus 10 = 108 taxable → GST 19.44; total 118 − 10 + 19.44 + 40
    expect(res.body.data).toMatchObject({ subtotal: '118', discountTotal: '10', taxTotal: '19.44', total: '167.44' });
    expect(res.body.data.items[0]).toMatchObject({ tax: '19.44', lineTotal: '127.44' });
    expect(res.body.data.metadata.gstRatePercent).toBe(18);
  });

  it('keeps an explicit per-line tax instead of GST', async () => {
    const res = await api.post('/orders', token, { customerId, items: [{ productVariantId: variantId, warehouseId, quantity: 1, tax: '0' }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ taxTotal: '0', total: '59' });
  });

  it('charges the GST-inclusive total on payment', async () => {
    const order = (await api.post('/orders', token, { customerId, items: [{ productVariantId: variantId, warehouseId, quantity: 1 }] })).body.data;
    expect(order.total).toBe('69.62'); // 59 + 10.62
    const payment = await api.post('/payments/create', token, { orderId: order.id });
    expect(payment.status).toBe(201);
    expect(payment.body.data.amount).toBe('69.62');
  });

  it('applies GST at storefront checkout', async () => {
    const shop = `/storefront/${tenant.slug}`;
    const email = `shopper-${RUN}@example.com`;
    const reg = await api.post(`${shop}/auth/register`, null, { email, firstName: 'Sam', lastName: 'Shopper' });
    const set = await api.post(`${shop}/auth/set-password`, null, { token: reg.body.data.devToken, password: SHOPPER_PASSWORD });
    const shopper = set.body.data.accessToken;

    expect((await api.get(shop)).body.data.gstRatePercent).toBe(18);
    await api.put(`${shop}/cart/items/${variantId}`, shopper, { quantity: 2 });
    const checkout = await api.post(`${shop}/checkout`, shopper, {});
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.order).toMatchObject({ currency: 'INR', subtotal: '118.00', taxTotal: '21.24', total: '139.24' });
  });

  it('rejects rates outside 0–100 or with more than two decimals, and clears with null', async () => {
    expect((await api.patch('/workspace/settings', token, { gstRatePercent: 101 })).status).toBe(400);
    expect((await api.patch('/workspace/settings', token, { gstRatePercent: 12.345 })).status).toBe(400);
    expect((await api.patch('/workspace/settings', token, { gstRatePercent: '18' })).status).toBe(400);
    const cleared = await api.patch('/workspace/settings', token, { gstRatePercent: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.gstRatePercent).toBeNull();
    await api.patch('/workspace/settings', token, { gstRatePercent: 18 });
  });
});

describe('Phase 37 — single sign-in form', () => {
  it('signs a business user into their workspace from email and password alone', async () => {
    const res = await api.post('/auth/login', null, { email: `p37-admin-${RUN}@test.local`, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.tenantId).toBe(tenant.id);
  });

  it('only tells someone with the right password that an account is a platform account', async () => {
    const wrong = await api.post('/auth/login', null, { email: platformAdmin.email, password: 'Wrong#Pass123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const right = await api.post('/auth/login', null, { email: platformAdmin.email, password: platformAdmin.password });
    expect(right.status).toBe(403);
    expect(right.body.error.code).toBe('USE_PLATFORM_LOGIN');

    const platform = await api.post('/auth/login', null, { email: platformAdmin.email, password: platformAdmin.password, scope: 'platform' });
    expect(platform.status).toBe(200);
  });
});
