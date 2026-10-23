import { jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { processGenerateReport } from '../../src/jobs/processors/report.processor.js';
import { processCalculateAnalytics } from '../../src/jobs/processors/analytics.processor.js';
import { processSendNotification } from '../../src/jobs/processors/notification.processor.js';
import { processSendEmail } from '../../src/jobs/processors/email.processor.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { EmailService } from '../../src/integrations/email/email.service.js';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase31#Pass123';

let platformAdmin;
let tenantA;
let tenantB;
let A;
let B;
let noRole;
let ordersOnly;
let warehouseId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

async function login(email) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

async function createTenant(label) {
  const res = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: `Phase 31 ${label}`, slug: `phase31-${label}-${RUN}`, status: 'ACTIVE', admin: { email: `p31-${label}-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: label } });
  return { id: res.body.data.tenant.id, token: await login(`p31-${label}-${RUN}@test.local`) };
}

async function staffWith(label, permissionNames) {
  const email = `p31-${label}-${RUN}@test.local`;
  const reg = await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, firstName: 'Staff', lastName: label, tenantId: tenantA.id });
  if (permissionNames.length) {
    const role = await api.post('/roles', A, { name: `p31-${label}-${RUN}` });
    const perms = (await api.get('/permissions?limit=200', A)).body.data.filter((p) => permissionNames.includes(p.name));
    await api.post(`/roles/${role.body.data.id}/permissions`, A, { permissionIds: perms.map((p) => p.id) });
    await api.post(`/users/${reg.body.data.user?.id ?? reg.body.data.id}/roles`, A, { roleIds: [role.body.data.id] });
  }
  return login(email);
}

// Stands in for the worker process: run the queued job for a report.
async function runReport(reportId, tenantId = tenantA.id) {
  await processGenerateReport({ tenantId, reportId }, { jobId: `test-${reportId}` });
  return (await api.get(`/reports/${reportId}`, tenantId === tenantA.id ? A : B)).body.data;
}

async function downloadCsv(reportId, token = A) {
  const link = await api.get(`/reports/${reportId}/download`, token);
  expect(link.status).toBe(200);
  const file = await request(app).get(link.body.data.url).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  });
  return { link: link.body.data, file };
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p31_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  A = tenantA.token;
  B = tenantB.token;
  noRole = await staffWith('norole', []);
  ordersOnly = await staffWith('orders', ['report:create', 'report:read', 'order:read']);

  warehouseId = (await api.post('/warehouses', A, { name: 'Main', code: `P31-${RUN}` })).body.data.id;
  const productId = (await api.post('/products', A, { name: `P31 product ${RUN}`, status: 'ACTIVE' })).body.data.id;
  const variantId = (await api.post(`/products/${productId}/variants`, A, { sku: `P31-${RUN}`, price: '12.50', status: 'ACTIVE' })).body.data.id;
  await api.post('/inventory/adjust', A, { variantId, warehouseId, quantityChanged: 40, reason: 'INIT' });

  const plain = (await api.post('/customers', A, { email: `plain-${RUN}@shop.test`, firstName: 'Bea', lastName: 'Buyer, Jr.' })).body.data;
  await api.post('/customers', A, { email: `evil-${RUN}@shop.test`, firstName: '=HYPERLINK("http://x")', lastName: 'Quote"d' });
  for (let i = 0; i < 2; i++) {
    await api.post('/orders', A, { customerId: plain.id, items: [{ productVariantId: variantId, warehouseId, quantity: 1 }] });
  }
});

afterAll(async () => {
  jest.restoreAllMocks();
  const tenantIds = [tenantA?.id, tenantB?.id].filter(Boolean);
  await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 31 — reports', () => {
  it('requests an ORDERS report (202, PENDING) that the worker turns into a downloadable CSV', async () => {
    const res = await api.post('/reports', A, { type: 'orders' });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ type: 'ORDERS', format: 'csv' });
    // PENDING when queued for the worker; COMPLETED when Redis is unavailable and it ran inline
    expect(['PENDING', 'COMPLETED']).toContain(res.body.data.status);

    const done = await runReport(res.body.data.id);
    expect(done).toMatchObject({ status: 'COMPLETED', rowCount: 2 });
    expect(done.sizeBytes).toBeGreaterThan(0);

    const { link, file } = await downloadCsv(done.id);
    expect(link.fileName).toMatch(/^orders-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.csv$/);
    expect(file.headers['content-type']).toMatch(/^text\/csv/);
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
    const lines = file.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('orderId,createdAt,status,customerEmail,customerName,itemCount,subtotal,discountTotal,taxTotal,shippingTotal,total,currency');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`plain-${RUN}@shop.test,"Bea Buyer, Jr.",1,12.5`);
  });

  it('CUSTOMERS export escapes quotes and neutralises spreadsheet formulas', async () => {
    const report = (await api.post('/reports', A, { type: 'CUSTOMERS' })).body.data;
    const done = await runReport(report.id);
    expect(done.rowCount).toBe(2);
    const { file } = await downloadCsv(done.id);
    expect(file.body).toContain(`"'=HYPERLINK(""http://x"")","Quote""d"`);
    expect(file.body).toMatch(new RegExp(`plain-${RUN}@shop.test,Bea,"Buyer, Jr.",,[^,]+,2,25(\\.00)?`));
  });

  it('INVENTORY export can be filtered by warehouse', async () => {
    const report = (await api.post('/reports', A, { type: 'INVENTORY', filters: { warehouseId } })).body.data;
    const done = await runReport(report.id);
    expect(done.rowCount).toBe(1);
    const { file } = await downloadCsv(done.id);
    expect(file.body).toContain(`P31-${RUN},P31 product ${RUN},ACTIVE,P31-${RUN},Main,38`);
  });

  it('validates type and filters', async () => {
    expect((await api.post('/reports', A, { type: 'SALES' })).status).toBe(400);
    expect((await api.post('/reports', A, { type: 'INVENTORY', filters: { status: 'PENDING' } })).status).toBe(400);
    expect((await api.post('/reports', A, { type: 'ORDERS', filters: { from: '2026-10-10', to: '2026-10-01' } })).status).toBe(400);
    expect((await api.post('/reports', A, { type: 'ORDERS', filters: { from: '10/01/2026' } })).status).toBe(400);
    expect((await api.post('/reports', A, { type: 'ORDERS', filters: { status: 'SHIPPED', from: '2026-01-01' } })).status).toBe(202);
  });

  it('is not downloadable until it has been generated', async () => {
    const pending = await prisma.report.create({ data: { tenantId: tenantA.id, type: 'ORDERS' } });
    const res = await api.get(`/reports/${pending.id}/download`, A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REPORT_NOT_READY');
  });

  it('marks a report FAILED with a safe message when storage fails', async () => {
    const report = await prisma.report.create({ data: { tenantId: tenantA.id, type: 'ORDERS' } });
    const spy = jest.spyOn(StorageService.prototype, 'upload').mockRejectedValueOnce(new Error('disk full at /var/secret/path'));
    await expect(processGenerateReport({ tenantId: tenantA.id, reportId: report.id })).rejects.toThrow();
    spy.mockRestore();
    const failed = (await api.get(`/reports/${report.id}`, A)).body.data;
    expect(failed).toMatchObject({ status: 'FAILED', error: 'Report generation failed' });
    expect((await api.get(`/reports/${report.id}/download`, A)).status).toBe(409);
  });

  it('lists reports newest first with filters', async () => {
    const res = await api.get('/reports?type=ORDERS&status=COMPLETED', A);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.every((r) => r.type === 'ORDERS' && r.status === 'COMPLETED')).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1 });
  });

  it('needs report permissions plus read access to the data behind the report', async () => {
    expect((await api.post('/reports', noRole, { type: 'ORDERS' })).status).toBe(403);
    expect((await api.get('/reports', noRole)).status).toBe(403);
    expect((await api.post('/reports', ordersOnly, { type: 'ORDERS' })).status).toBe(202);
    const customers = await api.post('/reports', ordersOnly, { type: 'CUSTOMERS' });
    expect(customers.status).toBe(403);
    expect(customers.body.error.message).toBe('CUSTOMERS reports need customer:read');

    const adminCustomers = (await api.get('/reports?type=CUSTOMERS&status=COMPLETED', A)).body.data[0];
    expect((await api.get(`/reports/${adminCustomers.id}/download`, ordersOnly)).status).toBe(403);
  });

  it('keeps reports and their files inside the tenant', async () => {
    const report = (await api.get('/reports?status=COMPLETED', A)).body.data[0];
    expect((await api.get(`/reports/${report.id}`, B)).status).toBe(404);
    expect((await api.get(`/reports/${report.id}/download`, B)).status).toBe(404);
    expect((await api.get('/reports', B)).body.data).toEqual([]);
    const stored = await prisma.report.findUnique({ where: { id: report.id } });
    expect(stored.storageKey).toBe(`tenants/${tenantA.id}/reports/${report.id}.csv`);
    expect((await api.get(`/storage/file?key=${encodeURIComponent(stored.storageKey)}`, B)).status).toBe(403);
  });

  it('POST /jobs/reports creates the same kind of report', async () => {
    const res = await api.post('/jobs/reports', A, { reportType: 'inventory' });
    expect(res.status).toBe(202);
    expect(await prisma.report.findUnique({ where: { id: res.body.data.reportId } })).toMatchObject({ type: 'INVENTORY', tenantId: tenantA.id });
    expect((await api.post('/jobs/reports', A, { reportType: 'sales' })).status).toBe(400);
  });
});

describe('Phase 31 — analytics job', () => {
  it('computes the aggregate through the same cached service call the endpoint uses', async () => {
    const spy = jest.spyOn(AnalyticsService.prototype, '_cachedFetch');
    const result = await processCalculateAnalytics({ tenantId: tenantA.id, metric: 'revenue', filters: {} });
    expect(result).toMatchObject({ tenantId: tenantA.id, metric: 'revenue', cached: true });
    expect(spy).toHaveBeenCalledWith(tenantA.id, 'revenue', {}, expect.any(Function));
    spy.mockRestore();
    // With Redis the endpoint then answers from cache; without it every call is a MISS.
    expect(['HIT', 'MISS']).toContain((await api.get('/analytics/revenue', A)).headers['x-cache']);
  });

  it('rejects unknown metrics', async () => {
    expect((await api.post('/jobs/analytics', A, { metric: 'astrology' })).status).toBe(400);
    await expect(processCalculateAnalytics({ tenantId: tenantA.id, metric: 'astrology' })).rejects.toThrow(/metric/);
  });
});

describe('Phase 31 — notification templates', () => {
  let template;

  it('creates a template with declared variables (name normalised)', async () => {
    const res = await api.post('/notification-templates', A, {
      name: 'Order.Created', channel: 'IN_APP', subject: 'Order {{orderId}} placed', body: 'Total {{ total }} {{currency}}', variables: ['orderId', 'total', 'currency'],
    });
    expect(res.status).toBe(201);
    template = res.body.data;
    expect(template).toMatchObject({ name: 'order.created', channel: 'IN_APP', isActive: true, variables: ['orderId', 'total', 'currency'] });
  });

  it('rejects undeclared placeholders, missing subjects and duplicates', async () => {
    const undeclared = await api.post('/notification-templates', A, { name: 'x.one', channel: 'SMS', body: 'Hi {{name}}', variables: [] });
    expect(undeclared.status).toBe(400);
    expect((await api.post('/notification-templates', A, { name: 'x.two', channel: 'EMAIL', body: 'Hello', variables: [] })).status).toBe(400);
    expect((await api.post('/notification-templates', A, { name: 'x three', channel: 'SMS', body: 'Hello' })).status).toBe(400);
    expect((await api.post('/notification-templates', A, { name: 'x.four', channel: 'SMS', body: 'Hi', variables: ['a', 'a'] })).status).toBe(400);
    const dup = await api.post('/notification-templates', A, { name: 'order.created', channel: 'IN_APP', subject: 'S', body: 'B' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('TEMPLATE_EXISTS');
  });

  it('re-checks the whole template on update', async () => {
    expect((await api.patch(`/notification-templates/${template.id}`, A, { body: 'Hi {{customerName}}' })).status).toBe(400);
    const ok = await api.patch(`/notification-templates/${template.id}`, A, { body: 'Hi {{customerName}}, total {{total}}', variables: ['orderId', 'total', 'customerName'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.body).toBe('Hi {{customerName}}, total {{total}}');
  });

  it('previews with given variables and reports the missing ones', async () => {
    const res = await api.post(`/notification-templates/${template.id}/preview`, A, { variables: { orderId: 'A-1', total: 25 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ subject: 'Order A-1 placed', body: 'Hi , total 25', missingVariables: ['customerName'] });
  });

  it('lists and filters templates', async () => {
    await api.post('/notification-templates', A, { name: 'order.created', channel: 'EMAIL', subject: 'Your order {{orderId}}', body: 'Thanks! Total {{total}}', variables: ['orderId', 'total'] });
    const all = await api.get('/notification-templates', A);
    expect(all.body.data.map((t) => t.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
    const email = await api.get('/notification-templates?channel=EMAIL', A);
    expect(email.body.data).toHaveLength(1);
  });

  it('the notification processor renders the active template, else falls back to the job text', async () => {
    const job = { tenantId: tenantA.id, title: 'Fallback title', message: 'Fallback message', channel: 'IN_APP', template: 'order.created', variables: { orderId: 'A-2', total: '9.99', customerName: 'Bea' } };
    const rendered = await processSendNotification(job);
    expect(rendered.notification).toMatchObject({ title: 'Order A-2 placed', message: 'Hi Bea, total 9.99' });

    await api.patch(`/notification-templates/${template.id}`, A, { isActive: false });
    const fallback = await processSendNotification({ ...job, variables: { orderId: 'A-3' } });
    expect(fallback.notification).toMatchObject({ title: 'Fallback title', message: 'Fallback message' });
    await api.patch(`/notification-templates/${template.id}`, A, { isActive: true });
  });

  it('the email processor renders EMAIL templates', async () => {
    const spy = jest.spyOn(EmailService.prototype, 'sendEmail');
    await processSendEmail({ tenantId: tenantA.id, to: 'bea@shop.test', subject: 'fallback', template: 'order.created', variables: { orderId: 'A-4', total: '5.00' } });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Your order A-4', text: 'Thanks! Total 5.00' }));
    spy.mockRestore();
  });

  it('needs template permissions and stays inside the tenant', async () => {
    expect((await api.get('/notification-templates', noRole)).status).toBe(403);
    expect((await api.post('/notification-templates', noRole, { name: 'n.r', channel: 'SMS', body: 'x' })).status).toBe(403);
    expect((await api.get(`/notification-templates/${template.id}`, B)).status).toBe(404);
    expect((await api.patch(`/notification-templates/${template.id}`, B, { isActive: false })).status).toBe(404);
    expect((await api.post(`/notification-templates/${template.id}/preview`, B, {})).status).toBe(404);
    expect((await api.get('/notification-templates', B)).body.data).toEqual([]);
  });

  it('deletes a template', async () => {
    expect((await api.delete(`/notification-templates/${template.id}`, A)).status).toBe(200);
    expect((await api.get(`/notification-templates/${template.id}`, A)).status).toBe(404);
  });
});
