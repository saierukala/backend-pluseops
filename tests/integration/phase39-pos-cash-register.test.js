import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase39#Pass123';
const KEY_ID = 'rzp_test_Phase39Key01';
const KEY_SECRET = 'phase39-key-secret-abcdef';

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body, headers = {}) => request(app).post(`/api/v1${path}`).set({ ...bearer(token), ...headers }).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

// Razorpay stand-in: QR codes and the payments made on them
const qrPaid = new Map(); // qrId -> paid amount (paise)
let seq = 0;
const realFetch = globalThis.fetch;
function fakeRazorpay(url, init = {}) {
  const path = url.slice(env.RAZORPAY_API_URL.length);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (status, data) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  if (init.method === 'GET' && path.startsWith('/orders')) return json(200, { entity: 'collection', count: 0, items: [] });
  if (init.method === 'POST' && path === '/payments/qr_codes') {
    const id = `qr_P39${RUN}${++seq}`;
    return json(200, { id, entity: 'qr_code', image_url: `https://rzp.io/i/${id}`, payment_amount: body.payment_amount, usage: body.usage, fixed_amount: body.fixed_amount });
  }
  const payments = path.match(/^\/payments\/qr_codes\/([^/]+)\/payments$/);
  if (init.method === 'GET' && payments) {
    const amount = qrPaid.get(decodeURIComponent(payments[1]));
    return json(200, { entity: 'collection', items: amount ? [{ id: `pay_P39${decodeURIComponent(payments[1])}`, status: 'captured', amount, vpa: 'buyer@okaxis' }] : [] });
  }
  return json(404, { error: { description: 'not found' } });
}

let platformAdmin;
let tenantId;
let A; // admin
let S; // staff without POS permissions
let variantId;
let registerId;
let sessionId;

const sale = (payments, extra = {}, headers = {}) => api.post('/pos/sales', A, { items: [{ variantId, quantity: 1 }], payments, ...extra }, headers);

