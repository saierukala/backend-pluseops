import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { sign } from '../../src/integrations/payment/razorpay.client.js';
import { nextRunDate, recurringInvoicesService, todayInIndia } from '../../src/modules/recurring/recurring-invoices.service.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase40#Pass123';
const KEY_ID = 'rzp_test_Phase40Key01';
const KEY_SECRET = 'phase40-key-secret-abcdef';
const WEBHOOK_SECRET = 'phase40-webhook-secret-xyz';

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

let linkSeq = 0;
const links = [];
const realFetch = globalThis.fetch;
function fakeRazorpay(url, init = {}) {
  const path = url.slice(env.RAZORPAY_API_URL.length);
  const body = init.body ? JSON.parse(init.body) : null;
  const json = (status, data) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  if (init.method === 'GET' && path.startsWith('/orders')) return json(200, { entity: 'collection', count: 0, items: [] });
  if (init.method === 'POST' && path === '/payment_links') {
    const link = { id: `plink_P40${RUN}${++linkSeq}`, amount: body.amount, short_url: `https://rzp.io/i/p40${linkSeq}`, reference_id: body.reference_id, status: 'created' };
    links.push({ ...link, body });
    return json(200, link);
  }
  return json(404, { error: { description: 'not found' } });
}

let platformAdmin;
let tenantId;
let A;
let variantId;
let warehouseId;
let customerId;
let registerId;

