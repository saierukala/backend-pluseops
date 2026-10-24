import { jest } from '@jest/globals';
import dns from 'node:dns';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase32#Pass123';
const SHOPPER_PASSWORD = 'Shopper#Pass123';

let platformAdmin;
let tenantA;
let tenantB;
let A;
let B;
let slugA;
let slugB;
let sofa;
let sofaBlue;
let sofaRed;
let lamp;
let lampVariant;
let warehouseId;

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};
const sf = (path = '', slug = slugA) => `/storefront/${slug}${path}`;

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

async function createTenant(label) {
  const slug = `phase32-${label}-${RUN}`;
  const res = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Phase 32 ${label}`, slug, status: 'ACTIVE', admin: { email: `p32-${label}-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: label } });
  return { id: res.body.data.tenant.id, slug, token: await login(`p32-${label}-${RUN}@test.local`) };
}

/** Full shopper signup: register → emailed code → set password (signs in). */
async function signUp(email, slug = slugA) {
  const reg = await api.post(sf('/auth/register', slug), null, { email, firstName: 'Sam', lastName: 'Shopper' });
  expect(reg.status).toBe(202);
  const set = await api.post(sf('/auth/set-password', slug), null, { token: reg.body.data.devToken, password: SHOPPER_PASSWORD });
  expect(set.status).toBe(200);
  return set.body.data;
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p32_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  ({ token: A, slug: slugA } = tenantA);
  ({ token: B, slug: slugB } = tenantB);
  await api.patch('/workspace/settings', A, { currency: 'INR' });

  warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: `P32-${RUN}`, isDefault: true })).body.data.id;
  const category = (await api.post('/categories', A, { name: 'Living room', slug: `living-${RUN}` })).body.data;

  sofa = (await api.post('/products', A, { name: `Cloud Sofa ${RUN}`, brand: 'Ravi', description: 'Deep seats', status: 'ACTIVE' })).body.data;
  sofaBlue = (await api.post(`/products/${sofa.id}/variants`, A, { sku: `SOFA-BLUE-${RUN}`, price: '45000.00', costPrice: '30000.00', status: 'ACTIVE' })).body.data;
  sofaRed = (await api.post(`/products/${sofa.id}/variants`, A, { sku: `SOFA-RED-${RUN}`, price: '52000.00', costPrice: '31000.00', status: 'ACTIVE' })).body.data;
  await prisma.productCategory.create({ data: { tenantId: tenantA.id, productId: sofa.id, categoryId: category.id } });
  await prisma.productImage.create({ data: { tenantId: tenantA.id, productId: sofa.id, storageKey: `tenants/${tenantA.id}/products/${sofa.id}/a_sofa.jpg`, isPrimary: true, altText: 'Sofa' } });
  await api.post('/inventory/adjust', A, { variantId: sofaBlue.id, warehouseId, quantityChanged: 5, reason: 'INIT' });

  lamp = (await api.post('/products', A, { name: `Moon Lamp ${RUN}`, status: 'ACTIVE' })).body.data;
  lampVariant = (await api.post(`/products/${lamp.id}/variants`, A, { sku: `LAMP-${RUN}`, price: '1299.00', status: 'ACTIVE' })).body.data;
  await api.post('/inventory/adjust', A, { variantId: lampVariant.id, warehouseId, quantityChanged: 20, reason: 'INIT' });

  // Not sellable: draft product, and an active product whose only variant is a draft
  await api.post('/products', A, { name: `Secret Draft ${RUN}`, status: 'DRAFT' });
  const noVariants = (await api.post('/products', A, { name: `Half Done ${RUN}`, status: 'ACTIVE' })).body.data;
  await api.post(`/products/${noVariants.id}/variants`, A, { sku: `HALF-${RUN}`, price: '10.00', status: 'DRAFT' });
});