beforeAll(async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => (String(url).startsWith(env.RAZORPAY_API_URL) ? fakeRazorpay(String(url), init) : realFetch(url, init)));
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p39_${RUN}` });
  const email = `p39-admin-${RUN}@test.local`;
  const created = await api.post('/platform/tenants', platformAdmin.token, { name: 'Phase 39', slug: `phase39-${RUN}`, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' } });
  tenantId = created.body.data.tenant.id;
  A = (await api.post('/auth/login', null, { email, password: PASSWORD })).body.data.accessToken;

  // A staff member with the built-in member role (read permissions only)
  const staffEmail = `p39-staff-${RUN}@test.local`;
  await request(app).post('/api/v1/auth/register').send({ email: staffEmail, password: PASSWORD, firstName: 'Sam', lastName: 'Staff', tenantId });
  const staffId = (await api.post('/auth/login', null, { email: staffEmail, password: PASSWORD })).body.data.user.id;
  const member = await prisma.role.findFirst({ where: { tenantId, name: 'member' } });
  expect((await api.post(`/users/${staffId}/roles`, A, { roleIds: [member.id] })).status).toBe(200);
  S = (await api.post('/auth/login', null, { email: staffEmail, password: PASSWORD })).body.data.accessToken;

  const warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: 'MAIN', isDefault: true })).body.data.id;
  const product = (await api.post('/products', A, { name: 'Notebook', status: 'ACTIVE', hsnCode: '4820', gstRatePercent: 12 })).body.data;
  variantId = (await api.post(`/products/${product.id}/variants`, A, { sku: `NB-${RUN}`, barcode: `890${RUN}`, price: '100.00', status: 'ACTIVE' })).body.data.id;
  await api.post('/inventory/adjust', A, { variantId, warehouseId, quantityChanged: 50 });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await prisma.payment.deleteMany({ where: { tenantId } });
  await prisma.order.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 39 — counter lookup', () => {
  it('finds an item by exact barcode first, with its GST rate and stock', async () => {
    const res = await api.get(`/pos/lookup?q=890${RUN}`, A);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ variantId, exactMatch: true, gstRatePercent: 12, stock: 50, hsnCode: '4820' });
  });

  it('needs pos:sell', async () => {
    expect((await api.get('/pos/lookup?q=NB', S)).status).toBe(403);
    expect((await api.post('/pos/sales', S, { items: [{ variantId, quantity: 1 }], payments: [{ method: 'CARD', amount: '112.00' }] })).status).toBe(403);
  });

  it('gives the counter its walk-in customer and default counter', async () => {
    const res = await api.get('/pos/context', A);
    expect(res.body.data.walkInCustomerId).toBeTruthy();
    expect(res.body.data.registers[0]).toMatchObject({ name: 'Main counter', openSession: null });
    registerId = res.body.data.registers[0].id;
  });
});

describe('Phase 39 — cash register', () => {
  it('refuses cash while the register is closed', async () => {
    const res = await sale([{ method: 'CASH', amount: '112.00' }]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTER_CLOSED');
  });

  it('opens one shift per counter with a float', async () => {
    const res = await api.post(`/cash-registers/${registerId}/open`, A, { openingFloat: '500' });
    expect(res.status).toBe(201);
    sessionId = res.body.data.id;
    expect(res.body.data.totals.expectedCash).toBe('500.00');
    expect((await api.post(`/cash-registers/${registerId}/open`, A, { openingFloat: '1' })).status).toBe(409);
  });

  it('member can see the register but not open or move cash', async () => {
    expect((await api.get('/cash-registers', S)).status).toBe(200);
    expect((await api.post(`/cash-registers/sessions/${sessionId}/movements`, S, { type: 'CASH_IN', amount: '1', reason: 'x' })).status).toBe(403);
  });
});

describe('Phase 39 — counter sales', () => {
  it('walk-in cash sale: GST invoice, delivered, change, stock and drawer updated', async () => {
    const res = await sale([{ method: 'CASH', amount: '112.00', tendered: '200' }]);
    expect(res.status).toBe(201);
    const { order, payments, change } = res.body.data;
    expect(order).toMatchObject({ channel: 'POS', status: 'DELIVERED', total: '112', taxTotal: '12' });
    expect(order.invoiceNumber).toMatch(/\/\d{4}-\d{2}\/0001$/);
    expect(order.customer.firstName).toBe('Walk-in');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: 'cash', status: 'COMPLETED' });
    expect(change).toBe('88.00');
    const shift = (await api.get(`/cash-registers/${registerId}/current`, A)).body.data;
    expect(shift.totals).toMatchObject({ cashSales: '112.00', expectedCash: '612.00' });
    const stock = await prisma.inventory.aggregate({ where: { tenantId, productVariantId: variantId }, _sum: { quantity: true } });
    expect(stock._sum.quantity).toBe(49);
  });

  it('split card + UPI', async () => {
    const res = await sale([{ method: 'CARD', amount: '50.00', reference: 'slip 1' }, { method: 'UPI', amount: '62.00', reference: 'UTR 2' }]);
    expect(res.status).toBe(201);
    expect(res.body.data.payments.map((p) => p.provider).sort()).toEqual(['card', 'upi']);
  });

  it('payments that do not match the bill sell nothing', async () => {
    const before = await prisma.order.count({ where: { tenantId } });
    const res = await sale([{ method: 'CARD', amount: '1.00' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_TOTAL_MISMATCH');
    expect(await prisma.order.count({ where: { tenantId } })).toBe(before);
    const stock = await prisma.inventory.aggregate({ where: { tenantId, productVariantId: variantId }, _sum: { quantity: true } });
    expect(stock._sum.quantity).toBe(48);
  });

  it('cash given must cover the cash amount', async () => {
    expect((await sale([{ method: 'CASH', amount: '112.00', tendered: '100' }])).body.error.code).toBe('CASH_SHORT');
  });

  it('a double-clicked sale with the same Idempotency-Key happens once', async () => {
    const key = `p39-${RUN}-double`;
    const first = await sale([{ method: 'CARD', amount: '112.00' }], {}, { 'Idempotency-Key': key });
    const second = await sale([{ method: 'CARD', amount: '112.00' }], {}, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.order.id).toBe(first.body.data.order.id);
    expect((await sale([{ method: 'UPI', amount: '112.00' }], {}, { 'Idempotency-Key': key })).status).toBe(422);
  });

  it('a failed request frees its Idempotency-Key', async () => {
    const key = `p39-${RUN}-retry`;
    expect((await sale([{ method: 'CARD', amount: '1.00' }], {}, { 'Idempotency-Key': key })).status).toBe(400);
    expect((await sale([{ method: 'CARD', amount: '112.00' }], {}, { 'Idempotency-Key': key })).status).toBe(201);
  });
});

describe('Phase 39 — UPI through Razorpay', () => {
  beforeAll(async () => {
    const res = await api.put('/workspace/payment-gateway', A, { keyId: KEY_ID, keySecret: KEY_SECRET });
    expect(res.status).toBe(200);
  });

  it('creates an exact-amount single-use QR, and a sale only goes through once Razorpay has the money', async () => {
    const qr = await api.post('/pos/upi-qr', A, { amount: '112.00' });
    expect(qr.status).toBe(201);
    expect(qr.body.data).toMatchObject({ provider: 'razorpay', amount: '112.00' });
    const qrId = qr.body.data.qrId;

    expect((await api.get(`/pos/upi-qr/${qrId}`, A)).body.data.paid).toBe(false);
    const early = await sale([{ method: 'UPI', amount: '112.00', razorpayQrId: qrId }]);
    expect(early.body.error.code).toBe('UPI_PAYMENT_NOT_RECEIVED');

    qrPaid.set(qrId, 11200);
    expect((await api.get(`/pos/upi-qr/${qrId}`, A)).body.data).toMatchObject({ paid: true, amount: '112.00' });
    const paid = await sale([{ method: 'UPI', amount: '112.00', razorpayQrId: qrId }]);
    expect(paid.status).toBe(201);
    expect(paid.body.data.payments[0]).toMatchObject({ provider: 'razorpay', providerPaymentId: `pay_P39${qrId}` });

    // The same money can't pay for a second sale
    expect((await sale([{ method: 'UPI', amount: '112.00', razorpayQrId: qrId }])).body.error.code).toBe('UPI_PAYMENT_ALREADY_USED');
  });
});

describe('Phase 39 — closing the shift', () => {
  it('cash in, no cash out beyond the drawer, close with variance', async () => {
    expect((await api.post(`/cash-registers/sessions/${sessionId}/movements`, A, { type: 'CASH_IN', amount: '100', reason: 'Change top-up' })).status).toBe(201);
    expect((await api.post(`/cash-registers/sessions/${sessionId}/movements`, A, { type: 'CASH_OUT', amount: '99999', reason: 'Too much' })).body.error.code).toBe('INSUFFICIENT_CASH');
    const closed = await api.post(`/cash-registers/sessions/${sessionId}/close`, A, { countedCash: '700' });
    expect(closed.status).toBe(200);
    // 500 float + 112 cash sale + 100 in = 712 expected; counted 700 → 12 short
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', expectedCash: '712', countedCash: '700', variance: '-12' });
    expect((await api.post(`/cash-registers/sessions/${sessionId}/close`, A, { countedCash: '700' })).body.error.code).toBe('CASH_SESSION_CLOSED');
    const history = await api.get(`/cash-registers/sessions?registerId=${registerId}`, A);
    expect(history.body.data[0]).toMatchObject({ id: sessionId, status: 'CLOSED' });
  });
});

describe('Phase 39 — held sales', () => {
  it('parks a cart and removes it when resumed', async () => {
    const held = await api.post('/pos/held-sales', A, { label: 'Table 4', cart: { items: [{ variantId, quantity: 3 }] } });
    expect(held.status).toBe(201);
    expect((await api.get('/pos/held-sales', A)).body.data.map((h) => h.id)).toContain(held.body.data.id);
    expect((await api.delete(`/pos/held-sales/${held.body.data.id}`, A)).status).toBe(200);
    expect((await api.delete(`/pos/held-sales/${held.body.data.id}`, A)).status).toBe(404);
  });
});