beforeAll(async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => (String(url).startsWith(env.RAZORPAY_API_URL) ? fakeRazorpay(String(url), init) : realFetch(url, init)));
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p40_${RUN}` });
  const email = `p40-admin-${RUN}@test.local`;
  const created = await api.post('/platform/tenants', platformAdmin.token, { name: 'Phase 40', slug: `phase40-${RUN}`, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' } });
  tenantId = created.body.data.tenant.id;
  A = (await api.post('/auth/login', null, { email, password: PASSWORD })).body.data.accessToken;
  warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: 'MAIN', isDefault: true })).body.data.id;
  const product = (await api.post('/products', A, { name: 'Ledger', status: 'ACTIVE', hsnCode: '4820', gstRatePercent: 12 })).body.data;
  variantId = (await api.post(`/products/${product.id}/variants`, A, { sku: `LG-${RUN}`, price: '100.00', status: 'ACTIVE' })).body.data.id;
  await api.post('/inventory/adjust', A, { variantId, warehouseId, quantityChanged: 100 });
  customerId = (await api.post('/customers', A, { email: `shah-${RUN}@example.com`, firstName: 'Meera', lastName: 'Shah', customerType: 'BUSINESS', companyName: 'Shah Stores', phone: '9876543210' })).body.data.id;
  registerId = (await api.get('/cash-registers', A)).body.data[0].id;
  await api.post(`/cash-registers/${registerId}/open`, A, { openingFloat: '500' });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await prisma.creditNote.deleteMany({ where: { tenantId } });
  await prisma.quote.deleteMany({ where: { tenantId } });
  await prisma.recurringInvoice.deleteMany({ where: { tenantId } });
  await prisma.refund.deleteMany({ where: { tenantId } });
  await prisma.payment.deleteMany({ where: { tenantId } });
  await prisma.order.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

const stock = async () => (await prisma.inventory.aggregate({ where: { tenantId, productVariantId: variantId }, _sum: { quantity: true } }))._sum.quantity;
const balance = async () => (await api.get(`/customers/${customerId}/balance`, A)).body.data;

describe('Phase 40 — quotes', () => {
  let quoteId;
  it('prices a quote like an invoice without taking stock', async () => {
    const res = await api.post('/quotes', A, { customerId, items: [{ variantId, quantity: 3 }], validUntil: '2026-12-31' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'DRAFT', total: '336', taxTotal: '36', supplyType: 'INTRA' });
    expect(res.body.data.number).toMatch(/-QT\/\d{4}-\d{2}\/0001$/);
    expect(res.body.data.items[0]).toMatchObject({ gstRatePercent: 12, hsnCode: '4820', taxableValue: '300.00' });
    expect(await stock()).toBe(100);
    quoteId = res.body.data.id;
  });

  it('moves through sent and accepted, then locks', async () => {
    expect((await api.post(`/quotes/${quoteId}/status`, A, { status: 'SENT' })).status).toBe(200);
    expect((await api.post(`/quotes/${quoteId}/status`, A, { status: 'ACCEPTED' })).status).toBe(200);
    expect((await api.patch(`/quotes/${quoteId}`, A, { notes: 'x' })).body.error.code).toBe('QUOTE_LOCKED');
  });

  it('converts once into an order that takes the stock', async () => {
    const res = await api.post(`/quotes/${quoteId}/convert`, A, {});
    expect(res.status).toBe(201);
    expect(res.body.data.quote).toMatchObject({ status: 'CONVERTED', convertedOrderId: res.body.data.order.id });
    expect(res.body.data.order.metadata.quoteId).toBe(quoteId);
    expect(await stock()).toBe(97);
    expect((await api.post(`/quotes/${quoteId}/convert`, A, {})).body.error.code).toBe('QUOTE_LOCKED');
    expect((await api.delete(`/quotes/${quoteId}`, A)).status).toBe(409);
  });
});

describe('Phase 40 — credit sales and the customer account', () => {
  let creditOrder;
  it('pay later needs a named customer', async () => {
    const res = await api.post('/pos/sales', A, { items: [{ variantId, quantity: 1 }], payments: [{ method: 'CREDIT', amount: '112.00' }] });
    expect(res.body.error.code).toBe('CREDIT_NEEDS_CUSTOMER');
  });

  it('part cash, part pay later: the rest is owed', async () => {
    const res = await api.post('/pos/sales', A, { customerId, items: [{ variantId, quantity: 2 }], payments: [{ method: 'CASH', amount: '24.00' }, { method: 'CREDIT', amount: '200.00' }] });
    expect(res.status).toBe(201);
    creditOrder = res.body.data.order;
    expect(creditOrder.metadata.payLater).toBe('200.00');
    const b = await balance();
    expect(b).toMatchObject({ billed: '560.00', paid: '24.00', outstanding: '536.00' });
    expect(b.invoices.map((i) => i.due)).toEqual(['336.00', '200.00']);
  });

  it('a payment settles the oldest invoice first and cannot exceed what is owed', async () => {
    expect((await api.post(`/customers/${customerId}/payments`, A, { amount: '9999', method: 'BANK' })).body.error.code).toBe('PAYMENT_EXCEEDS_DUE');
    const res = await api.post(`/customers/${customerId}/payments`, A, { amount: '300.00', method: 'BANK', reference: 'NEFT 1' });
    expect(res.status).toBe(201);
    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.payments[0].amount).toBe('300');
    expect(res.body.data.balance.outstanding).toBe('236.00');
  });

  it('returns: cash back is capped at what was paid; the rest reduces what is owed', async () => {
    const items = (await api.get(`/orders/${creditOrder.id}`, A)).body.data.items;
    const first = await api.post(`/orders/${creditOrder.id}/returns`, A, { items: [{ orderItemId: items[0].id, quantity: 1 }], refundMethod: 'CASH', reason: 'Torn' });
    expect(first.status).toBe(201);
    expect(first.body.data.creditNote).toMatchObject({ total: '112', taxTotal: '12', refundedAmount: '24', refundMethod: 'CASH' });
    expect(first.body.data.creditNote.number).toMatch(/-CN\/\d{4}-\d{2}\/0001$/);
    expect((await api.get(`/orders/${creditOrder.id}`, A)).body.data.status).toBe('PARTIALLY_REFUNDED');
    expect(await stock()).toBe(96); // 97 − 2 sold + 1 back
    const shift = (await api.get(`/cash-registers/${registerId}/current`, A)).body.data;
    expect(shift.totals.cashRefunds).toBe('24.00');

    expect((await api.post(`/orders/${creditOrder.id}/returns`, A, { items: [{ orderItemId: items[0].id, quantity: 5 }] })).body.error.code).toBe('RETURN_EXCEEDS_SOLD');
    const last = await api.post(`/orders/${creditOrder.id}/returns`, A, { items: [{ orderItemId: items[0].id, quantity: 1, restock: false }] });
    expect(last.body.data.creditNote).toMatchObject({ total: '112', refundMethod: 'CREDIT', refundedAmount: '0' });
    expect((await api.get(`/orders/${creditOrder.id}`, A)).body.data.status).toBe('REFUNDED');
    expect(await stock()).toBe(96); // not restocked
    expect((await balance()).outstanding).toBe('36.00');
  });

  it('statement runs to the same balance; receivables list the customer with ageing', async () => {
    const st = (await api.get(`/customers/${customerId}/statement`, A)).body.data;
    expect(st.closingBalance).toBe('36.00');
    expect(st.lines.map((l) => l.type)).toEqual(expect.arrayContaining(['INVOICE', 'PAYMENT', 'CREDIT_NOTE', 'REFUND']));
    const rec = (await api.get('/receivables', A)).body.data;
    expect(rec.customers[0]).toMatchObject({ customerId, name: 'Shah Stores', outstanding: '36.00' });
    expect(rec.totals.current).toBe('36.00');
  });
});

describe('Phase 40 — payment links (Razorpay)', () => {
  it('needs Razorpay', async () => {
    const order = (await api.get(`/customers/${customerId}/balance`, A)).body.data.invoices[0];
    expect((await api.post(`/orders/${order.id}/payment-link`, A, {})).body.error.code).toBe('PAYMENT_GATEWAY_NOT_CONFIGURED');
  });

  it('a link for what is due, paid by the payment_link.paid webhook', async () => {
    expect((await api.put('/workspace/payment-gateway', A, { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET })).status).toBe(200);
    const order = (await balance()).invoices[0];
    const res = await api.post(`/orders/${order.id}/payment-link`, A, {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ amount: '36.00', reused: false });
    expect(links.at(-1).body).toMatchObject({ amount: 3600, notify: { email: true, sms: true } });
    expect((await api.post(`/orders/${order.id}/payment-link`, A, {})).body.data.reused).toBe(true);

    const link = links.at(-1);
    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: link.id, amount: 3600, amount_paid: 3600, status: 'paid' } }, payment: { entity: { id: `pay_P40${RUN}`, amount: 3600, status: 'captured' } } } });
    const hook = await request(app).post(`/api/v1/payments/webhook/razorpay/${tenantId}`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', sign(WEBHOOK_SECRET, raw)).set('X-Razorpay-Event-Id', `evt_P40_${RUN}`).send(raw);
    expect(hook.status).toBe(200);
    expect((await balance()).outstanding).toBe('0.00');
  });
});

describe('Phase 40 — recurring invoices', () => {
  it('keeps month ends', () => {
    expect(nextRunDate('2026-01-31', 'MONTHLY', 31)).toBe('2026-02-28');
    expect(nextRunDate('2026-02-28', 'MONTHLY', 31)).toBe('2026-03-31');
    expect(nextRunDate('2026-11-30', 'QUARTERLY', 30)).toBe('2027-02-28');
    expect(nextRunDate('2026-10-25', 'WEEKLY', 25)).toBe('2026-11-01');
  });

  it('the hourly job bills what is due today, once', async () => {
    const res = await api.post('/recurring-invoices', A, { customerId, name: 'Monthly ledger', items: [{ variantId, quantity: 1 }], frequency: 'MONTHLY' });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    expect(res.body.data.nextRunOn.slice(0, 10)).toBe(todayInIndia());

    const first = await recurringInvoicesService.runDue(new Date());
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const second = await recurringInvoicesService.runDue(new Date());
    expect(second.checked).toBe(0); // moved to next month

    const got = (await api.get(`/recurring-invoices/${id}`, A)).body.data;
    expect(got).toMatchObject({ runsCount: 1, lastError: null });
    expect(got.runs).toHaveLength(1);
    expect(got.nextRunOn.slice(0, 10)).not.toBe(todayInIndia());
  });

  it('pause stops billing; bill now raises an invoice', async () => {
    const id = (await api.post('/recurring-invoices', A, { customerId, name: 'Weekly', items: [{ variantId, quantity: 1 }], frequency: 'WEEKLY', startOn: '2099-01-01' })).body.data.id;
    const ahead = await api.post(`/recurring-invoices/${id}/run`, A, {});
    expect(ahead.status).toBe(201);
    expect((await api.get(`/recurring-invoices/${id}`, A)).body.data.nextRunOn.slice(0, 10)).toBe('2099-01-01'); // billing early keeps the date
    expect((await api.patch(`/recurring-invoices/${id}`, A, { status: 'PAUSED' })).status).toBe(200);
    expect((await api.post(`/recurring-invoices/${id}/run`, A, {})).body.error.code).toBe('RECURRING_INVOICE_NOT_ACTIVE');
  });
});
