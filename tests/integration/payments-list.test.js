import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'PayList#Pass123';

let platformAdmin;
const tenants = {};
let orderId;
let paymentId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function createTenant(label) {
  const email = `paylist-${label}-${RUN}@test.local`;
  const created = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Pay list ${label}`, slug: `paylist-${label}-${RUN}`, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: label } });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { id: created.body.data.tenant.id, token: login.body.data.accessToken };
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `paylist_${RUN}` });
  tenants.a = await createTenant('a');
  tenants.b = await createTenant('b');

  const auth = bearer(tenants.a.token);
  const warehouse = await request(app).post('/api/v1/warehouses').set(auth).send({ name: 'Main', code: 'MAIN' });
  const product = await request(app).post('/api/v1/products').set(auth).send({ name: 'Mug', status: 'ACTIVE', basePrice: '12.00' });
  const variant = await request(app).post(`/api/v1/products/${product.body.data.id}/variants`).set(auth).send({ sku: `MUG-${RUN}`, price: '12.00', status: 'ACTIVE' });
  await request(app).post('/api/v1/inventory/adjust').set(auth).send({ variantId: variant.body.data.id, warehouseId: warehouse.body.data.id, quantityChanged: 10 });
  const customer = await request(app).post('/api/v1/customers').set(auth).send({ email: `buyer-${RUN}@example.com`, firstName: 'Bea', lastName: 'Buyer' });
  const order = await request(app).post('/api/v1/orders').set(auth).send({
    customerId: customer.body.data.id,
    items: [{ productVariantId: variant.body.data.id, warehouseId: warehouse.body.data.id, quantity: 2 }],
  });
  orderId = order.body.data.id;
  const payment = await request(app).post('/api/v1/payments/create').set(auth).send({ orderId });
  paymentId = payment.body.data.id;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: [tenants.a?.id, tenants.b?.id].filter(Boolean) } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('GET /api/v1/payments', () => {
  it('lists payments with an order and customer summary', async () => {
    const res = await request(app).get('/api/v1/payments').set(bearer(tenants.a.token));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 });
    expect(res.body.data[0]).toMatchObject({
      id: paymentId,
      status: 'PENDING',
      order: { id: orderId, customer: { email: `buyer-${RUN}@example.com` } },
      refunds: [],
    });
  });

  it('filters by status and order and validates the status', async () => {
    const completed = await request(app).get('/api/v1/payments?status=COMPLETED').set(bearer(tenants.a.token));
    expect(completed.body.data).toEqual([]);

    const byOrder = await request(app).get(`/api/v1/payments?orderId=${orderId}`).set(bearer(tenants.a.token));
    expect(byOrder.body.data.map((p) => p.id)).toEqual([paymentId]);

    const invalid = await request(app).get('/api/v1/payments?status=BOGUS').set(bearer(tenants.a.token));
    expect(invalid.status).toBe(400);
  });

  it('isolates payments between tenants', async () => {
    const res = await request(app).get('/api/v1/payments').set(bearer(tenants.b.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/payments');
    expect(res.status).toBe(401);
  });
});
