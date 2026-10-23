import { jest } from '@jest/globals';
import request from 'supertest';
import { Queue } from 'bullmq';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { encryptSecret, decryptSecret } from '../../src/common/crypto/secret-box.js';
import { sign, toMinorUnits } from '../../src/integrations/payment/razorpay.client.js';
import { SmtpEmailProvider, createEmailProvider } from '../../src/integrations/email/email.provider.js';
import { IntegrationError } from '../../src/integrations/errors/integration-error.js';
import { getBullMqRedisConnection } from '../../src/jobs/connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX } from '../../src/jobs/jobs.config.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase35#Pass123';
const SHOPPER_PASSWORD = 'Shopper#Pass123';
const KEY_ID = 'rzp_test_Phase35Key01';
const KEY_SECRET = 'phase35-key-secret-abcdef';
const WEBHOOK_SECRET = 'phase35-webhook-secret-xyz';

let platformAdmin;
let tenantA;
let tenantB;
let A;
let slugA;
let lampVariant;

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};
const sf = (path = '', slug = slugA) => `/storefront/${slug}${path}`;

// ── A fake Razorpay behind fetch: records every call, answers like the real API ──
const razorpayCalls = [];
let razorpaySeq = 0;
const realFetch = globalThis.fetch;
function fakeRazorpay(url, init = {}) {
  const path = url.slice(env.RAZORPAY_API_URL.length);
  const [keyId, keySecret] = Buffer.from((init.headers?.Authorization || '').replace('Basic ', ''), 'base64').toString().split(':');
  const body = init.body ? JSON.parse(init.body) : null;
  razorpayCalls.push({ method: init.method, path, keyId, keySecret, body });
  const json = (status, data) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  if (keySecret !== KEY_SECRET) return json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
  if (init.method === 'GET' && path.startsWith('/orders')) return json(200, { entity: 'collection', count: 0, items: [] });
  if (init.method === 'POST' && path === '/orders') return json(200, { id: `order_P35${RUN}${++razorpaySeq}`, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' });
  const refund = path.match(/^\/payments\/([^/]+)\/refund$/);
  if (init.method === 'POST' && refund) return json(200, { id: `rfnd_P35${++razorpaySeq}`, entity: 'refund', payment_id: decodeURIComponent(refund[1]), amount: body.amount, status: 'processed' });
  return json(404, { error: { description: 'not found' } });
}
const callsTo = (method, path) => razorpayCalls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));

async function login(email) {
  return (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
}

async function createTenant(label) {
  const slug = `phase35-${label}-${RUN}`;
  const email = `p35-${label}-${RUN}@test.local`;
  const res = await api.post('/platform/tenants', platformAdmin.token, { name: `Phase 35 ${label}`, slug, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: label } });
  return { id: res.body.data.tenant.id, slug, email, token: await login(email) };
}

async function signUp(email) {
  const reg = await api.post(sf('/auth/register'), null, { email, firstName: 'Sam', lastName: 'Shopper' });
  const set = await api.post(sf('/auth/set-password'), null, { token: reg.body.data.devToken, password: SHOPPER_PASSWORD });
  return set.body.data.accessToken;
}

async function placeOrder(shopper, quantity = 1) {
  await api.put(sf(`/cart/items/${lampVariant.id}`), shopper, { quantity });
  const res = await api.post(sf('/checkout'), shopper, {});
  expect(res.status).toBe(201);
  return res.body.data;
}

const checkoutSignature = (orderId, paymentId, secret = KEY_SECRET) => sign(secret, `${orderId}|${paymentId}`);

function webhook(tenantId, event, { secret = WEBHOOK_SECRET, eventId = `evt_${RUN}_${++razorpaySeq}` } = {}) {
  const raw = JSON.stringify(event);
  return request(app).post(`/api/v1/payments/webhook/razorpay/${tenantId}`)
    .set('Content-Type', 'application/json').set('X-Razorpay-Signature', sign(secret, raw)).set('X-Razorpay-Event-Id', eventId)
    .send(raw);
}
const capturedEvent = (orderId, paymentId, amount) => ({
  entity: 'event', event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, entity: 'payment', order_id: orderId, amount, currency: 'INR', status: 'captured' } } },
});

