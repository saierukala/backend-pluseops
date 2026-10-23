import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase29#Pass123';

let platformAdmin;
let tenantA;
let tenantB;
let A;
let B;
let noRole;
let variantId;
let warehouseId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

const shipping = { type: 'SHIPPING', line1: '1 Main St', city: 'Hyderabad', postalCode: '500001', country: 'in' };
const billing = { type: 'BILLING', line1: '9 Ledger Rd', city: 'Pune', country: 'IN', company: 'Acme' };

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

async function createTenant(label) {
  const res = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Phase 29 ${label}`, slug: `phase29-${label}-${RUN}`, status: 'ACTIVE', admin: { email: `p29-${label}-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: label } });
  return { id: res.body.data.tenant.id, token: await login(`p29-${label}-${RUN}@test.local`) };
}

async function newCustomer(label, extra = {}) {
  const res = await api.post('/customers', A, { email: `${label}-${RUN}@shop.test`, firstName: 'Bea', lastName: label, ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}

function order(customerId, extra = {}) {
  return api.post('/orders', A, { customerId, items: [{ productVariantId: variantId, warehouseId, quantity: 1 }], ...extra });
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p29_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  A = tenantA.token;
  B = tenantB.token;

  const staffEmail = `p29-staff-${RUN}@test.local`;
  await request(app).post('/api/v1/auth/register').send({ email: staffEmail, password: PASSWORD, firstName: 'No', lastName: 'Role', tenantId: tenantA.id });
  noRole = await login(staffEmail);

  warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: `P29-${RUN}` })).body.data.id;
  const productId = (await api.post('/products', A, { name: `P29 product ${RUN}`, status: 'ACTIVE' })).body.data.id;
  variantId = (await api.post(`/products/${productId}/variants`, A, { sku: `P29-${RUN}`, price: '10.00', status: 'ACTIVE' })).body.data.id;
  await api.post('/inventory/adjust', A, { variantId, warehouseId, quantityChanged: 100, reason: 'INIT' });
});

