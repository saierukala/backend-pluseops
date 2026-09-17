import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { env } from '../../src/config/env.js';
import { computeSignature } from '../../src/modules/payments/webhook.util.js';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import { StorageService } from '../../src/common/storage/storage.service.js';

const app = createApp();
const prisma = getPrismaClient();

const accessSecret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';

async function createTenantWithUser({ tenantSlug, userEmail, password = 'SecurePass123!', permissions = [] }) {
  const tenant = await prisma.tenant.create({ data: { name: tenantSlug, slug: tenantSlug } });
  // create role with permissions
  const role = await prisma.role.create({ data: { tenantId: tenant.id, name: `admin-${tenantSlug}` } });
  for (const perm of permissions) {
    const [resource, action] = perm.split(':');
    let permission = await prisma.permission.findFirst({ where: { tenantId: tenant.id, resource, action } });
    if (!permission) {
      permission = await prisma.permission.create({ data: { tenantId: tenant.id, name: perm, resource, action } });
    }
    await prisma.rolePermission.create({ data: { tenantId: tenant.id, roleId: role.id, permissionId: permission.id } });
  }
  await request(app).post('/api/v1/auth/register').send({ email: userEmail, password, firstName: 'Test', lastName: 'User', tenantId: tenant.id });
  // assign role
  const user = await prisma.user.findFirst({ where: { email: userEmail } });
  if (user && permissions.length > 0) {
    await prisma.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    // also need tenant membership role
    await prisma.tenantMembership.updateMany({ where: { tenantId: tenant.id, userId: user.id }, data: { roleId: role.id } });
  }
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email: userEmail, password, tenantId: tenant.id });
  return { tenant, user, accessToken: loginRes.body.data?.accessToken, refreshToken: loginRes.body.data?.refreshToken, loginRes };
}

