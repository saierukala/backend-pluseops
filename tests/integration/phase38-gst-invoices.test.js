import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { financialYear, gstinCheckChar, isValidGstin, isValidPan, toStateCode } from '../../src/modules/gst/india.js';
import { includedGstCents, lineTax, splitTax } from '../../src/modules/orders/gst.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase38#Pass123';
const gstin = (first14) => first14 + gstinCheckChar(first14);
const KA_GSTIN = gstin('29AAACR1234A1Z'); // Karnataka
const MH_GSTIN = gstin('27AAPFU0939F1Z'); // Maharashtra

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(token ? bearer(token) : {}).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
};

let platformAdmin;
let tenant;
let token;
let warehouseId;
let riceId; // 5% GST, HSN 1006
let milkId; // exempt
let consumerId; // ships within Karnataka
let businessId; // Maharashtra GSTIN

const order = async (customerId, items) => {
  const res = await api.post('/orders', token, { customerId, items: items.map(([productVariantId, quantity]) => ({ productVariantId, warehouseId, quantity })) });
  expect(res.status).toBe(201);
  return res.body.data;
};

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p38_${RUN}` });
  const email = `p38-admin-${RUN}@test.local`;
  const created = await api.post('/platform/tenants', platformAdmin.token, {
    name: 'Phase 38', slug: `phase38-${RUN}`, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' },
  });
  tenant = created.body.data.tenant;
  token = (await api.post('/auth/login', null, { email, password: PASSWORD })).body.data.accessToken;

  warehouseId = (await api.post('/warehouses', token, { name: 'Main', code: 'MAIN' })).body.data.id;
  const rice = (await api.post('/products', token, { name: 'Rice 5kg', status: 'ACTIVE', hsnCode: '1006', gstRatePercent: 5 })).body.data;
  riceId = (await api.post(`/products/${rice.id}/variants`, token, { sku: `RICE-${RUN}`, price: '500.00', mrp: '550.00', status: 'ACTIVE' })).body.data.id;
  const milk = (await api.post('/products', token, { name: 'Milk', status: 'ACTIVE', hsnCode: '0401', gstTaxability: 'EXEMPT' })).body.data;
  milkId = (await api.post(`/products/${milk.id}/variants`, token, { sku: `MILK-${RUN}`, price: '60.00', status: 'ACTIVE' })).body.data.id;
  for (const variantId of [riceId, milkId]) await api.post('/inventory/adjust', token, { variantId, warehouseId, quantityChanged: 100 });

  consumerId = (await api.post('/customers', token, {
    email: `consumer-${RUN}@example.com`, firstName: 'Kiran', lastName: 'K',
    addresses: [{ type: 'SHIPPING', line1: '2 Brigade Rd', city: 'Bengaluru', state: 'KA', country: 'IN', isDefault: true }],
  })).body.data.id;
  businessId = (await api.post('/customers', token, {
    email: `business-${RUN}@example.com`, firstName: 'Ravi', lastName: 'Rao', customerType: 'BUSINESS', companyName: 'Ravi Traders', gstin: MH_GSTIN,
  })).body.data.id;
});

afterAll(async () => {
  if (tenant?.id) await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 38 — GST reference data', () => {
  it('validates GSTIN format, state and check digit, and PAN', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false); // wrong check digit
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false); // no such state
    expect(isValidGstin('27AAPFU0939F1V')).toBe(false); // too short
    expect(isValidPan('AAPFU0939F')).toBe(true);
    expect(isValidPan('AAPF0939F')).toBe(false);
  });

  it('resolves states from codes, short forms and names', () => {
    expect(['29', '9', 'KA', 'ka', 'Karnataka', 'Jammu & Kashmir', 'Mars'].map(toStateCode)).toEqual(['29', '09', '29', '29', '29', '01', null]);
  });

  it('uses the Indian financial year (April–March, India time)', () => {
    expect(financialYear(new Date('2026-10-25T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T17:00:00Z'))).toBe('2026-27'); // 22:30 IST, still March
    expect(financialYear(new Date('2027-03-31T19:00:00Z'))).toBe('2027-28'); // 00:30 IST, 1 April
  });

  it('splits and extracts tax to the paisa', () => {
    expect(splitTax(5001, true)).toEqual({ cgst: 2500, sgst: 2501, igst: 0 });
    expect(splitTax(5001, false)).toEqual({ cgst: 0, sgst: 0, igst: 5001 });
    expect(includedGstCents(50000, 5)).toBe(2381); // ₹500 incl. 5% → ₹23.81 GST
    expect(lineTax(100000, 18)).toEqual({ taxableCents: 100000, taxCents: 18000 });
    expect(lineTax(118000, 18, { inclusive: true })).toEqual({ taxableCents: 100000, taxCents: 18000 });
    expect(lineTax(100000, 18, { explicitTaxCents: 0 })).toEqual({ taxableCents: 100000, taxCents: 0 });
  });
});

describe('Phase 38 — tax profile', () => {
  it('starts empty', async () => {
    const res = await api.get('/workspace/tax-profile', token);
    expect(res.status).toBe(200);
    expect(res.body.data.gstin).toBeNull();
  });

  it('rejects an invalid GSTIN and a GSTIN from another state', async () => {
    expect((await api.patch('/workspace/tax-profile', token, { gstin: '29AAACR1234A1ZX' })).status).toBe(400);
    expect((await api.patch('/workspace/tax-profile', token, { gstin: KA_GSTIN, stateCode: 'MH' })).status).toBe(400);
  });

  it('fills the state and PAN from the GSTIN', async () => {
    const res = await api.patch('/workspace/tax-profile', token, { legalName: 'Phase 38 Pvt Ltd', gstin: KA_GSTIN, invoicePrefix: 'p38', registrationType: 'REGULAR' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stateCode: '29', stateName: 'Karnataka', pan: 'AAACR1234A', invoicePrefix: 'P38' });
  });
});

describe('Phase 38 — customers', () => {
  it('a business customer needs a company name and a valid GSTIN', async () => {
    expect((await api.post('/customers', token, { email: `nocompany-${RUN}@example.com`, firstName: 'A', lastName: 'B', customerType: 'BUSINESS' })).status).toBe(400);
    expect((await api.post('/customers', token, { email: `badgst-${RUN}@example.com`, firstName: 'A', lastName: 'B', customerType: 'BUSINESS', companyName: 'X', gstin: '27AAPFU0939F1ZX' })).status).toBe(400);
  });

  it('stores state and PAN from the GSTIN', async () => {
    const res = await api.get(`/customers/${businessId}`, token);
    expect(res.body.data).toMatchObject({ customerType: 'BUSINESS', companyName: 'Ravi Traders', stateCode: '27', pan: 'AAPFU0939F' });
  });
});

describe('Phase 38 — tax invoices', () => {
  it('in-state sale: CGST + SGST per item rate, exempt goods untaxed, invoice numbered', async () => {
    const o = await order(consumerId, [[riceId, 2], [milkId, 1]]);
    expect(o.invoiceNumber).toBe(`P38/${financialYear()}/0001`);
    expect(o).toMatchObject({ supplyType: 'INTRA', placeOfSupply: '29', subtotal: '1060', taxTotal: '50', cgstTotal: '25', sgstTotal: '25', igstTotal: '0', total: '1110' });
    const rice = o.items.find((i) => i.productVariantId === riceId);
    const milk = o.items.find((i) => i.productVariantId === milkId);
    expect(rice).toMatchObject({ hsnCode: '1006', gstRatePercent: '5', taxableValue: '1000', cgst: '25', sgst: '25', igst: '0' });
    expect(milk).toMatchObject({ hsnCode: '0401', gstRatePercent: '0', tax: '0' });
    expect(o.sellerSnapshot).toMatchObject({ name: 'Phase 38 Pvt Ltd', gstin: KA_GSTIN, stateCode: '29' });
    expect(o.buyerSnapshot).toMatchObject({ type: 'CONSUMER', name: 'Kiran K', gstin: null });
  });

  it('inter-state sale to a business: IGST, company and GSTIN on the invoice, next number', async () => {
    const o = await order(businessId, [[riceId, 1]]);
    expect(o.invoiceNumber).toBe(`P38/${financialYear()}/0002`);
    expect(o).toMatchObject({ supplyType: 'INTER', placeOfSupply: '27', taxTotal: '25', cgstTotal: '0', sgstTotal: '0', igstTotal: '25', total: '525' });
    expect(o.buyerSnapshot).toMatchObject({ type: 'BUSINESS', name: 'Ravi Traders', contactName: 'Ravi Rao', gstin: MH_GSTIN });
  });

  it('tax-inclusive prices: GST comes out of the price', async () => {
    await api.patch('/workspace/tax-profile', token, { pricesIncludeTax: true });
    const o = await order(consumerId, [[riceId, 1]]);
    expect(o).toMatchObject({ subtotal: '476.19', taxTotal: '23.81', total: '500' });
    expect(o.metadata.pricesIncludeTax).toBe(true);
  });

  it('composition dealers charge no GST', async () => {
    await api.patch('/workspace/tax-profile', token, { registrationType: 'COMPOSITION', pricesIncludeTax: false });
    const o = await order(consumerId, [[riceId, 1]]);
    expect(o).toMatchObject({ taxTotal: '0', total: '500' });
    await api.patch('/workspace/tax-profile', token, { registrationType: 'REGULAR' });
  });

  it('invoice numbers are unique per workspace', async () => {
    const numbers = (await prisma.order.findMany({ where: { tenantId: tenant.id }, select: { invoiceNumber: true } })).map((o) => o.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