afterAll(async () => {
  const tenantIds = [tenantA?.id, tenantB?.id].filter(Boolean);
  // Orders restrict customer/variant deletes, so remove them before the tenant cascade.
  await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 29 — customers CRUD', () => {
  it('creates a customer with normalised email and inline addresses', async () => {
    const res = await api.post('/customers', A, { email: `  Mixed.Case-${RUN}@Shop.TEST `, firstName: 'Mia', lastName: 'Case', phone: '+91 99999', addresses: [shipping, billing] });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: `mixed.case-${RUN}@shop.test`, firstName: 'Mia', phone: '+91 99999', tenantId: tenantA.id });
    expect(res.body.data.addresses).toHaveLength(2);
    for (const address of res.body.data.addresses) expect(address.isDefault).toBe(true);
    expect(res.body.data.addresses.find((a) => a.type === 'SHIPPING').country).toBe('IN');
  });

  it('rejects a duplicate email in the same tenant (case-insensitive) with 409', async () => {
    await newCustomer('dup');
    const res = await api.post('/customers', A, { email: `DUP-${RUN}@shop.test`, firstName: 'X', lastName: 'Y' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CUSTOMER_EMAIL_EXISTS');
  });

  it('allows the same email in another tenant', async () => {
    const res = await api.post('/customers', B, { email: `dup-${RUN}@shop.test`, firstName: 'X', lastName: 'Y' });
    expect(res.status).toBe(201);
  });

  it('validates input', async () => {
    expect((await api.post('/customers', A, { email: 'not-an-email', firstName: 'X', lastName: 'Y' })).status).toBe(400);
    expect((await api.post('/customers', A, { email: `v-${RUN}@shop.test`, firstName: '', lastName: 'Y' })).status).toBe(400);
    expect((await api.post('/customers', A, { email: `v-${RUN}@shop.test`, firstName: 'X', lastName: 'Y', addresses: [{ ...shipping, country: 'India' }] })).status).toBe(400);
    expect((await api.get('/customers/not-a-uuid', A)).status).toBe(400);
  });

  it('lists, searches and paginates', async () => {
    await newCustomer('searchable-zed');
    const search = await api.get('/customers?search=searchable-zed', A);
    expect(search.status).toBe(200);
    expect(search.body.data).toHaveLength(1);
    expect(search.body.data[0].lastName).toBe('searchable-zed');

    const page = await api.get('/customers?limit=2&page=1&sortBy=email&sortOrder=asc', A);
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(page.body.meta.total).toBeGreaterThanOrEqual(3);
    const emails = page.body.data.map((c) => c.email);
    expect([...emails].sort()).toEqual(emails);
  });

  it('updates a customer and writes an audit log', async () => {
    const customer = await newCustomer('update');
    const res = await api.patch(`/customers/${customer.id}`, A, { firstName: 'Renamed', phone: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: 'Renamed', phone: null });

    const logs = await prisma.auditLog.findMany({ where: { tenantId: tenantA.id, resource: 'customer', resourceId: customer.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(['CREATE', 'UPDATE']);
  });

  it('rejects changing the email to one already taken', async () => {
    const customer = await newCustomer('taken-target');
    const res = await api.patch(`/customers/${customer.id}`, A, { email: `dup-${RUN}@shop.test` });
    expect(res.status).toBe(409);
    expect((await api.patch(`/customers/${customer.id}`, A, {})).status).toBe(400);
  });

  it('soft-deletes: hidden from reads, email stays reserved, orders keep working', async () => {
    const customer = await newCustomer('deleted');
    const kept = await order(customer.id);
    expect(kept.status).toBe(201);

    expect((await api.delete(`/customers/${customer.id}`, A)).status).toBe(200);
    expect((await api.get(`/customers/${customer.id}`, A)).status).toBe(404);
    expect((await api.delete(`/customers/${customer.id}`, A)).status).toBe(404);
    expect((await api.get(`/customers?search=deleted-${RUN}`, A)).body.data).toHaveLength(0);
    expect((await api.post('/customers', A, { email: `deleted-${RUN}@shop.test`, firstName: 'X', lastName: 'Y' })).status).toBe(409);

    const blocked = await order(customer.id);
    expect(blocked.status).toBe(404);
    expect(blocked.body.error.code).toBe('CUSTOMER_NOT_FOUND');
    expect((await api.get(`/orders/${kept.body.data.id}`, A)).status).toBe(200);
  });
});

describe('Phase 29 — addresses', () => {
  let customer;

  beforeAll(async () => {
    customer = await newCustomer('addresses');
  });

  it('makes the first address of a type the default', async () => {
    const res = await api.post(`/customers/${customer.id}/addresses`, A, shipping);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'SHIPPING', isDefault: true, customerId: customer.id });
  });

  it('moves the default when a new address asks for it, keeping exactly one', async () => {
    const second = await api.post(`/customers/${customer.id}/addresses`, A, { ...shipping, line1: '2 Side St', isDefault: true });
    expect(second.body.data.isDefault).toBe(true);
    const third = await api.post(`/customers/${customer.id}/addresses`, A, { ...shipping, line1: '3 Back St' });
    expect(third.body.data.isDefault).toBe(false);

    const list = await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.body.data.id]);
  });

  it('updates an address and switches the default with PATCH', async () => {
    const list = (await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A)).body.data;
    const target = list.find((a) => !a.isDefault);
    const res = await api.patch(`/customers/${customer.id}/addresses/${target.id}`, A, { city: 'Chennai', isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ city: 'Chennai', isDefault: true });

    const after = (await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A)).body.data;
    expect(after.filter((a) => a.isDefault).map((a) => a.id)).toEqual([target.id]);
  });

  it('promotes another address when the default is deleted', async () => {
    const before = (await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A)).body.data;
    const def = before.find((a) => a.isDefault);
    expect((await api.delete(`/customers/${customer.id}/addresses/${def.id}`, A)).status).toBe(200);

    const after = (await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A)).body.data;
    expect(after).toHaveLength(2);
    expect(after.filter((a) => a.isDefault)).toHaveLength(1);
  });

  it('changing the type keeps one default per type', async () => {
    const list = (await api.get(`/customers/${customer.id}/addresses?type=SHIPPING`, A)).body.data;
    const def = list.find((a) => a.isDefault);
    const res = await api.patch(`/customers/${customer.id}/addresses/${def.id}`, A, { type: 'BILLING' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'BILLING', isDefault: true });

    const all = (await api.get(`/customers/${customer.id}/addresses`, A)).body.data;
    for (const type of ['SHIPPING', 'BILLING']) {
      expect(all.filter((a) => a.type === type && a.isDefault)).toHaveLength(1);
    }
  });

  it('404s for an address of another customer', async () => {
    const other = await newCustomer('other-addr', { addresses: [shipping] });
    const res = await api.patch(`/customers/${customer.id}/addresses/${other.addresses[0].id}`, A, { city: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });
});

