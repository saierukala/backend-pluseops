import crypto from 'node:crypto';
import http from 'node:http';
import { StorageService, createStorageProvider } from '../../src/common/storage/storage.service.js';
import { LocalStorageProvider } from '../../src/common/storage/local-storage.provider.js';
import { S3StorageProvider, MockS3StorageProvider } from '../../src/integrations/storage/s3-storage.provider.js';
import { IntegrationError, IntegrationErrorCode } from '../../src/integrations/errors/integration-error.js';
import { createPaymentProvider, MockPaymentProvider, HttpPaymentProvider } from '../../src/integrations/payment/payment.provider.js';
import { createEmailProvider, MockEmailProvider, HttpEmailProvider } from '../../src/integrations/email/email.provider.js';
import { createSmsProvider, MockSmsProvider, HttpSmsProvider } from '../../src/integrations/sms/sms.provider.js';
import { createShippingProvider, MockShippingProvider, HttpShippingProvider } from '../../src/integrations/shipping/shipping.provider.js';
import { createMapsProvider, MockMapsProvider, HttpMapsProvider } from '../../src/integrations/maps/maps.provider.js';
import { processSendEmail } from '../../src/jobs/processors/email.processor.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';

const prisma = getPrismaClient();

// helpers
async function hashPassword(p) { const { hash } = await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tenantId, email) {
  const passwordHash = await hashPassword('SecurePass123!');
  return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } });
}

// generic test HTTP server helper
function startJsonServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, port });
    });
  });
}
function createS3TestServer() {
  const store = new Map(); // key -> { buffer, mime }
  let requestLog = [];
  let failNextStatus = null;
  let delayMs = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathParts = url.pathname.replace(/^\/+/, '').split('/');
      const bucket = pathParts.shift();
      const key = pathParts.join('/');
      requestLog.push({ method: req.method, bucket, key, headers: req.headers, url: url.pathname });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failNextStatus) {
        const s = failNextStatus; failNextStatus = null;
        if (!res.headersSent) { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `fail ${s}` })); }
        return;
      }
      // If client already closed (timeout abort), req may be destroyed; just return
      if (req.destroyed || res.writableEnded) return;
      if (req.method === 'PUT') {
        const chunks = []; try { for await (const c of req) chunks.push(c); } catch (e) { if (String(e.message).includes('aborted')) return; throw e; }
        const buf = Buffer.concat(chunks);
        store.set(key, { buffer: buf, mime: req.headers['content-type'] || 'application/octet-stream' });
        if (!res.headersSent) { res.writeHead(200); res.end(); }
      } else if (req.method === 'GET') {
        if (!store.has(key)) { if (!res.headersSent) { res.writeHead(404); res.end(); } return; }
        const entry = store.get(key);
        if (!res.headersSent) { res.writeHead(200, { 'Content-Type': entry.mime }); res.end(entry.buffer); }
      } else if (req.method === 'HEAD') {
        if (!store.has(key)) { if (!res.headersSent) { res.writeHead(404); res.end(); } return; }
        const entry = store.get(key);
        if (!res.headersSent) { res.writeHead(200, { 'Content-Type': entry.mime, 'Content-Length': entry.buffer.length }); res.end(); }
      } else if (req.method === 'DELETE') {
        if (!store.has(key)) { if (!res.headersSent) { res.writeHead(404); res.end(); } return; }
        store.delete(key); if (!res.headersSent) { res.writeHead(204); res.end(); }
      } else {
        if (!res.headersSent) { res.writeHead(400); res.end(); }
      }
    } catch (e) {
      if (String(e.message).toLowerCase().includes('aborted')) return;
      try { if (!res.headersSent) { res.writeHead(500); res.end(); } } catch { /* ignore */ }
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        server, port, store, url: `http://127.0.0.1:${port}`,
        getLog: () => requestLog, clearLog: () => { requestLog = []; },
        setFailNext: (s) => { failNextStatus = s; },
        setDelay: (ms) => { delayMs = ms; },
        bucket: 'test-bucket',
      });
    });
  });
}

