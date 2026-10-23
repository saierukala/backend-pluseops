import { jest } from '@jest/globals';
import request from 'supertest';
import { Queue } from 'bullmq';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { latestCompletedPeriod, reportScheduleService } from '../../src/modules/reports/report-schedules.service.js';
import { reportService } from '../../src/modules/reports/reports.service.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { getBullMqRedisConnection } from '../../src/jobs/connection.js';
import { QUEUE_NAMES, QUEUE_PREFIX } from '../../src/jobs/jobs.config.js';
import { registerSchedulers, SCHEDULES } from '../../src/jobs/schedulers.js';

const app = createApp();
const prisma = getPrismaClient();
const storage = new StorageService();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase36#Pass123';

let platformAdmin;
let tenantA;
let tenantB;
let A;

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const api = {
  get: (path, token) => request(app).get(`/api/v1${path}`).set(bearer(token)),
  post: (path, token, body) => request(app).post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, token, body) => request(app).patch(`/api/v1${path}`).set(bearer(token)).send(body),
  put: (path, token, body) => request(app).put(`/api/v1${path}`).set(bearer(token)).send(body),
  delete: (path, token) => request(app).delete(`/api/v1${path}`).set(bearer(token)),
};

async function createTenant(label) {
  const slug = `phase36-${label}-${RUN}`;
  const email = `p36-${label}-${RUN}@test.local`;
  const res = await api.post('/platform/tenants', platformAdmin.token, { name: `Phase 36 ${label}`, slug, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: label } });
  const token = (await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
  const me = (await api.get('/auth/me', token)).body.data;
  return { id: res.body.data.tenant.id, slug, email, token, userId: me.id ?? me.user?.id };
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p36_${RUN}` });
  tenantA = await createTenant('a');
  tenantB = await createTenant('b');
  A = tenantA.token;
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

describe('Phase 36 — schedule periods (UTC)', () => {
  it('daily = yesterday, weekly = last Monday–Sunday, monthly = last calendar month', () => {
    const fri = new Date('2026-10-23T10:00:00Z');
    expect(latestCompletedPeriod('DAILY', fri)).toEqual({ key: '2026-10-22', from: '2026-10-22', to: '2026-10-22' });
    expect(latestCompletedPeriod('WEEKLY', fri)).toEqual({ key: 'week-of-2026-10-12', from: '2026-10-12', to: '2026-10-18' });
    expect(latestCompletedPeriod('MONTHLY', fri)).toEqual({ key: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    // Monday: the week that ended yesterday; 1 January: December of last year
    expect(latestCompletedPeriod('WEEKLY', new Date('2026-10-19T00:30:00Z')).from).toBe('2026-10-12');
    expect(latestCompletedPeriod('MONTHLY', new Date('2027-01-01T00:10:00Z'))).toEqual({ key: '2026-12', from: '2026-12-01', to: '2026-12-31' });
    expect(latestCompletedPeriod('DAILY', new Date('2028-03-01T05:00:00Z')).from).toBe('2028-02-29');
  });
});

describe('Phase 36 — report schedules API', () => {
  let schedule;

  it('creates a schedule; the first report covers the next period to end', async () => {
    const res = await api.post('/report-schedules', A, { name: 'Daily orders', type: 'orders', frequency: 'DAILY', filters: { status: 'PENDING' } });
    expect(res.status).toBe(201);
    schedule = res.body.data;
    expect(schedule).toMatchObject({ type: 'ORDERS', frequency: 'DAILY', enabled: true, recipientUserIds: [tenantA.userId], lastPeriod: latestCompletedPeriod('DAILY').key });
  });

  it('validates filters and recipients', async () => {
    expect((await api.post('/report-schedules', A, { name: 'x', type: 'CUSTOMERS', frequency: 'DAILY', filters: { status: 'PENDING' } })).status).toBe(400);
    expect((await api.post('/report-schedules', A, { name: 'x', type: 'ORDERS', frequency: 'DAILY', filters: { from: '2026-01-01' } })).status).toBe(400);
    expect((await api.post('/report-schedules', A, { name: 'x', type: 'ORDERS', frequency: 'HOURLY' })).status).toBe(400);
    const outsider = await api.post('/report-schedules', A, { name: 'x', type: 'ORDERS', frequency: 'DAILY', recipientUserIds: [tenantB.userId] });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error.code).toBe('INVALID_RECIPIENTS');
    expect((await api.patch(`/report-schedules/${schedule.id}`, A, { filters: { warehouseId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(400);
  });

  it('lists, reads and is invisible to other tenants', async () => {
    expect((await api.get('/report-schedules', A)).body.data.map((s) => s.id)).toContain(schedule.id);
    expect((await api.get(`/report-schedules/${schedule.id}`, A)).status).toBe(200);
    expect((await api.get(`/report-schedules/${schedule.id}`, tenantB.token)).status).toBe(404);
    expect((await api.patch(`/report-schedules/${schedule.id}`, tenantB.token, { name: 'mine' })).status).toBe(404);
    expect((await api.get('/report-schedules', tenantB.token)).body.data).toEqual([]);
  });

  it('runs once per period, for that period, even with two ticks at once', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const period = latestCompletedPeriod('DAILY', tomorrow);
    const [first, second] = await Promise.all([reportScheduleService.runDue(tomorrow), reportScheduleService.runDue(tomorrow)]);
    const mine = [...first.results, ...second.results].filter((r) => r.scheduleId === schedule.id);
    expect(mine).toHaveLength(1);
    const reports = await prisma.report.findMany({ where: { scheduleId: schedule.id } });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ tenantId: tenantA.id, requestedBy: tenantA.userId, type: 'ORDERS', filters: { status: 'PENDING', from: period.from, to: period.to } });
    expect((await reportScheduleService.runDue(tomorrow)).results.filter((r) => r.scheduleId === schedule.id)).toHaveLength(0);
    const stored = await prisma.reportSchedule.findUnique({ where: { id: schedule.id } });
    expect(stored).toMatchObject({ lastPeriod: period.key, lastReportId: reports[0].id, lastError: null });
  });

  it('a finished scheduled report emails its recipients a link, not the data', async () => {
    const report = await prisma.report.findFirst({ where: { scheduleId: schedule.id } });
    if (report.status !== 'COMPLETED') await reportService.generate(tenantA.id, report.id);
    const link = `${env.APP_URL}/reports/${report.id}`;
    const connection = getBullMqRedisConnection();
    if (connection) {
      const queue = new Queue(QUEUE_NAMES.EMAIL, { connection, prefix: QUEUE_PREFIX });
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized']);
      const job = jobs.find((j) => j?.data?.template === 'report.scheduled_ready' && j.data.variables?.link === link);
      expect(job).toBeTruthy();
      expect(job.data.to).toBe(tenantA.email);
      expect(job.data.text).not.toMatch(/orderId,|customerEmail/);
      await queue.close();
    }
    expect((await api.get(`/reports/${report.id}`, A)).body.data).toMatchObject({ scheduleId: schedule.id, status: 'COMPLETED' });
  });

  it('pauses itself when its creator is no longer active', async () => {
    const other = await api.post('/report-schedules', A, { name: 'Weekly stock', type: 'INVENTORY', frequency: 'WEEKLY' });
    expect(other.status).toBe(201);
    await prisma.tenantMembership.updateMany({ where: { tenantId: tenantA.id, userId: tenantA.userId }, data: { status: 'SUSPENDED' } });
    try {
      const nextWeek = new Date(Date.now() + 8 * 24 * 3600 * 1000);
      const result = await reportScheduleService.runDue(nextWeek);
      expect(result.results.find((r) => r.scheduleId === other.body.data.id)).toMatchObject({ paused: true });
      const stored = await prisma.reportSchedule.findUnique({ where: { id: other.body.data.id } });
      expect(stored.enabled).toBe(false);
      expect(stored.lastError).toMatch(/no longer active/);
      expect(await prisma.report.count({ where: { scheduleId: other.body.data.id } })).toBe(0);
    } finally {
      await prisma.tenantMembership.updateMany({ where: { tenantId: tenantA.id, userId: tenantA.userId }, data: { status: 'ACTIVE' } });
    }
    // Re-enabling resumes from now, without a burst for missed periods
    const resumed = await api.patch(`/report-schedules/${other.body.data.id}`, A, { enabled: true });
    expect(resumed.body.data).toMatchObject({ enabled: true, lastError: null, lastPeriod: latestCompletedPeriod('WEEKLY').key });
  });

  it('deletes a schedule; its reports stay', async () => {
    expect((await api.delete(`/report-schedules/${schedule.id}`, A)).status).toBe(204);
    expect((await api.get(`/report-schedules/${schedule.id}`, A)).status).toBe(404);
    expect(await prisma.report.count({ where: { tenantId: tenantA.id, type: 'ORDERS', filters: { path: ['status'], equals: 'PENDING' } } })).toBeGreaterThan(0);
  });
});

describe('Phase 36 — report retention', () => {
  it('deletes reports and files older than REPORT_RETENTION_DAYS; newer ones stay', async () => {
    expect(env.REPORT_RETENTION_DAYS).toBe(30);
    const old = await prisma.report.create({ data: { tenantId: tenantA.id, type: 'CUSTOMERS', status: 'COMPLETED', createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
    const key = `tenants/${tenantA.id}/reports/${old.id}.csv`;
    await storage.upload(key, Buffer.from('a,b\n'), 'text/csv');
    await prisma.report.update({ where: { id: old.id }, data: { storageKey: key } });
    const missingFile = await prisma.report.create({ data: { tenantId: tenantA.id, type: 'CUSTOMERS', status: 'COMPLETED', storageKey: `tenants/${tenantA.id}/reports/gone.csv`, createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) } });
    const fresh = await prisma.report.create({ data: { tenantId: tenantA.id, type: 'CUSTOMERS', status: 'FAILED', createdAt: new Date(Date.now() - 5 * 24 * 3600 * 1000) } });

    const result = await reportService.prune(new Date(), { tenantId: tenantA.id });
    expect(result.deleted).toBeGreaterThanOrEqual(2);
    expect(await prisma.report.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.report.findUnique({ where: { id: missingFile.id } })).toBeNull();
    expect(await prisma.report.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await storage.fileExists(key)).toBe(false);

    const listed = (await api.get(`/reports/${fresh.id}`, A)).body.data;
    expect(new Date(listed.expiresAt).getTime()).toBe(fresh.createdAt.getTime() + 30 * 24 * 3600 * 1000);
  });

  it('registers the recurring jobs once (idempotent)', async () => {
    const connection = getBullMqRedisConnection();
    if (!connection) return;
    expect(await registerSchedulers()).toEqual(SCHEDULES.map((s) => s.id));
    expect(await registerSchedulers()).toEqual(SCHEDULES.map((s) => s.id));
    for (const name of [QUEUE_NAMES.CLEANUP, QUEUE_NAMES.REPORT]) {
      const queue = new Queue(name, { connection, prefix: QUEUE_PREFIX });
      const ids = (await queue.getJobSchedulers()).map((s) => s.key ?? s.id);
      for (const s of SCHEDULES.filter((x) => (name === QUEUE_NAMES.REPORT) === x.id.startsWith('run-report'))) expect(ids).toContain(s.id);
      // Don't leave them firing in the test Redis
      for (const s of SCHEDULES) await queue.removeJobScheduler(s.id);
      await queue.close();
    }
  });
});

describe('Phase 36 — analytics ignore deleted customers', () => {
  it('overview and customer analytics count only customers that still exist', async () => {
    const T = tenantB.token;
    const keep = (await api.post('/customers', T, { email: `keep-${RUN}@test.local`, firstName: 'Keep', lastName: 'Me' })).body.data;
    const gone = (await api.post('/customers', T, { email: `gone-${RUN}@test.local`, firstName: 'Gone', lastName: 'Soon' })).body.data;
    expect(keep?.id && gone?.id).toBeTruthy();
    expect((await api.delete(`/customers/${gone.id}`, T)).status).toBe(200);
    const overview = await api.get('/analytics/overview', T);
    expect(overview.status).toBe(200);
    expect(overview.body.data.customers.total).toBe(1);
    const customers = await api.get('/analytics/customers?groupBy=day', T);
    expect(customers.body.summary.totalCustomers).toBe(1);
    expect(customers.body.buckets.reduce((n, b) => n + b.newCustomers, 0)).toBe(1);
  });
});

describe('Phase 36 — storefront listing in SQL', () => {
  const sf = (q = '') => `/storefront/${tenantB.slug}/products${q}`;
  let ids;

  beforeAll(async () => {
    const T = tenantB.token;
    await api.patch('/workspace/settings', T, { currency: 'INR' });
    const warehouseId = (await api.post('/warehouses', T, { name: 'Main', code: `P36-${RUN}`, isDefault: true })).body.data.id;
    const make = async (name, prices, stock) => {
      const product = (await api.post('/products', T, { name, status: 'ACTIVE' })).body.data;
      for (const [i, price] of prices.entries()) {
        const variant = (await api.post(`/products/${product.id}/variants`, T, { sku: `${name.replace(/\W/g, '')}-${i}-${RUN}`, price, status: 'ACTIVE' })).body.data;
        if (stock) await api.post('/inventory/adjust', T, { variantId: variant.id, warehouseId, quantityChanged: stock, reason: 'INIT' });
      }
      return product.id;
    };
    ids = {
      apple: await make('Apple 100% juice', ['80.00', '150.00'], 5),
      banana: await make('Banana chips', ['40.00'], 0),
      cherry: await make('Cherry jam', ['220.00'], 3),
    };
  });

  it('sorts by price range and name with the same results as before', async () => {
    expect((await api.get(sf('?sort=price_asc'))).body.data.map((p) => p.id)).toEqual([ids.banana, ids.apple, ids.cherry]);
    expect((await api.get(sf('?sort=price_desc'))).body.data.map((p) => p.id)).toEqual([ids.cherry, ids.apple, ids.banana]);
    expect((await api.get(sf('?sort=name'))).body.data.map((p) => p.id)).toEqual([ids.apple, ids.banana, ids.cherry]);
    expect((await api.get(sf('?sort=newest'))).body.data.map((p) => p.id)).toEqual([ids.cherry, ids.banana, ids.apple]);
    const apple = (await api.get(sf('?sort=name'))).body.data[0];
    expect(apple).toMatchObject({ priceFrom: '80.00', priceTo: '150.00', currency: 'INR', inStock: true });
  });

  it('filters by price (any sellable variant in range) and stock', async () => {
    expect((await api.get(sf('?minPrice=100&maxPrice=160'))).body.data.map((p) => p.id)).toEqual([ids.apple]);
    expect((await api.get(sf('?maxPrice=50'))).body.data.map((p) => p.id)).toEqual([ids.banana]);
    expect((await api.get(sf('?inStock=true&sort=name'))).body.data.map((p) => p.id)).toEqual([ids.apple, ids.cherry]);
  });

  it('treats % and _ in a search as plain text', async () => {
    expect((await api.get(sf('?search=100%25'))).body.data.map((p) => p.id)).toEqual([ids.apple]);
    expect((await api.get(sf('?search=%25'))).body.data.map((p) => p.id)).toEqual([ids.apple]);
    expect((await api.get(sf('?search=_'))).body.data).toEqual([]);
    expect((await api.get(sf('?search=JAM'))).body.data.map((p) => p.id)).toEqual([ids.cherry]);
  });

  it('pages with a correct total, also past the last page', async () => {
    const page1 = (await api.get(sf('?sort=name&limit=2'))).body;
    expect(page1.data.map((p) => p.id)).toEqual([ids.apple, ids.banana]);
    expect(page1.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect((await api.get(sf('?sort=name&limit=2&page=2'))).body.data.map((p) => p.id)).toEqual([ids.cherry]);
    expect((await api.get(sf('?sort=name&limit=2&page=5'))).body).toMatchObject({ data: [], meta: { total: 3, totalPages: 2 } });
  });
});