describe('Phase 29 — orders snapshot addresses and customer order history', () => {
  let customer;
  let shipDefault;
  let shipOther;
  let bill;

  beforeAll(async () => {
    customer = await newCustomer('buyer', { addresses: [shipping, { ...shipping, line1: '5 Other Ave' }, billing] });
    shipDefault = customer.addresses.find((a) => a.type === 'SHIPPING' && a.isDefault);
    shipOther = customer.addresses.find((a) => a.type === 'SHIPPING' && !a.isDefault);
    bill = customer.addresses.find((a) => a.type === 'BILLING');
  });

  it('defaults to the customer’s default addresses', async () => {
    const res = await order(customer.id);
    expect(res.status).toBe(201);
    expect(res.body.data.shippingAddress).toMatchObject({ addressId: shipDefault.id, line1: '1 Main St', country: 'IN', type: 'SHIPPING' });
    expect(res.body.data.billingAddress).toMatchObject({ addressId: bill.id, company: 'Acme' });
  });

  it('uses the chosen address and keeps the snapshot after the address changes', async () => {
    const res = await order(customer.id, { shippingAddressId: shipOther.id });
    expect(res.status).toBe(201);
    expect(res.body.data.shippingAddress.line1).toBe('5 Other Ave');

    await api.patch(`/customers/${customer.id}/addresses/${shipOther.id}`, A, { line1: '6 Moved Rd' });
    const reread = await api.get(`/orders/${res.body.data.id}`, A);
    expect(reread.body.data.shippingAddress.line1).toBe('5 Other Ave');
  });

  it('rejects an address of the wrong type or another customer', async () => {
    const wrongType = await order(customer.id, { shippingAddressId: bill.id });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('ADDRESS_TYPE_MISMATCH');

    const stranger = await newCustomer('stranger', { addresses: [shipping] });
    const foreign = await order(customer.id, { shippingAddressId: stranger.addresses[0].id });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });

  it('leaves addresses empty for a customer without any', async () => {
    const bare = await newCustomer('bare');
    const res = await order(bare.id);
    expect(res.status).toBe(201);
    expect(res.body.data.shippingAddress).toBeNull();
    expect(res.body.data.billingAddress).toBeNull();
  });

  it('GET /customers/:id/orders returns only that customer’s orders, filterable by status', async () => {
    const res = await api.get(`/customers/${customer.id}/orders`, A);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data.every((o) => o.customerId === customer.id)).toBe(true);
    expect(res.body.data[0].items[0]).toMatchObject({ productVariantId: variantId, quantity: 1 });

    const cancelled = await api.get(`/customers/${customer.id}/orders?status=CANCELLED`, A);
    expect(cancelled.body.meta.total).toBe(0);
  });
});

describe('Phase 29 — access control and tenant isolation', () => {
  let customer;

  beforeAll(async () => {
    customer = await newCustomer('private', { addresses: [shipping] });
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/customers')).status).toBe(401);
  });

  it('requires customer permissions', async () => {
    expect((await api.get('/customers', noRole)).status).toBe(403);
    expect((await api.post('/customers', noRole, { email: `nr-${RUN}@shop.test`, firstName: 'X', lastName: 'Y' })).status).toBe(403);
    expect((await api.get(`/customers/${customer.id}/orders`, noRole)).status).toBe(403);
    expect((await api.post(`/customers/${customer.id}/addresses`, noRole, shipping)).status).toBe(403);
  });

  it('hides another tenant’s customers and addresses (404)', async () => {
    expect((await api.get(`/customers/${customer.id}`, B)).status).toBe(404);
    expect((await api.patch(`/customers/${customer.id}`, B, { firstName: 'Hacked' })).status).toBe(404);
    expect((await api.delete(`/customers/${customer.id}`, B)).status).toBe(404);
    expect((await api.get(`/customers/${customer.id}/orders`, B)).status).toBe(404);
    expect((await api.get(`/customers/${customer.id}/addresses`, B)).status).toBe(404);
    expect((await api.delete(`/customers/${customer.id}/addresses/${customer.addresses[0].id}`, B)).status).toBe(404);
    expect((await api.get(`/customers?search=private-${RUN}`, B)).body.data).toHaveLength(0);

    const still = await api.get(`/customers/${customer.id}`, A);
    expect(still.body.data.firstName).toBe('Bea');
  });
});