afterAll(async () => {
  jest.restoreAllMocks();
  const tenantIds = [tenantA?.id, tenantB?.id].filter(Boolean);
  await prisma.payment.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 32 — public catalog', () => {
  it('serves store info by slug, and nothing for unknown, platform or suspended tenants', async () => {
    const res = await api.get(sf());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ slug: slugA, name: 'Phase 32 a', currency: 'INR' });
    expect((await api.get('/storefront/no-such-store')).status).toBe(404);
    expect((await api.get('/storefront/__platform')).status).toBe(404);

    await api.patch(`/platform/tenants/${tenantB.id}/status`, platformAdmin.token, { status: 'SUSPENDED' });
    expect((await api.get(sf('', slugB))).status).toBe(404);
    await api.patch(`/platform/tenants/${tenantB.id}/status`, platformAdmin.token, { status: 'ACTIVE' });
  });

  it('lists only sellable products, with price range, availability and a signed image', async () => {
    const res = await api.get(sf('/products'));
    expect(res.status).toBe(200);
    const names = res.body.data.map((p) => p.name);
    expect(names.sort()).toEqual([`Cloud Sofa ${RUN}`, `Moon Lamp ${RUN}`]);
    const card = res.body.data.find((p) => p.id === sofa.id);
    expect(card).toMatchObject({ priceFrom: '45000.00', priceTo: '52000.00', currency: 'INR', inStock: true, image: { altText: 'Sofa' } });
    expect(card.image.url).toMatch(/^\/api\/v1\/storage\/signed\?key=/);
  });

  it('never exposes cost prices, barcodes or stock levels', async () => {
    const list = JSON.stringify((await api.get(sf('/products'))).body);
    const detail = JSON.stringify((await api.get(sf(`/products/${sofa.id}`))).body);
    for (const body of [list, detail]) {
      expect(body).not.toMatch(/costPrice|30000|barcode|quantity|warehouse/i);
    }
  });

  it('searches, filters by category and price, sorts, and filters to in-stock', async () => {
    expect((await api.get(sf('/products?search=moon'))).body.data.map((p) => p.id)).toEqual([lamp.id]);
    expect((await api.get(sf(`/products?category=living-${RUN}`))).body.data.map((p) => p.id)).toEqual([sofa.id]);
    expect((await api.get(sf('/products?maxPrice=2000'))).body.data.map((p) => p.id)).toEqual([lamp.id]);
    expect((await api.get(sf('/products?minPrice=50000'))).body.data.map((p) => p.id)).toEqual([sofa.id]);
    expect((await api.get(sf('/products?sort=price_asc'))).body.data.map((p) => p.id)).toEqual([lamp.id, sofa.id]);
    expect((await api.get(sf('/products?sort=price_desc&limit=1'))).body).toMatchObject({ data: [{ id: sofa.id }], meta: { total: 2, totalPages: 2 } });
    expect((await api.get(sf('/products?minPrice=10&maxPrice=5'))).status).toBe(400);
  });

  it('shows a product with variants and availability; hides drafts', async () => {
    const res = await api.get(sf(`/products/${sofa.id}`));
    expect(res.status).toBe(200);
    expect(res.body.data.categories).toEqual([expect.objectContaining({ slug: `living-${RUN}` })]);
    expect(res.body.data.variants).toEqual([
      expect.objectContaining({ id: sofaBlue.id, price: '45000.00', inStock: true }),
      expect.objectContaining({ id: sofaRed.id, price: '52000.00', inStock: false }),
    ]);
    const draft = await prisma.product.findFirst({ where: { tenantId: tenantA.id, name: `Secret Draft ${RUN}` } });
    expect((await api.get(sf(`/products/${draft.id}`))).status).toBe(404);
    expect((await api.get(sf(`/products/${sofa.id}`, slugB))).status).toBe(404);
  });

  it('lists active categories', async () => {
    const res = await api.get(sf('/categories'));
    expect(res.body.data).toEqual([expect.objectContaining({ name: 'Living room', slug: `living-${RUN}`, parentId: null })]);
  });
});