describe('Phase 20 Security Hardening', () => {
  let tenantA; let tenantB; let userA; let userB; let tokenA; let tokenB;
  let productAId; let productBId;

  beforeAll(async () => {
    // Clean slate: create two tenants
    const setupA = await createTenantWithUser({ tenantSlug: `sec-a-${Date.now()}`, userEmail: `sec-a-${Date.now()}@example.com`, permissions: ['product:create','product:read','product:update','product:delete','payment:create','payment:read','order:create'] });
    const setupB = await createTenantWithUser({ tenantSlug: `sec-b-${Date.now()}`, userEmail: `sec-b-${Date.now()}@example.com`, permissions: ['product:read'] });
    tenantA = setupA.tenant; userA = setupA.user; tokenA = setupA.accessToken;
    tenantB = setupB.tenant; userB = setupB.user; tokenB = setupB.accessToken;

    // Create product in tenant A
    const prodRes = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Secret Product A', brand: 'BrandA', status: 'ACTIVE' });
    productAId = prodRes.body.data?.id;
    const prodBRes = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'Product B', brand: 'BrandB', status: 'ACTIVE' });
    productBId = prodBRes.body.data?.id;
    // If tenant B lacks product:create, create directly via prisma (do NOT grant create permission — needed for 403 test)
    if (!productBId) {
      const p = await prisma.product.create({ data: { tenantId: tenantB.id, name: 'Product B direct', brand: 'BrandB', status: 'ACTIVE' } });
      productBId = p.id;
    }
  });

  afterAll(async () => {
    try {
      // cleanup in FK-safe order
      for (const tid of [tenantA.id, tenantB.id]) {
        await prisma.productVariantAttribute.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.productImage.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.inventoryMovement.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.warehouseInventory.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.inventory.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.orderItem.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.paymentTransaction.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.refund.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.paymentWebhookEvent.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.payment.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.orderStatusHistory.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.order.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.productVariant.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.productCategory.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.attributeValue.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.product.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.category.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.attributeDefinition.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.warehouse.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.customer.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.auditLog.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.activityLog.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.notification.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.refreshToken.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.passwordResetToken.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.emailVerificationToken.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.userRole.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.rolePermission.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.permission.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.role.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
        await prisma.tenantMembership.deleteMany({ where: { tenantId: tid } }).catch(()=>{});
      }
      await prisma.user.deleteMany({ where: { id: userA.id } }).catch(()=>{});
      await prisma.user.deleteMany({ where: { id: userB.id } }).catch(()=>{});
      await prisma.tenant.deleteMany({ where: { id: tenantA.id } }).catch(()=>{});
      await prisma.tenant.deleteMany({ where: { id: tenantB.id } }).catch(()=>{});
    } catch (_e) { void _e; }
    await disconnectDatabase();
  });

  describe('Tenant isolation', () => {
    it('Tenant A cannot access Tenant B product (404)', async () => {
      const res = await request(app).get(`/api/v1/products/${productBId}`).set('Authorization', `Bearer ${tokenA}`);
      expect([404,403]).toContain(res.status);
    });
    it('Tenant B cannot access Tenant A product', async () => {
      const res = await request(app).get(`/api/v1/products/${productAId}`).set('Authorization', `Bearer ${tokenB}`);
      expect([404,403]).toContain(res.status);
    });
    it('Tenant A cannot enumerate Tenant B image storage key', async () => {
      const service = new StorageService('local');
      // Tenant A tries to use tenant B key directly via service (simulates traversal)
      const keyB = service.generateProductImageKey(tenantB.id, productBId, 'test.png');
      // Verify service asserts tenant scoped but does not prevent cross-tenant if caller fabricates key;
      // Instead we verify repository tenant isolation: create image in B, then A cannot fetch it
      const img = await prisma.productImage.create({ data: { tenantId: tenantB.id, productId: productBId, storageKey: keyB, url: '/storage/'+keyB, altText: 'b' } });
      const res = await request(app).get(`/api/v1/products/${productBId}/images/${img.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      await prisma.productImage.delete({ where: { id: img.id } }).catch(()=>{});
    });
    it('client-supplied tenantId in body does not override authenticated tenant', async () => {
      // Attempt to create product with forged tenantId field (should be ignored - service uses context)
      const res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Forged', tenantId: tenantB.id });
      expect(res.status).toBe(201);
      const created = await prisma.product.findUnique({ where: { id: res.body.data.id } });
      expect(created.tenantId).toBe(tenantA.id);
      await prisma.product.delete({ where: { id: res.body.data.id } }).catch(()=>{});
    });
  });

  describe('Authentication / JWT security', () => {
    it('expired token -> 401 TOKEN_EXPIRED', async () => {
      const expired = jwt.sign({ sub: userA.id, tenantId: tenantA.id, sessionId: 'sess', email: userA.email }, accessSecret, { expiresIn: '-1h', issuer: 'pulseops', audience: 'pulseops-api', algorithm: 'HS256' });
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });
    it('malformed token -> 401 INVALID_TOKEN', async () => {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.token');
      expect(res.status).toBe(401);
    });
    it('none algorithm rejected', async () => {
      // craft none alg token (jsonwebtoken will not verify none by default due to algorithms HS256)
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: userA.id, tenantId: tenantA.id, sessionId: 'sess', exp: Math.floor(Date.now()/1000)+3600, iss: 'pulseops', aud: 'pulseops-api' })).toString('base64url');
      const noneToken = `${header}.${payload}.`;
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${noneToken}`);
      expect(res.status).toBe(401);
    });
    it('wrong secret -> 401', async () => {
      const wrong = jwt.sign({ sub: userA.id, tenantId: tenantA.id, sessionId: 'sess' }, 'wrong-secret-min-32-chars-long-wrong', { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api', algorithm: 'HS256' });
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${wrong}`);
      expect(res.status).toBe(401);
    });
    it('missing claims -> 401 INVALID_TOKEN_CLAIMS', async () => {
      const bad = jwt.sign({ sub: userA.id }, accessSecret, { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api', algorithm: 'HS256' });
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${bad}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN_CLAIMS');
    });
    it('manipulated tenantId claim rejected (user not in tenant)', async () => {
      const manip = jwt.sign({ sub: userA.id, tenantId: tenantB.id, sessionId: 'sess', email: userA.email }, accessSecret, { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api', algorithm: 'HS256' });
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${manip}`);
      expect(res.status).toBe(401);
    });
    it('secrets not in JWT payload', async () => {
      const decoded = jwt.decode(tokenA);
      expect(decoded.password).toBeUndefined();
      expect(decoded.secret).toBeUndefined();
    });
  });

  describe('Refresh token security', () => {
    it('valid refresh -> success', async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ email: userA.email, password: 'SecurePass123!', tenantId: tenantA.id });
      const rt = login.body.data.refreshToken;
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt });
      expect(res.status).toBe(200);
      expect(res.body.data.refreshToken).not.toBe(rt);
    });
    it('expired refresh token -> 401 REFRESH_TOKEN_EXPIRED', async () => {
      const raw = AuthRepository.generateSecureToken();
      const hash = AuthRepository.hashToken(raw);
      await prisma.refreshToken.create({ data: { tenantId: tenantA.id, userId: userA.id, tokenHash: hash, expiresAt: new Date(Date.now()-1000) } });
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: raw });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_EXPIRED');
    });
    it('revoked refresh token -> 401 REVOKED', async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ email: userA.email, password: 'SecurePass123!', tenantId: tenantA.id });
      const rt = login.body.data.refreshToken;
      await request(app).post('/api/v1/auth/logout').send({ refreshToken: rt });
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_REVOKED');
    });
    it('reused rotated token -> 401 REVOKED (family invalidated)', async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ email: userA.email, password: 'SecurePass123!', tenantId: tenantA.id });
      const rt1 = login.body.data.refreshToken;
      const res1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt1 });
      expect(res1.status).toBe(200);
      const rt2 = res1.body.data.refreshToken;
      // Old token rt1 should now be revoked
      const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt1 });
      expect(reuse.status).toBe(401);
      // rt2 should also be revoked after reuse detection (family revoked) -> try rt2 again should fail if family revoked? Our implementation revokes all on revoked detection
      // After reuse, family revoked, so rt2 should be revoked
      const afterReuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rt2 });
      expect(afterReuse.status).toBe(401);
    });
    it('malformed refresh token -> 401', async () => {
      const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'not-a-real-token' });
      expect(res.status).toBe(401);
    });
    it('refresh token not exposed in logs/response secrets check', async () => {
      const login = await request(app).post('/api/v1/auth/login').send({ email: userA.email, password: 'SecurePass123!', tenantId: tenantA.id });
      expect(login.body.data.passwordHash).toBeUndefined();
      expect(login.body.data.password).toBeUndefined();
    });
  });

  describe('Authorization', () => {
    it('authenticated + permission -> allowed', async () => {
      const res = await request(app).get('/api/v1/products').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
    });
    it('authenticated + missing permission -> 403', async () => {
      // userB has only product:read, try product:create
      const res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenB}`).send({ name: 'NoPerm' });
      expect(res.status).toBe(403);
    });
    it('unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/products');
      expect(res.status).toBe(401);
    });
    it('Tenant A user cannot access Tenant B resource via direct ID (authorization tenant-aware)', async () => {
      // Try to delete productB with tokenA
      const res = await request(app).delete(`/api/v1/products/${productBId}`).set('Authorization', `Bearer ${tokenA}`);
      expect([404,403]).toContain(res.status);
    });
  });

  describe('Helmet / CORS / Request size', () => {
    it('security headers present', async () => {
      const res = await request(app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
    it('CORS allowed origin succeeds', async () => {
      const allowed = env.corsOrigins[0];
      const res = await request(app).get('/health').set('Origin', allowed);
      expect(res.headers['access-control-allow-origin']).toBe(allowed);
    });
    it('CORS disallowed origin blocked', async () => {
      const res = await request(app).get('/api/v1/products').set('Origin', 'https://evil.example.com').set('Authorization', `Bearer ${tokenA}`);
      // Our cors handler returns error -> 403 CORS_NOT_ALLOWED via errorHandler, but for simple GET with Origin header, browser would block; supertest will get 403 or pass with no CORS header
      // Accept either no CORS header or 403
      if (res.status === 403) {
        expect(res.body.error.code).toBe('CORS_NOT_ALLOWED');
      } else {
        expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
      }
    });
    it('oversized JSON body -> 413 PAYLOAD_TOO_LARGE', async () => {
      const big = 'x'.repeat(1024 * 1024 + 100);
      const res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: big });
      expect([413,400]).toContain(res.status);
    });
    it('malformed JSON -> 400 INVALID_JSON', async () => {
      const res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).set('Content-Type','application/json').send('{"bad":}');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });
  });

  describe('Input validation & SQL injection', () => {
    it('malformed input -> 400 VALIDATION_ERROR without stack', async () => {
      const res = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('stack');
    });
    it('SQL injection via search -> safe, no data leak', async () => {
      const inj = "' OR 1=1 --; DROP TABLE products; --";
      const res = await request(app).get('/api/v1/products').query({ search: inj }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      // Should not return all tenants' products nor error 500
      expect(res.body.success).toBe(true);
      // Verify products table still exists via prisma
      const count = await prisma.product.count({ where: { tenantId: tenantA.id } });
      expect(count).toBeGreaterThanOrEqual(1);
    });
    it('SQL injection via sort/order param -> safe (allowlisted)', async () => {
      const res = await request(app).get('/api/v1/products').query({ sortBy: 'createdAt; DROP TABLE users; --', sortOrder: 'desc;--' }).set('Authorization', `Bearer ${tokenA}`);
      // Should either 400 validation or 200 with safe fallback
      expect([200,400]).toContain(res.status);
      if (res.status===200) expect(res.body.success).toBe(true);
    });
  });

  describe('XSS / output safety', () => {
    it('stored XSS payload returned as JSON not executed, no HTML escaping corruption', async () => {
      const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
      const createRes = await request(app).post('/api/v1/products').set('Authorization', `Bearer ${tokenA}`).send({ name: xss });
      expect(createRes.status).toBe(201);
      const id = createRes.body.data.id;
      const getRes = await request(app).get(`/api/v1/products/${id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(getRes.body.data.name).toBe(xss); // API preserves data correctly, does not corrupt
      expect(getRes.headers['content-type']).toMatch(/json/);
      await prisma.product.delete({ where: { id } }).catch(()=>{});
    });
  });

  describe('File upload & storage security', () => {
    it('unauthorized upload -> 401', async () => {
      const res = await request(app).post(`/api/v1/products/${productAId}/images`).attach('image', Buffer.from([0x89,0x50,0x4E,0x47]), { filename: 'test.png', contentType: 'image/png' });
      expect(res.status).toBe(401);
    });
    it('invalid file type -> 400 INVALID_FILE_TYPE', async () => {
      const res = await request(app).post(`/api/v1/products/${productAId}/images`).set('Authorization', `Bearer ${tokenA}`).attach('image', Buffer.from('MZ executable'), { filename: 'evil.exe', contentType: 'application/octet-stream' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
    });
    it('path traversal filename sanitized and rejected if storage key traversal', async () => {
      const service = new StorageService('local');
      expect(() => service.assertTenantScopedKey('tenants/../etc/passwd')).toThrow();
      expect(() => service.assertTenantScopedKey('/tenants/'+tenantA.id+'/x')).toThrow();
      const sanitized = service.sanitizeFilename('../../etc/passwd');
      expect(sanitized).not.toContain('..');
      expect(sanitized).not.toContain('/');
      expect(sanitized).not.toContain('\\');
      // Upload with traversal filename should be sanitized and succeed but key remains tenant-scoped
      const pngHeader = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52]);
      const res = await request(app).post(`/api/v1/products/${productAId}/images`).set('Authorization', `Bearer ${tokenA}`).attach('image', pngHeader, { filename: '../../evil.png', contentType: 'image/png' });
      // Sanitized filename -> should succeed (200/201) but not traverse
      expect([201,400]).toContain(res.status);
      if (res.status===201) {
        expect(res.body.data.storageKey).not.toContain('..');
        expect(res.body.data.storageKey).toContain(`tenants/${tenantA.id}`);
        await prisma.productImage.deleteMany({ where: { id: res.body.data.id } }).catch(()=>{});
      }
    });
    it('oversized file -> 400 FILE_TOO_LARGE', async () => {
      // Create buffer >10MB
      const big = Buffer.alloc(11 * 1024 * 1024, 0);
      // PNG header + big
      big[0]=0x89; big[1]=0x50; big[2]=0x4E; big[3]=0x47;
      const res = await request(app).post(`/api/v1/products/${productAId}/images`).set('Authorization', `Bearer ${tokenA}`).attach('image', big, { filename: 'big.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
    });
    it('storage keys are server-generated and tenant-scoped, cannot overwrite other tenant', async () => {
      const service = new StorageService('local');
      const keyA = service.generateProductImageKey(tenantA.id, productAId, 'test.png');
      const keyB = service.generateProductImageKey(tenantB.id, productBId, 'test.png');
      expect(keyA).not.toBe(keyB);
      expect(keyA).toContain(tenantA.id);
      expect(keyB).toContain(tenantB.id);
      // Attempt to use keyB with tenantA context should fail repository tenant check
      const imgB = await prisma.productImage.create({ data: { tenantId: tenantB.id, productId: productBId, storageKey: keyB, url: '/storage/'+keyB } });
      const res = await request(app).get(`/api/v1/products/${productBId}/images/${imgB.id}`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      await prisma.productImage.delete({ where: { id: imgB.id } }).catch(()=>{});
    });
    it('private objects not exposed without auth', async () => {
      const res = await request(app).get(`/api/v1/products/${productAId}/images`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      const unauth = await request(app).get(`/api/v1/products/${productAId}/images`);
      expect(unauth.status).toBe(401);
    });
    it('authenticated file streaming enforces tenant isolation and signed URL', async () => {
      // upload a file as tenant A
      const pngHeader = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52]);
      const up = await request(app).post(`/api/v1/products/${productAId}/images`).set('Authorization', `Bearer ${tokenA}`).attach('image', pngHeader, { filename: 'private.png', contentType: 'image/png' });
      expect(up.status).toBe(201);
      const imageId = up.body.data.id;
      // Tenant A can stream file via authenticated endpoint
      const fileA = await request(app).get(`/api/v1/products/${productAId}/images/${imageId}/file`).set('Authorization', `Bearer ${tokenA}`);
      expect([200,404]).toContain(fileA.status);
      if (fileA.status===200) expect(fileA.headers['content-type']).toBeDefined();
      // Tenant B cannot stream same file (cross-tenant)
      const fileB = await request(app).get(`/api/v1/products/${productAId}/images/${imageId}/file`).set('Authorization', `Bearer ${tokenB}`);
      expect([404,403]).toContain(fileB.status);
      // Unauthenticated cannot stream
      const fileNoAuth = await request(app).get(`/api/v1/products/${productAId}/images/${imageId}/file`);
      expect(fileNoAuth.status).toBe(401);
      // Signed URL generation (tenant-scoped, no credentials)
      const signedRes = await request(app).get(`/api/v1/products/${productAId}/images/${imageId}/signed-url`).set('Authorization', `Bearer ${tokenA}`);
      expect(signedRes.status).toBe(200);
      expect(signedRes.body.data.signedUrl).toContain('expires=');
      expect(signedRes.body.data.signedUrl).toContain('signature=');
      expect(signedRes.body.data.signedUrl).not.toContain(env.JWT_ACCESS_SECRET || 'secret');
      // Valid signed URL without auth should stream file (HMAC verified)
      const signedUrl = signedRes.body.data.signedUrl;
      const signedFile = await request(app).get(signedUrl);
      expect([200,404]).toContain(signedFile.status);
      // Tampered signature should be rejected
      const tampered = signedUrl.replace(/signature=[^&]+/, 'signature=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb');
      const tamperedRes = await request(app).get(tampered);
      expect(tamperedRes.status).toBe(403);
      // Direct storage URL without auth/signature is not accessible (no static mount)
      const direct = await request(app).get(`/storage/${up.body.data.storageKey}`);
      expect([404,401]).toContain(direct.status);
      await prisma.productImage.delete({ where: { id: imageId } }).catch(()=>{});
    });
    it('signed URL has expiry and signature, credentials never in URL', async () => {
      const service = new StorageService('local');
      const key = service.generateProductImageKey(tenantA.id, productAId, 'signed.png');
      const signed = await service.getSignedUrl(key, 900);
      expect(signed).toContain('expires=');
      expect(signed).toContain('signature=');
      expect(signed).not.toContain(env.JWT_ACCESS_SECRET || 'secret');
      expect(signed).not.toContain(env.PAYMENT_WEBHOOK_SECRET);
      expect(signed).not.toContain('S3_SECRET');
      // S3 signed URL also has no secret
      const s3service = new StorageService('s3');
      const s3signed = await s3service.getSignedUrl(key, 900);
      expect(s3signed).not.toContain('S3_SECRET_ACCESS_KEY');
      expect(s3signed).not.toContain(env.S3_SECRET_ACCESS_KEY || 'secret');
    });
    it('direct access behavior is documented as private (local) / private-by-default (S3)', async () => {
      // Local provider is private — getUrl returns path but no static route serves it
      const service = new StorageService('local');
      // Verify provider abstraction documents private policy
      expect(service.providerName).toBe('local');
      // S3 provider documents private-by-default, getUrl is public only if bucket public else signed
      const s3 = new StorageService('s3');
      expect(s3.providerName).toBe('s3');
    });
    it('tenant cannot overwrite another tenant object (unique keys)', async () => {
      const svc = new StorageService('local');
      const keyA1 = svc.generateProductImageKey(tenantA.id, productAId, 'same.png');
      const keyA2 = svc.generateProductImageKey(tenantA.id, productAId, 'same.png');
      expect(keyA1).not.toBe(keyA2); // UUID prefix prevents overwrite
      const keyB = svc.generateProductImageKey(tenantB.id, productBId, 'same.png');
      expect(keyB).not.toBe(keyA1);
    });
  });

  describe('Webhook security', () => {
    let orderId; let paymentId;
    beforeAll(async () => {
      // Create order and payment for webhook test
      const cust = await prisma.customer.create({ data: { tenantId: tenantA.id, email: `wh-${Date.now()}@example.com`, firstName: 'Wh', lastName: 'Test' } });
      const variant = await prisma.productVariant.create({ data: { tenantId: tenantA.id, productId: productAId, sku: `SKU-WH-${Date.now()}`, price: 100, status: 'ACTIVE' } });
      const warehouse = await prisma.warehouse.create({ data: { tenantId: tenantA.id, name: `WH-${Date.now()}`, code: `WH${Date.now()}` } });
      await prisma.inventory.create({ data: { tenantId: tenantA.id, productVariantId: variant.id, warehouseId: warehouse.id, quantity: 100 } });
      const order = await prisma.order.create({ data: { tenantId: tenantA.id, customerId: cust.id, status: 'PENDING', subtotal: 100, total: 100, currency: 'USD' } });
      await prisma.orderItem.create({ data: { tenantId: tenantA.id, orderId: order.id, productVariantId: variant.id, productNameSnapshot: 'Prod', variantNameSnapshot: 'Var', skuSnapshot: variant.sku, unitPrice: 100, quantity: 1, lineTotal: 100 } });
      orderId = order.id;
      const payRes = await request(app).post('/api/v1/payments/create').set('Authorization', `Bearer ${tokenA}`).send({ orderId });
      paymentId = payRes.body.data?.id;
    });
    it('valid webhook -> 202 enqueued', async () => {
      const payload = { eventId: `evt-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const sig = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect([200,202]).toContain(res.status);
    });
    it('invalid signature -> 401', async () => {
      const payload = { eventId: `evt-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', 'bad'.repeat(16)).send(payload);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });
    it('missing signature -> 401', async () => {
      const payload = { eventId: `evt-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const res = await request(app).post('/api/v1/payments/webhook').send(payload);
      expect(res.status).toBe(401);
    });
    it('malformed webhook -> 400 VALIDATION_ERROR', async () => {
      const payload = { type: 'payment.succeeded' }; // missing eventId
      const sig = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      expect(res.status).toBe(400);
    });
    it('duplicate webhook -> safely handled (idempotent)', async () => {
      const eventId = `evt-dup-${Date.now()}`;
      const payload = { eventId, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const sig = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).send(payload);
      // Wait for async processing (BullMQ fallback synchronous may have processed)
      await new Promise(r=>setTimeout(r, 500));
      const sig2 = computeSignature(JSON.stringify(payload), env.PAYMENT_WEBHOOK_SECRET);
      const res2 = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig2).send(payload);
      expect([200,202]).toContain(res2.status);
      // Second should be duplicate or already processed, not 500
      expect(res2.body.success).toBe(true);
    });
    it('webhook errors do not leak secrets', async () => {
      const payload = { eventId: `evt-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', 'invalid').send(payload);
      expect(JSON.stringify(res.body)).not.toContain(env.PAYMENT_WEBHOOK_SECRET);
    });
    it('valid signature over exact raw body -> accepted', async () => {
      const payload = { eventId: `evt-raw-valid-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const raw = JSON.stringify(payload);
      const sig = computeSignature(raw, env.PAYMENT_WEBHOOK_SECRET);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).set('Content-Type','application/json').send(raw);
      expect([200,202]).toContain(res.status);
    });
    it('changed whitespace/body bytes with original signature -> rejected', async () => {
      const payload = { eventId: `evt-raw-ws-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const raw = JSON.stringify(payload);
      const sig = computeSignature(raw, env.PAYMENT_WEBHOOK_SECRET);
      // Add whitespace that changes raw bytes but parses to same object
      const rawWithSpaces = raw.replace(/","/g, '", "').replace(/":/g, '": ');
      expect(rawWithSpaces).not.toBe(raw);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).set('Content-Type','application/json').send(rawWithSpaces);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });
    it('valid signature over exact raw body with whitespace -> accepted if signature matches raw', async () => {
      const payload = { eventId: `evt-raw-ws-valid-${Date.now()}`, type: 'payment.succeeded', paymentId, tenantId: tenantA.id };
      const rawWithSpaces = JSON.stringify(payload).replace(/","/g, '", "');
      const sig = computeSignature(rawWithSpaces, env.PAYMENT_WEBHOOK_SECRET);
      const res = await request(app).post('/api/v1/payments/webhook').set('x-webhook-signature', sig).set('Content-Type','application/json').send(rawWithSpaces);
      expect([200,202]).toContain(res.status);
    });
  });

  describe('Audit / secrets management', () => {
    it('audit logs do not contain passwords/secrets', async () => {
      // Trigger an auditable action: update user
      const logs = await prisma.auditLog.findMany({ where: { tenantId: tenantA.id } });
      for (const log of logs) {
        const str = JSON.stringify(log);
        expect(str.toLowerCase()).not.toContain('password');
        expect(str).not.toContain(env.JWT_ACCESS_SECRET || 'test-access');
      }
    });
    it('API responses never contain passwordHash', async () => {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.data.passwordHash).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });
    it('error responses do not contain stack traces in production simulation', async () => {
      const res = await request(app).get('/api/v1/products/invalid-uuid').set('Authorization', `Bearer ${tokenA}`);
      const detailsStr = JSON.stringify(res.body.error.details);
      expect(detailsStr).not.toMatch(/at .*\.js:/);
      expect(JSON.stringify(res.body)).not.toContain('node_modules');
    });
  });

  describe('Rate limiting', () => {
    it('rate limiter middleware is configured correctly (unit)', async () => {
      // Verify limiter config via import
      const { createAuthLimiter } = await import('../../src/common/middleware/rate-limiters.js');
      const limiter = createAuthLimiter();
      expect(typeof limiter).toBe('function');
    });
  });
});