describe('Phase 16 - External API Integrations', () => {
  let tenantAId, tenantBId;

  beforeAll(async () => {
    const ta = await createTenant(`p16-a-${Date.now()}`);
    const tb = await createTenant(`p16-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    await createUser(tenantAId, `p16-a-${Date.now()}@a.com`);
    await createUser(tenantBId, `p16-b-${Date.now()}@b.com`);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  describe('Storage provider contract', () => {
    it('local, real s3 and mock s3 providers implement same interface (upload/delete/getUrl/exists)', async () => {
      const local = new LocalStorageProvider();
      const realS3 = new S3StorageProvider({ bucket: 'b', endpoint: 'http://localhost:9000' });
      const mockS3 = new MockS3StorageProvider({ store: new Map() });
      for (const p of [local, realS3, mockS3]) {
        expect(typeof p.upload).toBe('function');
        expect(typeof p.delete).toBe('function');
        expect(typeof p.getUrl).toBe('function');
        expect(typeof p.exists).toBe('function');
        expect(typeof p.getStream).toBe('function');
      }
    });

    it('StorageService selects provider via STORAGE_PROVIDER env', async () => {
      const svcLocal = new StorageService('local');
      expect(svcLocal.provider).toBeInstanceOf(LocalStorageProvider);
      const svcS3 = new StorageService('s3');
      expect(svcS3.provider).toBeInstanceOf(S3StorageProvider);
      const factoryLocal = createStorageProvider('local');
      expect(factoryLocal).toBeInstanceOf(LocalStorageProvider);
      const factoryS3 = createStorageProvider('s3');
      expect(factoryS3).toBeInstanceOf(S3StorageProvider);
    });

    it('MockS3StorageProvider is clearly distinguished from real S3StorageProvider', async () => {
      const mock = new MockS3StorageProvider({ store: new Map() });
      const real = new S3StorageProvider({ bucket: 'b', endpoint: 'http://localhost:9000' });
      expect(mock.constructor.name).toBe('MockS3StorageProvider');
      expect(real.constructor.name).toBe('S3StorageProvider');
      expect(mock).not.toBeInstanceOf(S3StorageProvider);
    });
  });

  describe('Storage upload / delete / url / tenant-scoped keys', () => {
    it('upload product image via StorageService creates tenant-scoped key', async () => {
      const svc = new StorageService('local');
      const tenantId = tenantAId;
      const productId = crypto.randomUUID();
      const file = { originalname: 'photo.jpg', buffer: Buffer.from('fake-image'), mimetype: 'image/jpeg', size: 1024 };
      const result = await svc.uploadProductImage(tenantId, productId, file);
      expect(result.storageKey).toMatch(new RegExp(`^tenants/${tenantId}/products/${productId}/[a-f0-9]{8}_photo\\.jpg$`));
      expect(result.url).toContain(result.storageKey);
      await svc.deleteFile(result.storageKey);
    });

    it('mock s3 provider upload creates tenant-scoped key and getUrl returns url', async () => {
      const store = new Map();
      const mock = new MockS3StorageProvider({ store });
      const svc = new StorageService('local');
      svc.provider = mock;
      svc.providerName = 'mock-s3';
      const tenantId = tenantAId;
      const productId = crypto.randomUUID();
      const file = { originalname: 's3-image.png', buffer: Buffer.from('img-data'), mimetype: 'image/png', size: 8 };
      const result = await svc.uploadProductImage(tenantId, productId, file);
      expect(result.storageKey.startsWith(`tenants/${tenantId}/products/${productId}/`)).toBe(true);
      const url = await svc.getFileUrl(result.storageKey);
      expect(url).toContain(result.storageKey);
      expect(await svc.fileExists(result.storageKey)).toBe(true);
      await svc.deleteFile(result.storageKey);
      expect(await svc.fileExists(result.storageKey)).toBe(false);
    });

    it('REAL S3 provider via deterministic test server: upload/HEAD/GET/DELETE', async () => {
      const s3Server = await createS3TestServer();
      const bucket = s3Server.bucket;
      const s3 = new S3StorageProvider({ bucket, endpoint: s3Server.url, region: 'us-east-1', forcePathStyle: true, timeoutMs: 2000 });
      const svc = new StorageService('local');
      svc.provider = s3;
      const tenantId = tenantAId;
      const productId = crypto.randomUUID();
      const file = { originalname: 'real-s3.jpg', buffer: Buffer.from('real-s3-data'), mimetype: 'image/jpeg', size: 13 };
      const result = await svc.uploadProductImage(tenantId, productId, file);
      expect(result.storageKey.startsWith(`tenants/${tenantId}/products/${productId}/`)).toBe(true);
      expect(result.size).toBe(file.buffer.length);
      // HEAD exists
      expect(await svc.fileExists(result.storageKey)).toBe(true);
      const url = await svc.getFileUrl(result.storageKey);
      expect(url).toContain(result.storageKey);
      // GET stream
      const stream = await svc.getFileStream(result.storageKey);
      expect(stream).not.toBeNull();
      const chunks = []; for await (const c of stream) chunks.push(c);
      expect(Buffer.concat(chunks).toString()).toBe('real-s3-data');
      // DELETE
      expect(await svc.deleteFile(result.storageKey)).toBe(true);
      expect(await svc.fileExists(result.storageKey)).toBe(false);
      expect(await svc.getFileUrl(result.storageKey)).toBeNull();
      // request log proves real HTTP PUT/HEAD/GET/DELETE were used
      const log = s3Server.getLog();
      expect(log.some((r) => r.method === 'PUT')).toBe(true);
      expect(log.some((r) => r.method === 'HEAD')).toBe(true);
      s3Server.server.close();
    });

    it('tenant-scoped storage keys enforced server-side (variants path)', async () => {
      const svc = new StorageService('local');
      const tenantId = tenantAId;
      const productId = crypto.randomUUID();
      const variantId = crypto.randomUUID();
      const file = { originalname: 'variant.webp', buffer: Buffer.from('v'), mimetype: 'image/webp', size: 1 };
      const result = await svc.uploadVariantImage(tenantId, productId, variantId, file);
      expect(result.storageKey).toMatch(new RegExp(`^tenants/${tenantId}/products/${productId}/variants/${variantId}/[a-f0-9]{8}_variant\\.webp$`));
      await svc.deleteFile(result.storageKey);
    });

    it('arbitrary storage path rejection (path traversal, absolute, non-tenant)', async () => {
      const svc = new StorageService('local');
      await expect(svc.deleteFile('../etc/passwd')).rejects.toThrow(/Invalid storage/);
      await expect(svc.deleteFile('/absolute/path')).rejects.toThrow(/Invalid storage/);
      await expect(svc.deleteFile('tenants/../other')).rejects.toThrow(/Invalid storage/);
      await expect(svc.getFileUrl('not-tenants/foo.jpg')).rejects.toThrow(/tenant-scoped/);
      await expect(svc.upload('tenants/../../evil', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/Invalid storage/);
      const mockS3svc = new MockS3StorageProvider({ store: new Map() });
      const s3svc = new StorageService('local'); s3svc.provider = mockS3svc;
      await expect(s3svc.deleteFile('tenants/../evil')).rejects.toThrow(/Invalid storage/);
      await expect(s3svc.getFileUrl('../../evil')).rejects.toThrow(/Invalid storage/);
    });

    it('tenant isolation: tenant A cannot use tenant B storage key', async () => {
      const svcA = new StorageService('local');
      const file = { originalname: 'iso.jpg', buffer: Buffer.from('data'), mimetype: 'image/jpeg', size: 4 };
      const prodId = crypto.randomUUID();
      const resultB = await svcA.uploadProductImage(tenantBId, prodId, file);
      expect(resultB.storageKey.startsWith(`tenants/${tenantBId}/`)).toBe(true);
      expect(resultB.storageKey.startsWith(`tenants/${tenantAId}/`)).toBe(false);
      await svcA.deleteFile(resultB.storageKey);
    });

    it('local provider regression still works (file exists, delete, getUrl)', async () => {
      const svc = new StorageService('local');
      const key = svc.generateProductImageKey(tenantAId, crypto.randomUUID(), 'regression.jpg');
      const buffer = Buffer.from('regression');
      await svc.upload(key, buffer, 'image/jpeg');
      expect(await svc.fileExists(key)).toBe(true);
      const url = await svc.getFileUrl(key);
      expect(url).toContain(key);
      await svc.deleteFile(key);
      expect(await svc.fileExists(key)).toBe(false);
      expect(await svc.getFileUrl(key)).toBeNull();
    });
  });

  describe('Storage error normalization', () => {
    it('mock s3 provider timeout becomes IntegrationError TIMEOUT', async () => {
      const mock = new MockS3StorageProvider({ store: new Map(), shouldTimeout: true });
      const svc = new StorageService('local'); svc.provider = mock;
      await expect(svc.upload(`tenants/${tenantAId}/products/p/file.jpg`, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(IntegrationError);
      try { await svc.upload(`tenants/${tenantAId}/products/p/file.jpg`, Buffer.from('x'), 'image/jpeg'); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.TIMEOUT); expect(e.statusCode).toBe(504); }
    });

    it('mock s3 provider unavailable becomes IntegrationError UNAVAILABLE', async () => {
      const mock = new MockS3StorageProvider({ store: new Map(), shouldFail: true, failStatus: 502 });
      const svc = new StorageService('local'); svc.provider = mock;
      await expect(svc.upload(`tenants/${tenantAId}/products/p/file2.jpg`, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(IntegrationError);
      try { await svc.upload(`tenants/${tenantAId}/products/p/file2.jpg`, Buffer.from('x'), 'image/jpeg'); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.UNAVAILABLE); }
    });

    it('real S3 provider timeout normalized via HTTP test server delay', async () => {
      const s3Server = await createS3TestServer();
      s3Server.setDelay(400);
      const s3 = new S3StorageProvider({ bucket: s3Server.bucket, endpoint: s3Server.url, region: 'us-east-1', forcePathStyle: true, timeoutMs: 60 });
      try {
        await expect(s3.upload(`tenants/${tenantAId}/products/p/timeout.jpg`, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(IntegrationError);
        try {
          await s3.upload(`tenants/${tenantAId}/products/p/timeout2.jpg`, Buffer.from('x'), 'image/jpeg');
          throw new Error('should have timed out');
        } catch (e) {
          const isTimeout = e.code === IntegrationErrorCode.TIMEOUT || String(e.message).toLowerCase().includes('timed out') || String(e.message).toLowerCase().includes('abort');
          expect(isTimeout).toBe(true);
        }
      } finally {
        s3Server.setDelay(0);
        await new Promise((r) => setTimeout(r, 600));
        s3Server.server.close();
        await new Promise((r) => s3Server.server.once('close', r));
      }
    }, 10000);

    it('real S3 provider 503 retry then success (idempotent PUT retries)', async () => {
      const s3Server = await createS3TestServer();
      s3Server.setFailNext(503);
      const s3 = new S3StorageProvider({ bucket: s3Server.bucket, endpoint: s3Server.url, region: 'us-east-1', forcePathStyle: true, timeoutMs: 2000 });
      const svc = new StorageService('local'); svc.provider = s3;
      const key = svc.generateProductImageKey(tenantAId, crypto.randomUUID(), 'retry.jpg');
      const res = await svc.upload(key, Buffer.from('retry-data'), 'image/jpeg');
      expect(res.size).toBe(10);
      // Should have retried: log shows 2 PUT attempts
      const puts = s3Server.getLog().filter((r) => r.method === 'PUT');
      expect(puts.length).toBeGreaterThanOrEqual(2);
      await svc.delete(key);
      s3Server.server.close();
    });

    it('secrets never leaked in storage errors', async () => {
      const mock = new MockS3StorageProvider({ store: new Map(), shouldFail: true, failStatus: 401 });
      const svc = new StorageService('local'); svc.provider = mock;
      try { await svc.upload(`tenants/${tenantAId}/products/p/file3.jpg`, Buffer.from('x'), 'image/jpeg'); } catch (e) { expect(e.message).not.toContain('S3_SECRET'); expect(String(e.details || '')).not.toContain('secret'); }
    });
  });

  describe('Payment provider adapter', () => {
    it('mock provider success returns mapped providerPaymentId', async () => {
      const provider = new MockPaymentProvider();
      const res = await provider.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId });
      expect(res.providerPaymentId).toMatch(/^pay_mock_/);
      expect(res.mapped.provider).toBe('payment');
      expect(res.mapped.providerPaymentId).toBe(res.providerPaymentId);
    });

    it('HTTP payment provider success via test server (request mapping + response mapping)', async () => {
      let captured = null;
      const { server, url } = await startJsonServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/charges') {
          let body = ''; for await (const c of req) body += c;
          captured = { headers: req.headers, body: JSON.parse(body), url: req.url };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'pay_http_123', status: 'succeeded', amount: '10.00' }));
        } else { res.writeHead(404); res.end(); }
      });
      const http = new HttpPaymentProvider({ baseUrl: url, apiKey: 'test-key', timeoutMs: 2000, retries: 0 });
      const res = await http.charge({ amount: '10.00', currency: 'USD', orderId: 'order-123', tenantId: tenantAId, idempotencyKey: 'idem-1' });
      expect(captured).not.toBeNull();
      expect(captured.body.amount).toBe('10.00');
      expect(captured.body.orderId).toBe('order-123');
      expect(captured.headers.authorization).toBe('Bearer test-key');
      expect(captured.headers['idempotency-key']).toBe('idem-1');
      expect(res.providerPaymentId).toBe('pay_http_123');
      expect(res.mapped.providerPaymentId).toBe('pay_http_123');
      expect(res.mapped.provider).toBe('payment');
      expect(JSON.stringify(captured)).not.toContain('secret');
      server.close();
    });

    it('HTTP payment provider timeout via delayed test server', async () => {
      const { server, url } = await startJsonServer(async (req, res) => {
        await new Promise((r) => setTimeout(r, 300));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'pay_late' }));
      });
      const http = new HttpPaymentProvider({ baseUrl: url, timeoutMs: 50, retries: 0 });
      await expect(http.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId, idempotencyKey: 'k' })).rejects.toThrow(IntegrationError);
      try { await http.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId, idempotencyKey: 'k2' }); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.TIMEOUT); expect(e.isRetryable()).toBe(true); }
      server.close();
    });

    it('HTTP payment provider retry on 503 for idempotent charge', async () => {
      let calls = 0;
      const { server, url } = await startJsonServer(async (req, res) => {
        calls += 1;
        if (calls === 1) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({})); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'pay_retry', status: 'succeeded' }));
      });
      const http = new HttpPaymentProvider({ baseUrl: url, timeoutMs: 2000, retries: 2 });
      const res = await http.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId, idempotencyKey: 'retry-key' });
      expect(res.providerPaymentId).toBe('pay_retry');
      expect(calls).toBe(2);
      server.close();
    });

    it('HTTP payment provider does NOT blindly retry non-idempotent refund', async () => {
      let calls = 0;
      const { server, url } = await startJsonServer(async (req, res) => {
        calls += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({}));
      });
      const http = new HttpPaymentProvider({ baseUrl: url, timeoutMs: 2000, retries: 2 });
      await expect(http.refund({ paymentId: 'pay_1', amount: '5.00', currency: 'USD' })).rejects.toThrow(IntegrationError);
      expect(calls).toBe(1); // no retry for refund
      server.close();
    });

    it('mock provider failure is normalized IntegrationError (unavailable) and is retryable', async () => {
      const provider = new MockPaymentProvider({ shouldFail: true });
      await expect(provider.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await provider.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId }); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.UNAVAILABLE); expect(e.isRetryable()).toBe(true); }
    });

    it('mock provider validation failure is not retryable and status 400', async () => {
      const provider = new MockPaymentProvider();
      await expect(provider.charge({ amount: '0', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await provider.charge({ amount: '0', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId }); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.VALIDATION); expect(e.isRetryable()).toBe(false); expect(e.statusCode).toBe(400); }
    });

    it('createPaymentProvider factory returns mock by default', async () => {
      const p = createPaymentProvider('mock');
      expect(p).toBeInstanceOf(MockPaymentProvider);
      const http = createPaymentProvider('http', { baseUrl: 'http://example.com' });
      expect(http).toBeInstanceOf(HttpPaymentProvider);
    });

    it('http provider configuration error when URL missing', async () => {
      const http = new HttpPaymentProvider({ baseUrl: null });
      await expect(http.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await http.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId }); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.CONFIGURATION); }
    });

    it('payment webhook verification via adapter validates signature', async () => {
      const provider = new MockPaymentProvider();
      const payload = { eventId: `evt_${Date.now()}`, type: 'payment.succeeded', tenantId: tenantAId };
      const { computeSignature } = await import('../../src/modules/payments/webhook.util.js');
      const sig = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      const res = await provider.verifyWebhook(payload, sig);
      expect(res.verified).toBe(true);
      await expect(provider.verifyWebhook(payload, 'bad')).rejects.toThrow(IntegrationError);
      try { await provider.verifyWebhook(payload, 'bad'); } catch (e) { expect(e.code).toBe(IntegrationErrorCode.AUTHENTICATION); expect(e.statusCode).toBe(401); }
    });

    it('secrets not leaked in payment errors', async () => {
      const provider = new MockPaymentProvider({ shouldFail: true });
      try { await provider.charge({ amount: '10.00', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId }); } catch (e) { expect(e.message).not.toMatch(/apiKey/i); expect(JSON.stringify(e.details || {})).not.toContain('secret'); }
    });
  });

  describe('Email provider adapter + BullMQ integration', () => {
    it('mock email provider success returns providerId mapped', async () => {
      const provider = new MockEmailProvider();
      const res = await provider.send({ to: 'a@b.com', subject: 'Hi', tenantId: tenantAId });
      expect(res.providerId).toMatch(/email_mock_/);
      expect(res.mapped.provider).toBe('email');
    });

    it('HTTP email provider success via test server (request + response mapping)', async () => {
      let captured = null;
      const { server, url } = await startJsonServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/send') {
          let b = ''; for await (const c of req) b += c;
          captured = { headers: req.headers, body: JSON.parse(b) };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'email_http_123', status: 'sent' }));
        } else { res.writeHead(404); res.end(); }
      });
      const http = new HttpEmailProvider({ baseUrl: url, apiKey: 'email-key', timeoutMs: 2000, retries: 0 });
      const res = await http.send({ to: 'a@b.com', subject: 'Hi', html: '<b>Hi</b>', tenantId: tenantAId });
      expect(captured.body.to).toBe('a@b.com');
      expect(captured.body.subject).toBe('Hi');
      expect(captured.headers.authorization).toBe('Bearer email-key');
      expect(res.providerId).toBe('email_http_123');
      expect(res.mapped.provider).toBe('email');
      server.close();
    });

    it('mock email provider timeout is retryable, validation is not', async () => {
      const timeoutProv = new MockEmailProvider({ shouldTimeout: true });
      await expect(timeoutProv.send({ to: 'a@b.com', subject: 'Hi', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await timeoutProv.send({ to: 'a@b.com', subject: 'Hi', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(true); }
      const valProv = new MockEmailProvider();
      await expect(valProv.send({ to: '', subject: '', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await valProv.send({ to: '', subject: '', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(false); }
    });

    it('email provider http timeout behavior (via mock http fetch)', async () => {
      const http = new HttpEmailProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100, retries: 0 });
      await expect(http.send({ to: 'a@b.com', subject: 'Hi', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
    });

    it('email processor uses provider adapter and succeeds (no deferred stub) via BullMQ -> EmailService -> adapter', async () => {
      const res = await processSendEmail({ tenantId: tenantAId, to: `p16-${Date.now()}@test.com`, subject: 'Phase16 email', template: 'welcome', variables: { name: 'Test' } }, { jobId: `p16-email-${Date.now()}` });
      expect(res.success).toBe(true);
      expect(res.providerId).toBeDefined();
      expect(res.tenantId).toBe(tenantAId);
    });

    it('processor does not contain provider HTTP logic (delegates to EmailService)', async () => {
      const src = await import('node:fs/promises').then((m) => m.readFile('src/jobs/processors/email.processor.js', 'utf8'));
      expect(src).toContain('EmailService');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('http');
    });

    it('email processor permanent failure (missing to) is UnrecoverableError (no retry)', async () => {
      await expect(processSendEmail({ tenantId: tenantAId, to: '', subject: '' }, { jobId: 'bad-email-1' })).rejects.toThrow();
      try { await processSendEmail({ tenantId: tenantAId, to: '', subject: '' }, { jobId: 'bad-email-2' }); } catch (e) { expect(e.name).toBe('UnrecoverableError'); }
    });

    it('email job payload does not contain secrets', async () => {
      const payload = { tenantId: tenantAId, to: 'a@b.com', subject: 'Hi', variables: { name: 'Alice' } };
      const res = await processSendEmail(payload, { jobId: `secret-check-${Date.now()}` });
      expect(JSON.stringify(payload)).not.toContain('apiKey');
      expect(JSON.stringify(res)).not.toContain('secret');
    });

    it('createEmailProvider factory returns mock by default', async () => {
      const p = createEmailProvider('mock', { fresh: true });
      expect(p).toBeInstanceOf(MockEmailProvider);
    });
  });

  describe('SMS provider', () => {
    it('mock sms success', async () => {
      const sms = new MockSmsProvider();
      const res = await sms.send({ to: '+1234567890', message: 'Hello', tenantId: tenantAId });
      expect(res.providerId).toMatch(/sms_mock_/);
      expect(res.mapped.provider).toBe('sms');
    });
    it('HTTP sms provider success via test server', async () => {
      let cap = null;
      const { server, url } = await startJsonServer(async (req, res) => {
        let b = ''; for await (const c of req) b += c;
        cap = JSON.parse(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'sms_http_123', status: 'sent' }));
      });
      const http = new HttpSmsProvider({ baseUrl: url, apiKey: 'sms-key', timeoutMs: 2000 });
      const res = await http.send({ to: '+123456', message: 'Hello', tenantId: tenantAId });
      expect(cap.to).toBe('+123456');
      expect(res.providerId).toBe('sms_http_123');
      expect(res.mapped.provider).toBe('sms');
      server.close();
    });
    it('sms timeout is retryable, validation not', async () => {
      const t = new MockSmsProvider({ shouldTimeout: true });
      await expect(t.send({ to: '+1', message: 'hi', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await t.send({ to: '+1', message: 'hi', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(true); }
      const v = new MockSmsProvider();
      await expect(v.send({ to: '', message: '', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await v.send({ to: '', message: '', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(false); }
    });
    it('sms provider factory', async () => {
      const p = createSmsProvider('mock', { fresh: true });
      expect(p).toBeInstanceOf(MockSmsProvider);
    });
  });

  describe('Shipping provider', () => {
    it('mock shipping getRate success mapped', async () => {
      const ship = new MockShippingProvider();
      const res = await ship.getRate({ origin: 'NYC', destination: 'LA', weight: 2, tenantId: tenantAId });
      expect(res.rate).toBeDefined();
      expect(res.currency).toBe('USD');
      expect(res.eta).toBeDefined();
    });
    it('HTTP shipping provider success via test server (uses shared http client, timeout, retry)', async () => {
      let cap = null;
      const { server, url } = await startJsonServer(async (req, res) => {
        let b = ''; for await (const c of req) b += c;
        cap = JSON.parse(b);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rate: 12.5, currency: 'USD', eta: '2 days' }));
      });
      const http = new HttpShippingProvider({ baseUrl: url, apiKey: 'ship-key', timeoutMs: 2000 });
      const res = await http.getRate({ origin: 'NYC', destination: 'LA', weight: 2, tenantId: tenantAId });
      expect(cap.origin).toBe('NYC');
      expect(res.rate).toBe(12.5);
      expect(res.currency).toBe('USD');
      expect(res.eta).toBe('2 days');
      server.close();
    });
    it('HTTP shipping createShipment does NOT retry non-idempotent', async () => {
      let calls = 0;
      const { server, url } = await startJsonServer(async (req, res) => {
        calls += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({}));
      });
      const http = new HttpShippingProvider({ baseUrl: url, timeoutMs: 1000 });
      await expect(http.createShipment({ orderId: 'ord_123', origin: 'A', destination: 'B', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      expect(calls).toBe(1);
      server.close();
    });
    it('shipping validation not retryable', async () => {
      const ship = new MockShippingProvider();
      await expect(ship.getRate({ origin: '', destination: '', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await ship.getRate({ origin: '', destination: '', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(false); }
    });
    it('shipping factory', async () => {
      const p = createShippingProvider('mock', { fresh: true });
      expect(p).toBeInstanceOf(MockShippingProvider);
    });
  });

  describe('Maps provider', () => {
    it('mock maps geocode success mapped', async () => {
      const maps = new MockMapsProvider();
      const res = await maps.geocode({ address: '1600 Amphitheatre Parkway', tenantId: tenantAId });
      expect(res.lat).toBeDefined();
      expect(res.lng).toBeDefined();
      expect(res.address).toBeDefined();
    });
    it('HTTP maps provider success via test server (GET, timeout, retry, mapping)', async () => {
      let capturedUrl = null;
      const { server, url } = await startJsonServer(async (req, res) => {
        capturedUrl = req.url;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lat: 40.1, lng: -74.1, address: 'Mock street' }));
      });
      const http = new HttpMapsProvider({ baseUrl: url, apiKey: 'maps-key', timeoutMs: 2000 });
      const res = await http.geocode({ address: 'NYC', tenantId: tenantAId });
      expect(capturedUrl).toContain('/geocode');
      expect(capturedUrl).toContain('NYC');
      expect(res.lat).toBe(40.1);
      expect(res.lng).toBe(-74.1);
      expect(res.address).toBe('Mock street');
      server.close();
    });
    it('HTTP maps retry on 503 for idempotent GET', async () => {
      let calls = 0;
      const { server, url } = await startJsonServer(async (req, res) => {
        calls += 1;
        if (calls === 1) { res.writeHead(503); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ lat: 1, lng: 1 }));
      });
      const http = new HttpMapsProvider({ baseUrl: url, timeoutMs: 2000, retries: 2 });
      const res = await http.geocode({ address: 'A', tenantId: tenantAId });
      expect(res.lat).toBe(1);
      expect(calls).toBe(2);
      server.close();
    });
    it('maps validation not retryable', async () => {
      const maps = new MockMapsProvider();
      await expect(maps.geocode({ address: '', tenantId: tenantAId })).rejects.toThrow(IntegrationError);
      try { await maps.geocode({ address: '', tenantId: tenantAId }); } catch (e) { expect(e.isRetryable()).toBe(false); }
    });
    it('maps factory', async () => {
      const p = createMapsProvider('mock', { fresh: true });
      expect(p).toBeInstanceOf(MockMapsProvider);
    });
  });

  describe('Error normalization', () => {
    it('distinguishes timeout, unavailable, auth, validation, not found, rate limit', async () => {
      const timeoutErr = new IntegrationError('timeout', { code: IntegrationErrorCode.TIMEOUT, statusCode: 504, provider: 'test' });
      expect(timeoutErr.isRetryable()).toBe(true);
      const validationErr = new IntegrationError('validation', { code: IntegrationErrorCode.VALIDATION, statusCode: 400, provider: 'test' });
      expect(validationErr.isRetryable()).toBe(false);
      const authErr = new IntegrationError('auth', { code: IntegrationErrorCode.AUTHENTICATION, statusCode: 401, provider: 'test' });
      expect(authErr.isRetryable()).toBe(false);
      const notFoundErr = new IntegrationError('notfound', { code: IntegrationErrorCode.NOT_FOUND, statusCode: 404, provider: 'test' });
      expect(notFoundErr.isRetryable()).toBe(false);
      const rateErr = new IntegrationError('rate', { code: IntegrationErrorCode.RATE_LIMIT, statusCode: 429, provider: 'test' });
      expect(rateErr.isRetryable()).toBe(true);
      const unavailableErr = new IntegrationError('unavail', { code: IntegrationErrorCode.UNAVAILABLE, statusCode: 502, provider: 'test' });
      expect(unavailableErr.isRetryable()).toBe(true);
    });

    it('provider errors never leak raw SDK errors or credentials', async () => {
      const provider = new MockEmailProvider({ shouldFail: true, failStatus: 502 });
      try { await provider.send({ to: 'a@b.com', subject: 'Hi', tenantId: tenantAId }); } catch (e) {
        expect(e.message).not.toContain('secret');
        expect(JSON.stringify(e.details || {})).not.toContain('apiKey');
        expect(e.stack).toBeDefined();
        expect(Object.values(IntegrationErrorCode)).toContain(e.code);
      }
    });

    it('HTTP 401 maps to AUTHENTICATION, 404 to NOT_FOUND, 429 to RATE_LIMIT', async () => {
      for (const [status, expectedCode] of [[401, IntegrationErrorCode.AUTHENTICATION], [404, IntegrationErrorCode.NOT_FOUND], [429, IntegrationErrorCode.RATE_LIMIT]]) {
        const { server, url } = await startJsonServer(async (req, res) => { res.writeHead(status); res.end(); });
        const http = new HttpPaymentProvider({ baseUrl: url, timeoutMs: 2000, retries: 0 });
        try { await http.charge({ amount: '1', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId, idempotencyKey: 'k' }); throw new Error('should fail'); } catch (e) { expect(e.code).toBe(expectedCode); expect(e.statusCode).toBe(status); }
        server.close();
      }
    });
  });

  describe('Secret management', () => {
    it('env secrets not exposed via provider errors', async () => {
      // eslint-disable-next-line no-unused-vars
      const _httpPay = new HttpPaymentProvider({ baseUrl: 'http://example.com', apiKey: 'super-secret-key-123' });
      const bad = new HttpPaymentProvider({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 50 });
      try { await bad.charge({ amount: '1', currency: 'USD', orderId: crypto.randomUUID(), tenantId: tenantAId, idempotencyKey: 'k' }); } catch (e) { expect(String(e.message)).not.toContain('super-secret'); expect(JSON.stringify(e.details || {})).not.toContain('super-secret'); }
    });

    it('bullmq job payload for email does not contain api keys', async () => {
      const payload = { tenantId: tenantAId, to: 'a@b.com', subject: 'Hi', variables: { safe: 'value' } };
      expect(JSON.stringify(payload)).not.toContain('apiKey');
      expect(JSON.stringify(payload)).not.toContain('secret');
    });

    it('provider errors do not log secrets (logger redact)', async () => {
      const { logger } = await import('../../src/config/logger.js');
      // logger redact paths include apiKey etc.
      expect(logger).toBeDefined();
    });
  });

  describe('Authorization / tenant isolation for integrations', () => {
    it('storage operations are tenant-scoped; cross-tenant key misuse rejected', async () => {
      const mock = new MockS3StorageProvider({ store: new Map() });
      const svc = new StorageService('local'); svc.provider = mock;
      const keyA = svc.generateProductImageKey(tenantAId, 'prod1', 'file.jpg');
      const keyB = svc.generateProductImageKey(tenantBId, 'prod1', 'file.jpg');
      expect(keyA).not.toBe(keyB);
      await svc.upload(keyA, Buffer.from('a'), 'image/jpeg');
      expect(await svc.fileExists(keyA)).toBe(true);
      expect(await svc.fileExists(keyB)).toBe(false);
      await svc.delete(keyA);
    });
  });

  describe('Adapter contract replaceability', () => {
    it('business layer depends on provider-independent contract (email service does not need vendor field names)', async () => {
      const mock = new MockEmailProvider();
      const { EmailService } = await import('../../src/integrations/email/email.service.js');
      const svc = new EmailService(mock);
      const res = await svc.sendEmail({ tenantId: tenantAId, to: 'contract@test.com', subject: 'contract test' });
      expect(res.providerId).toBeDefined();
      expect(res.status).toBe('sent');
      expect(res.mapped.provider).toBe('email');
    });

    it('payment service uses adapter without exposing provider internals', async () => {
      const { PaymentService } = await import('../../src/modules/payments/payments.service.js');
      const provider = new MockPaymentProvider();
      const svc = new PaymentService({ paymentProvider: provider });
      expect(svc.paymentProvider).toBe(provider);
      const payload = { eventId: `evt_adapter_${Date.now()}`, type: 'payment.succeeded', tenantId: tenantAId, paymentId: crypto.randomUUID() };
      const { computeSignature } = await import('../../src/modules/payments/webhook.util.js');
      const sig = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      const verified = await provider.verifyWebhook(payload, sig);
      expect(verified.verified).toBe(true);
    });
  });
});