describe('Phase 32 — shopper accounts', () => {
  const email = `sam-${RUN}@shop.test`;
  let session;

  it('signs up through the emailed code; no login before the password is set', async () => {
    const reg = await api.post(sf('/auth/register'), null, { email, firstName: 'Sam', lastName: 'Shopper' });
    expect(reg.status).toBe(202);
    expect(reg.body.data.devToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await api.post(sf('/auth/login'), null, { email, password: SHOPPER_PASSWORD })).status).toBe(401);

    const set = await api.post(sf('/auth/set-password'), null, { token: reg.body.data.devToken, password: SHOPPER_PASSWORD });
    expect(set.status).toBe(200);
    expect(set.body.data.customer).toMatchObject({ email, emailVerified: true });
    expect((await api.post(sf('/auth/set-password'), null, { token: reg.body.data.devToken, password: SHOPPER_PASSWORD })).status).toBe(400);
  });

  it('answers registration the same way when the account exists, without issuing a new code', async () => {
    const again = await api.post(sf('/auth/register'), null, { email, firstName: 'Mallory', lastName: 'X' });
    expect(again.status).toBe(202);
    expect(again.body.data.devToken).toBeUndefined();
    expect(again.body.data.message).toBe('If the email can be used, a link to set your password is on its way.');
  });

  it('logs in; wrong password and unknown email fail identically', async () => {
    const res = await api.post(sf('/auth/login'), null, { email: email.toUpperCase(), password: SHOPPER_PASSWORD });
    expect(res.status).toBe(200);
    session = res.body.data;
    const wrong = await api.post(sf('/auth/login'), null, { email, password: 'Nope#Nope123' });
    const unknown = await api.post(sf('/auth/login'), null, { email: `ghost-${RUN}@shop.test`, password: SHOPPER_PASSWORD });
    for (const r of [wrong, unknown]) expect(r.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  });

  it('accounts are per store: the same email is a different account elsewhere', async () => {
    expect((await api.post(sf('/auth/login', slugB), null, { email, password: SHOPPER_PASSWORD })).status).toBe(401);
    const other = await api.get(sf('/account', slugB), session.accessToken);
    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe('WRONG_STORE');
  });

  it('keeps shopper and staff tokens apart', async () => {
    const staffApi = await api.get('/customers', session.accessToken);
    expect(staffApi.status).toBe(403);
    expect(staffApi.body.error.code).toBe('CUSTOMER_TOKEN_FORBIDDEN');
    const staffOnStore = await api.get(sf('/account'), A);
    expect(staffOnStore.status).toBe(403);
    expect(staffOnStore.body.error.code).toBe('CUSTOMER_AUTH_REQUIRED');
  });

  it('rotates refresh tokens and ends the session when an old one is replayed', async () => {
    const first = await api.post(sf('/auth/refresh'), null, { refreshToken: session.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.data.sessionId).toBe(session.sessionId);
    const replay = await api.post(sf('/auth/refresh'), null, { refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);
    expect((await api.post(sf('/auth/refresh'), null, { refreshToken: first.body.data.refreshToken })).status).toBe(401);
    expect((await api.get(sf('/account'), first.body.data.accessToken)).status).toBe(401);
  });

  it('logout ends access immediately', async () => {
    const live = (await api.post(sf('/auth/login'), null, { email, password: SHOPPER_PASSWORD })).body.data;
    expect((await api.get(sf('/account'), live.accessToken)).status).toBe(200);
    expect((await api.post(sf('/auth/logout'), null, { refreshToken: live.refreshToken })).status).toBe(200);
    const after = await api.get(sf('/account'), live.accessToken);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
  });

  it('password reset signs out every other session', async () => {
    const before = (await api.post(sf('/auth/login'), null, { email, password: SHOPPER_PASSWORD })).body.data;
    const forgot = await api.post(sf('/auth/forgot-password'), null, { email });
    expect(forgot.status).toBe(202);
    expect((await api.post(sf('/auth/forgot-password'), null, { email: `ghost-${RUN}@shop.test` })).body.data.devToken).toBeUndefined();
    const reset = await api.post(sf('/auth/set-password'), null, { token: forgot.body.data.devToken, password: 'Changed#Pass456' });
    expect(reset.status).toBe(200);
    expect((await api.get(sf('/account'), before.accessToken)).status).toBe(401);
    expect((await api.get(sf('/account'), reset.body.data.accessToken)).status).toBe(200);
  });

  it('a staff-created customer claims their record (and history) only through the emailed code', async () => {
    const staffMade = (await api.post('/customers', A, { email: `walkin-${RUN}@shop.test`, firstName: 'Walk', lastName: 'In' })).body.data;
    await api.post('/orders', A, { customerId: staffMade.id, items: [{ productVariantId: lampVariant.id, warehouseId, quantity: 1 }] });
    const claimed = await signUp(`walkin-${RUN}@shop.test`);
    expect(claimed.customer.id).toBe(staffMade.id);
    const orders = await api.get(sf('/account/orders'), claimed.accessToken);
    expect(orders.body.meta.total).toBe(1);

    // Once the shopper has a password, staff reads of the customer must not carry the hash
    const detail = await api.get(`/customers/${staffMade.id}`, A);
    expect(detail.status).toBe(200);
    expect(detail.body.data).not.toHaveProperty('passwordHash');
    const list = await api.get(`/customers?search=walkin-${RUN}`, A);
    expect(list.body.data[0].id).toBe(staffMade.id);
    expect(list.body.data[0]).not.toHaveProperty('passwordHash');
  });

  it('profile and addresses', async () => {
    const me = await signUp(`addr-${RUN}@shop.test`);
    expect((await api.patch(sf('/account'), me.accessToken, { firstName: 'Samira', phone: '+91 9' })).body.data).toMatchObject({ firstName: 'Samira', phone: '+91 9' });
    const created = await api.post(sf('/account/addresses'), me.accessToken, { type: 'SHIPPING', line1: '1 Lake Rd', city: 'Pune', country: 'in' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ isDefault: true, country: 'IN' });
    expect((await api.patch(sf(`/account/addresses/${created.body.data.id}`), me.accessToken, { city: 'Mumbai' })).body.data.city).toBe('Mumbai');
    expect((await api.get(sf('/account/addresses'), me.accessToken)).body.data).toHaveLength(1);
    const other = await signUp(`addr2-${RUN}@shop.test`);
    expect((await api.delete(sf(`/account/addresses/${created.body.data.id}`), other.accessToken)).status).toBe(404);
    expect((await api.delete(sf(`/account/addresses/${created.body.data.id}`), me.accessToken)).status).toBe(200);
  });
});

describe('Phase 32 — cart, checkout and order tracking', () => {
  let shopper;
  let address;
  let placed;

  beforeAll(async () => {
    shopper = await signUp(`buyer-${RUN}@shop.test`);
    address = (await api.post(sf('/account/addresses'), shopper.accessToken, { type: 'SHIPPING', line1: '9 Market St', city: 'Hyderabad', country: 'IN' })).body.data;
  });

  it('prices the cart on the server and validates stock', async () => {
    const add = await api.put(sf(`/cart/items/${lampVariant.id}`), shopper.accessToken, { quantity: 2 });
    expect(add.status).toBe(200);
    await api.put(sf(`/cart/items/${sofaBlue.id}`), shopper.accessToken, { quantity: 1 });
    const cart = (await api.get(sf('/cart'), shopper.accessToken)).body.data;
    expect(cart).toMatchObject({ itemCount: 3, subtotal: '47598.00', currency: 'INR', readyForCheckout: true });
    expect(cart.items.find((i) => i.variantId === lampVariant.id)).toMatchObject({ unitPrice: '1299.00', quantity: 2, lineTotal: '2598.00', available: true });

    const tooMany = await api.put(sf(`/cart/items/${sofaBlue.id}`), shopper.accessToken, { quantity: 6 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await api.put(sf(`/cart/items/${sofaRed.id}`), shopper.accessToken, { quantity: 1 })).status).toBe(409);
    const draft = await prisma.productVariant.findFirst({ where: { tenantId: tenantA.id, sku: `HALF-${RUN}` } });
    expect((await api.put(sf(`/cart/items/${draft.id}`), shopper.accessToken, { quantity: 1 })).status).toBe(404);
  });

  it('flags lines that stopped being sellable and blocks checkout until fixed', async () => {
    await prisma.productVariant.update({ where: { id: sofaBlue.id }, data: { status: 'INACTIVE' } });
    const cart = (await api.get(sf('/cart'), shopper.accessToken)).body.data;
    expect(cart.readyForCheckout).toBe(false);
    expect(cart.items.find((i) => i.variantId === sofaBlue.id)).toMatchObject({ available: false, issue: 'UNAVAILABLE' });
    expect(cart.subtotal).toBe('2598.00');
    const blocked = await api.post(sf('/checkout'), shopper.accessToken, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CART_NOT_READY');
    await prisma.productVariant.update({ where: { id: sofaBlue.id }, data: { status: 'ACTIVE' } });
  });

  it('checks out: server totals, address snapshot, stock reserved, payment started, cart emptied', async () => {
    const res = await api.post(sf('/checkout'), shopper.accessToken, { shippingAddressId: address.id });
    expect(res.status).toBe(201);
    placed = res.body.data.order;
    expect(placed).toMatchObject({ status: 'PENDING', currency: 'INR', subtotal: '47598.00', total: '47598.00', shippingAddress: { line1: '9 Market St', addressId: address.id } });
    expect(placed.number).toBe(placed.id.slice(0, 8).toUpperCase());
    expect(placed.items).toHaveLength(2);
    expect(placed.timeline).toEqual([expect.objectContaining({ status: 'PENDING' })]);
    expect(res.body.data.payment).toMatchObject({ status: 'PENDING', amount: '47598.00', currency: 'INR' });
    expect(JSON.stringify(res.body)).not.toMatch(/warehouse|costPrice|createdBy|tenantId/i);

    expect((await api.get(sf('/cart'), shopper.accessToken)).body.data.items).toEqual([]);
    const stock = await prisma.inventory.findFirst({ where: { productVariantId: sofaBlue.id, warehouseId } });
    expect(stock.quantity).toBe(4);
    const staffView = await api.get(`/orders/${placed.id}`, A);
    expect(staffView.body.data.metadata).toMatchObject({ source: 'storefront' });
    expect((await api.post(sf('/checkout'), shopper.accessToken, {})).status).toBe(409);
  });

  it('tracks the order: list, detail with timeline and payments, owner only', async () => {
    await api.patch(`/orders/${placed.id}/status`, A, { status: 'CONFIRMED' });
    const detail = (await api.get(sf(`/account/orders/${placed.id}`), shopper.accessToken)).body.data;
    expect(detail.timeline.map((t) => t.status)).toEqual(['PENDING', 'CONFIRMED']);
    expect(detail.payments).toEqual([expect.objectContaining({ status: 'PENDING' })]);
    const list = await api.get(sf('/account/orders?status=CONFIRMED'), shopper.accessToken);
    expect(list.body.data.map((o) => o.id)).toEqual([placed.id]);

    const stranger = await signUp(`stranger-${RUN}@shop.test`);
    expect((await api.get(sf(`/account/orders/${placed.id}`), stranger.accessToken)).status).toBe(404);
    expect((await api.post(sf(`/account/orders/${placed.id}/pay`), stranger.accessToken, {})).status).toBe(404);
  });

  it('does not start a second payment while one is pending', async () => {
    const res = await api.post(sf(`/account/orders/${placed.id}/pay`), shopper.accessToken, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_ALREADY_PENDING');
  });
});

describe('Phase 32 — domain verification and host resolution', () => {
  const domain = `shop-${RUN}.example.com`;
  let claimA;
  let claimB;

  afterEach(() => jest.restoreAllMocks());

  it('an unverified claim does not reserve the domain or resolve to a store', async () => {
    claimA = (await api.post('/workspace/domains', A, { domain })).body.data;
    expect(claimA.verification).toEqual({ type: 'TXT', name: `_pulseops-verify.${domain}`, value: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const b = await api.post('/workspace/domains', B, { domain });
    expect(b.status).toBe(201);
    claimB = b.body.data;
    expect(claimB.verification.value).not.toBe(claimA.verification.value);
    expect((await api.get(`/storefront/resolve?host=${domain}`)).status).toBe(404);
  });

  it('fails verification when the TXT record is missing or wrong', async () => {
    jest.spyOn(dns.promises, 'resolveTxt').mockRejectedValueOnce(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    const missing = await api.post(`/workspace/domains/${claimA.id}/verify`, A, {});
    expect(missing.status).toBe(422);
    expect(missing.body.error).toMatchObject({ code: 'DOMAIN_VERIFICATION_FAILED', details: { expected: claimA.verification } });

    jest.spyOn(dns.promises, 'resolveTxt').mockResolvedValueOnce([[claimB.verification.value]]);
    expect((await api.post(`/workspace/domains/${claimA.id}/verify`, A, {})).status).toBe(422);
  });

  it('the first tenant to verify keeps the domain; other claims are dropped', async () => {
    const spy = jest.spyOn(dns.promises, 'resolveTxt').mockResolvedValueOnce([['unrelated'], [claimA.verification.value.slice(0, 16), claimA.verification.value.slice(16)]]);
    const res = await api.post(`/workspace/domains/${claimA.id}/verify`, A, {});
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(`_pulseops-verify.${domain}`);
    expect(res.body.data).toMatchObject({ verified: true, verification: null });

    expect((await api.get('/workspace/domains', B)).body.data).toEqual([]);
    const late = await api.post('/workspace/domains', B, { domain });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('DOMAIN_TAKEN');
  });

  it('resolves a verified host (any case, with port) to its store', async () => {
    const res = await api.get(`/storefront/resolve?host=${domain.toUpperCase()}:443`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ slug: slugA, name: 'Phase 32 a' });
    expect((await api.get('/storefront/resolve?host=nope.example.com')).status).toBe(404);
  });
});