beforeAll(async () => {
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => (String(url).startsWith(env.RAZORPAY_API_URL) ? fakeRazorpay(String(url), init) : realFetch(url, init)));
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p35_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  ({ token: A, slug: slugA } = tenantA);
  await api.patch('/workspace/settings', A, { currency: 'INR' });
  const warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: `P35-${RUN}`, isDefault: true })).body.data.id;
  const lamp = (await api.post('/products', A, { name: `Moon Lamp ${RUN}`, status: 'ACTIVE' })).body.data;
  lampVariant = (await api.post(`/products/${lamp.id}/variants`, A, { sku: `P35-LAMP-${RUN}`, price: '1299.50', status: 'ACTIVE' })).body.data;
  await api.post('/inventory/adjust', A, { variantId: lampVariant.id, warehouseId, quantityChanged: 50, reason: 'INIT' });
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

describe('Phase 35 — secrets at rest', () => {
  it('encrypts with AES-GCM: random IV, round-trips, and a tampered value reads as null', () => {
    const a = encryptSecret('s3cret');
    const b = encryptSecret('s3cret');
    expect(a).not.toBe(b);
    expect(a).not.toContain('s3cret');
    expect(decryptSecret(a)).toBe('s3cret');
    const [v, iv, tag, data] = a.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'))).toBeNull();
    expect(decryptSecret('garbage')).toBeNull();
  });

  it('converts amounts to minor units by currency', () => {
    expect(toMinorUnits('1299.50', 'INR')).toBe(129950);
    expect(toMinorUnits('0.29', 'USD')).toBe(29);
    expect(toMinorUnits('500', 'JPY')).toBe(500);
    expect(toMinorUnits('1.5', 'KWD')).toBe(1500);
  });
});

describe('Phase 35 — connecting the shop\'s Razorpay account', () => {
  it('starts unconfigured; the storefront says online payment is off', async () => {
    const res = await api.get('/workspace/payment-gateway', A);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'razorpay', configured: false, enabled: false, webhookUrlPath: `/api/v1/payments/webhook/razorpay/${tenantA.id}` });
    expect((await api.get(sf())).body.data.onlinePayment).toEqual({ provider: 'razorpay', enabled: false });
  });

  it('rejects malformed key ids and keys Razorpay refuses', async () => {
    expect((await api.put('/workspace/payment-gateway', A, { keyId: 'pk_live_123', keySecret: KEY_SECRET })).status).toBe(400);
    const res = await api.put('/workspace/payment-gateway', A, { keyId: KEY_ID, keySecret: 'not-the-right-secret' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RAZORPAY_KEYS_INVALID');
    expect((await api.get('/workspace/payment-gateway', A)).body.data.configured).toBe(false);
  });

  it('saves working keys encrypted and never returns the secrets', async () => {
    const res = await api.put('/workspace/payment-gateway', A, { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: true, enabled: true, keyId: KEY_ID, mode: 'test', webhookSecretSet: true });
    expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
    expect(JSON.stringify((await api.get('/workspace/payment-gateway', A)).body)).not.toContain(KEY_SECRET);

    const row = await prisma.tenantPaymentGateway.findUnique({ where: { tenantId: tenantA.id } });
    expect(row.keySecretEncrypted).not.toContain(KEY_SECRET);
    expect(decryptSecret(row.keySecretEncrypted)).toBe(KEY_SECRET);
    expect(decryptSecret(row.webhookSecretEncrypted)).toBe(WEBHOOK_SECRET);

    const audit = await prisma.auditLog.findFirst({ where: { tenantId: tenantA.id, resource: 'payment_gateway' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit)).not.toContain(KEY_SECRET);
    expect((await api.get(sf())).body.data.onlinePayment.enabled).toBe(true);
  });

  it('is per shop: another tenant sees its own (empty) gateway', async () => {
    expect((await api.get('/workspace/payment-gateway', tenantB.token)).body.data.configured).toBe(false);
  });
});

describe('Phase 35 — paying an order with Razorpay', () => {
  let shopper;
  let placed;

  beforeAll(async () => {
    shopper = await signUp(`p35-shopper-${RUN}@test.local`);
  });

  it('checkout creates a Razorpay order on the shop\'s account for the server-priced total', async () => {
    const before = callsTo('POST', '/orders').length;
    placed = await placeOrder(shopper, 2);
    const { payment } = placed;
    expect(payment).toMatchObject({ status: 'PENDING', provider: 'razorpay', amount: '2599.00', currency: 'INR' });
    expect(payment.checkout).toMatchObject({ provider: 'razorpay', keyId: KEY_ID, orderId: payment.providerPaymentId, amount: 259900, currency: 'INR', name: 'Phase 35 a' });
    expect(payment.checkout.prefill).toMatchObject({ email: `p35-shopper-${RUN}@test.local`, name: 'Sam Shopper' });
    const calls = callsTo('POST', '/orders');
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)).toMatchObject({ keyId: KEY_ID, keySecret: KEY_SECRET, body: { amount: 259900, currency: 'INR', receipt: placed.order.id, payment_capture: 1 } });
    expect(JSON.stringify(placed)).not.toContain(KEY_SECRET);
  });

  it('pressing Pay again reuses the same Razorpay order', async () => {
    const before = callsTo('POST', '/orders').length;
    const res = await api.post(sf(`/account/orders/${placed.order.id}/pay`), shopper);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: placed.payment.id, checkout: { orderId: placed.payment.providerPaymentId } });
    expect(callsTo('POST', '/orders').length).toBe(before);
  });

  it('refuses a forged or mismatched checkout result', async () => {
    const { id, providerPaymentId: orderId } = placed.payment;
    const forged = await api.post(sf(`/account/payments/${id}/verify`), shopper, { razorpayOrderId: orderId, razorpayPaymentId: 'pay_forged', razorpaySignature: checkoutSignature(orderId, 'pay_forged', 'wrong-secret') });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');
    const otherOrder = await api.post(sf(`/account/payments/${id}/verify`), shopper, { razorpayOrderId: 'order_other', razorpayPaymentId: 'pay_1', razorpaySignature: checkoutSignature('order_other', 'pay_1') });
    expect(otherOrder.status).toBe(400);
    expect((await api.post(sf(`/account/payments/${id}/verify`), shopper, { razorpayOrderId: orderId, razorpayPaymentId: 'pay_1', razorpaySignature: 'nothex' })).status).toBe(400);
    const stranger = await signUp(`p35-stranger-${RUN}@test.local`);
    expect((await api.post(sf(`/account/payments/${id}/verify`), stranger, { razorpayOrderId: orderId, razorpayPaymentId: 'pay_1', razorpaySignature: checkoutSignature(orderId, 'pay_1') })).status).toBe(404);
    expect((await prisma.payment.findUnique({ where: { id } })).status).toBe('PENDING');
  });

  it('a valid signature completes the payment, once', async () => {
    const { id, providerPaymentId: orderId } = placed.payment;
    const body = { razorpayOrderId: orderId, razorpayPaymentId: `pay_P35${RUN}`, razorpaySignature: checkoutSignature(orderId, `pay_P35${RUN}`) };
    const res = await api.post(sf(`/account/payments/${id}/verify`), shopper, body);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect((await api.post(sf(`/account/payments/${id}/verify`), shopper, body)).body.data.status).toBe('COMPLETED');

    const stored = await prisma.payment.findUnique({ where: { id }, include: { transactions: true } });
    expect(stored.metadata).toMatchObject({ razorpayPaymentId: `pay_P35${RUN}`, paidVia: 'checkout' });
    expect(stored.transactions.filter((t) => t.status === 'COMPLETED')).toHaveLength(1);
    // Paying a paid order again is refused
    expect((await api.post(sf(`/account/orders/${placed.order.id}/pay`), shopper)).status).toBe(409);
  });

  it('a staff refund goes back through the shop\'s Razorpay account', async () => {
    const res = await api.post(`/payments/${placed.payment.id}/refund`, A, { amount: '599.00', reason: 'One lamp returned' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PARTIALLY_REFUNDED');
    const call = callsTo('POST', /\/refund$/).at(-1);
    expect(call).toMatchObject({ path: `/payments/pay_P35${RUN}/refund`, keyId: KEY_ID, body: { amount: 59900 } });
    expect(res.body.data.refunds[0].providerRefundId).toMatch(/^rfnd_P35/);
  });

  it('the webhook confirms a payment when the shopper never came back, and repeats change nothing', async () => {
    const { payment } = await placeOrder(shopper);
    const event = capturedEvent(payment.providerPaymentId, `pay_wh_${RUN}`, payment.checkout.amount);
    const eventId = `evt_once_${RUN}`;
    const first = await webhook(tenantA.id, event, { eventId });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ handled: true, duplicate: false, status: 'COMPLETED' });
    const again = await webhook(tenantA.id, event, { eventId });
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    const stored = await prisma.payment.findUnique({ where: { id: payment.id }, include: { transactions: true } });
    expect(stored).toMatchObject({ status: 'COMPLETED', metadata: expect.objectContaining({ razorpayPaymentId: `pay_wh_${RUN}`, paidVia: 'webhook' }) });
    expect(stored.transactions.filter((t) => t.status === 'COMPLETED')).toHaveLength(1);
  });

  it('the webhook rejects bad signatures, other shops\' URLs, and does not trust a wrong amount', async () => {
    const { payment } = await placeOrder(shopper);
    const event = capturedEvent(payment.providerPaymentId, `pay_x_${RUN}`, payment.checkout.amount);
    expect((await webhook(tenantA.id, event, { secret: 'not-the-webhook-secret' })).status).toBe(401);
    expect((await webhook(tenantB.id, event)).status).toBe(401);
    expect((await webhook('not-a-uuid', event)).status).toBe(400);

    const cheap = await webhook(tenantA.id, capturedEvent(payment.providerPaymentId, `pay_cheap_${RUN}`, 100));
    expect(cheap.status).toBe(200);
    expect(cheap.body.data.handled).toBe(false);
    const failed = await webhook(tenantA.id, { event: 'payment.failed', payload: { payment: { entity: { id: `pay_f_${RUN}`, order_id: payment.providerPaymentId, amount: payment.checkout.amount } } } });
    expect(failed.body.data.handled).toBe(false);
    expect((await prisma.payment.findUnique({ where: { id: payment.id } })).status).toBe('PENDING');
  });

  it('switched off, the store falls back to a pending payment the shop settles by hand', async () => {
    expect((await api.patch('/workspace/payment-gateway', A, { enabled: false })).body.data.enabled).toBe(false);
    const { payment } = await placeOrder(shopper);
    expect(payment.provider).not.toBe('razorpay');
    expect(payment.checkout).toBeNull();
    expect((await api.get(sf())).body.data.onlinePayment.enabled).toBe(false);
    await api.patch('/workspace/payment-gateway', A, { enabled: true });
  });

  it('needs a signed-in staff user; disconnecting removes the keys', async () => {
    expect((await api.put('/workspace/payment-gateway', null, { keyId: KEY_ID, keySecret: KEY_SECRET })).status).toBe(401);
    expect((await api.delete('/workspace/payment-gateway', A)).status).toBe(204);
    expect(await prisma.tenantPaymentGateway.findUnique({ where: { tenantId: tenantA.id } })).toBeNull();
    expect((await api.delete('/workspace/payment-gateway', A)).status).toBe(404);
  });
});

describe('Phase 35 — email over SMTP', () => {
  it('the SMTP provider builds the message with EMAIL_FROM (jsonTransport without SMTP_URL)', async () => {
    const provider = new SmtpEmailProvider({ url: '', from: 'Shop <shop@example.com>' });
    const result = await provider.send({ to: 'x@example.com', subject: 'Hello', text: 'Body', tenantId: 't' });
    expect(result.status).toBe('sent');
    const sent = await provider.transport.sendMail({ from: provider.from, to: 'x@example.com', subject: 'Hello', text: 'Body' });
    expect(JSON.parse(sent.message)).toMatchObject({ from: { address: 'shop@example.com' }, subject: 'Hello', text: 'Body' });
    expect(createEmailProvider('smtp')).toBeInstanceOf(SmtpEmailProvider);
  });

  it('SMTP 5xx answers are permanent failures; connection errors are retried', async () => {
    const failing = (err) => new SmtpEmailProvider({ transport: { sendMail: () => Promise.reject(err) } });
    const permanent = await failing(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 })).send({ to: 'a@b.c', subject: 's', text: 't' }).catch((e) => e);
    expect(permanent).toBeInstanceOf(IntegrationError);
    expect(permanent.isRetryable()).toBe(false);
    const transient = await failing(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' })).send({ to: 'a@b.c', subject: 's', text: 't' }).catch((e) => e);
    expect(transient.isRetryable()).toBe(true);
  });

  it('forgot-password emails staff a reset link carrying the token', async () => {
    const res = await api.post('/auth/forgot-password', null, { email: tenantA.email, tenantSlug: tenantA.slug });
    expect(res.status).toBe(200);
    const token = res.body.data.devToken;
    expect(token).toBeTruthy();

    const connection = getBullMqRedisConnection();
    if (connection) {
      const queue = new Queue(QUEUE_NAMES.EMAIL, { connection, prefix: QUEUE_PREFIX });
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized']);
      const job = jobs.find((j) => j?.data?.to === tenantA.email && j.data.template === 'auth.reset_password');
      expect(job).toBeTruthy();
      expect(job.data.variables.link).toBe(`${env.APP_URL}/reset-password?token=${token}`);
      expect(job.data.text).toContain(job.data.variables.link);
      expect(job.data.subject).toBe('Reset your Phase 35 a password');
      await queue.close();
    } else {
      // No Redis: sent inline through the (mock) provider
      expect(createEmailProvider().sent.some((m) => m.to === tenantA.email && m.subject === 'Reset your Phase 35 a password')).toBe(true);
    }
  });
});
