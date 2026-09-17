import jwt from 'jsonwebtoken';
import { signAccessToken, verifyAccessToken } from '../../src/modules/auth/jwt.util.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.util.js';
import { parseExpiry } from '../../src/modules/auth/token-expiry.util.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { tenantKey, productListKey, productListPattern } from '../../src/common/cache/cache.keys.js';
import { computeSignature, verifyWebhookSignature } from '../../src/modules/payments/webhook.util.js';
import { createAuthLimiter, createGlobalLimiter } from '../../src/common/middleware/rate-limiters.js';
import { authorize } from '../../src/modules/auth/authorization.middleware.js';
import { env } from '../../src/config/env.js';

describe('Unit – password utils', () => {
  it('hashes and verifies Argon2id', async () => {
    const pwd = 'StrongPass1!';
    const h = await hashPassword(pwd);
    expect(h).not.toBe(pwd);
    expect(await verifyPassword(h, pwd)).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });
  it('hash is salted (different hashes for same password)', async () => {
    const h1 = await hashPassword('SamePass1!');
    const h2 = await hashPassword('SamePass1!');
    expect(h1).not.toBe(h2);
  });
});

describe('Unit – JWT utils', () => {
  it('sign and verify access token with correct claims', () => {
    const payload = { sub: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222', sessionId: 'sess-1', email: 'a@b.com' };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.tenantId).toBe(payload.tenantId);
    expect(decoded.sessionId).toBe(payload.sessionId);
    expect(decoded.iss).toBe('pulseops');
    expect(decoded.aud).toBe('pulseops-api');
  });
  it('verify rejects none algorithm', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', tenantId: 'y', sessionId: 's', exp: Math.floor(Date.now()/1000)+3600, iss: 'pulseops', aud: 'pulseops-api' })).toString('base64url');
    const none = `${header}.${payload}.`;
    expect(() => verifyAccessToken(none)).toThrow();
  });
  it('verify rejects wrong issuer', () => {
    const secret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
    const wrongIss = jwt.sign({ sub: 'x', tenantId: 'y', sessionId: 's' }, secret, { expiresIn: '15m', issuer: 'evil', audience: 'pulseops-api', algorithm: 'HS256' });
    expect(() => verifyAccessToken(wrongIss)).toThrow();
  });
  it('expired token throws TokenExpiredError', () => {
    const secret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
    const expired = jwt.sign({ sub: 'x', tenantId: 'y', sessionId: 's' }, secret, { expiresIn: '-10s', issuer: 'pulseops', audience: 'pulseops-api', algorithm: 'HS256' });
    expect(() => verifyAccessToken(expired)).toThrow();
  });
});

describe('Unit – token expiry helpers (parseExpiry)', () => {
  it('parses s/m/h/d units correctly', () => {
    expect(parseExpiry('60s')).toBe(60000);
    expect(parseExpiry('15m')).toBe(900000);
    expect(parseExpiry('2h')).toBe(7200000);
    expect(parseExpiry('7d')).toBe(604800000);
  });
  it('rejects invalid format', () => {
    expect(() => parseExpiry('invalid')).toThrow();
    expect(() => parseExpiry('15x')).toThrow();
  });
});

describe('Unit – StorageService', () => {
  it('sanitizes traversal filenames', () => {
    const svc = new StorageService('local');
    expect(svc.sanitizeFilename('../../etc/passwd')).not.toContain('..');
    expect(svc.sanitizeFilename('../../etc/passwd')).not.toContain('/');
    expect(svc.sanitizeFilename('/absolute/path.jpg')).toBe('path.jpg');
    expect(svc.sanitizeFilename('test.exe')).toBe('test.jpg'); // .exe fallback
  });
  it('generates tenant-scoped keys with UUID prefix', () => {
    const svc = new StorageService('local');
    const tid = '11111111-1111-4111-8111-111111111111';
    const pid = '22222222-2222-4222-8222-222222222222';
    const k = svc.generateProductImageKey(tid, pid, 'photo.jpg');
    expect(k).toContain(`tenants/${tid}/products/${pid}/`);
    expect(k).not.toContain('..');
    expect(k).toMatch(/\.jpg$/);
    const k2 = svc.generateProductImageKey(tid, pid, 'photo.jpg');
    expect(k).not.toBe(k2); // unique prefix
  });
  it('assertTenantScopedKey rejects traversal', () => {
    const svc = new StorageService('local');
    expect(() => svc.assertTenantScopedKey('tenants/../evil')).toThrow();
    expect(() => svc.assertTenantScopedKey('/tenants/x/y')).toThrow();
    expect(() => svc.assertTenantScopedKey('not-tenants/x')).toThrow();
  });
  it('validateImageFile rejects invalid mime', () => {
    const svc = new StorageService('local');
    expect(() => svc.validateImageFile({ mimetype: 'application/octet-stream', size: 100, originalname: 'evil.exe', buffer: Buffer.from('MZ') })).toThrow();
  });
  it('validateImageFile rejects oversized', () => {
    const svc = new StorageService('local');
    const big = Buffer.alloc(11 * 1024 * 1024);
    expect(() => svc.validateImageFile({ mimetype: 'image/png', size: big.length, originalname: 'big.png', buffer: big })).toThrow();
  });
  it('validateImageMagicBytes works for PNG and JPEG', () => {
    const svc = new StorageService('local');
    const png = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,0]);
    expect(svc.validateImageMagicBytes(png, 'image/png')).toBe(true);
    const jpeg = Buffer.from([0xFF,0xD8,0xFF,0x00,0,0,0,0]);
    expect(svc.validateImageMagicBytes(jpeg, 'image/jpeg')).toBe(true);
    expect(svc.validateImageMagicBytes(png, 'image/jpeg')).toBe(false);
  });
});

describe('Unit – cache keys', () => {
  it('tenantKey different tenants produce different keys', () => {
    expect(tenantKey('a')).not.toBe(tenantKey('b'));
  });
  it('productListKey includes all query params', () => {
    const tid = '11111111-1111-4111-8111-111111111111';
    const k1 = productListKey(tid, { page:1, limit:10, search:'a' });
    const k2 = productListKey(tid, { page:2, limit:10, search:'a' });
    expect(k1).not.toBe(k2);
  });
  it('productListPattern is prefix for tenant', () => {
    const tid = '11111111-1111-4111-8111-111111111111';
    const pattern = productListPattern(tid);
    expect(pattern).toContain(tid);
    expect(pattern).toContain('*');
  });
  it('cache keys do not contain secrets', () => {
    const k = productListKey('11111111-1111-4111-8111-111111111111', { page:1 });
    expect(k).not.toMatch(/password|secret|token/i);
  });
});

describe('Unit – webhook signature', () => {
  it('compute and verify HMAC via verifyWebhookSignature', () => {
    const secret = 'test-webhook-secret-min-32-chars-long-for-testing';
    const payload = JSON.stringify({ eventId: 'evt_123', type: 'payment.succeeded' });
    const sig = computeSignature(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, 'bad', secret)).toBe(false);
    expect(verifyWebhookSignature(payload+'x', sig, secret)).toBe(false);
    // buffer variant should still verify same HMAC
    expect(verifyWebhookSignature(Buffer.from(payload), sig, secret)).toBe(true);
    // object serialization matches same JSON string order -> verifies true (demonstrates payload normalization)
    expect(verifyWebhookSignature({ eventId: 'evt_123', type: 'payment.succeeded' }, sig, secret)).toBe(true);
  });
});

describe('Unit – rate limiter config', () => {
  it('auth limiter is function', () => {
    const l = createAuthLimiter();
    expect(typeof l).toBe('function');
  });
  it('global limiter is function', () => {
    const l = createGlobalLimiter();
    expect(typeof l).toBe('function');
  });
});

describe('Unit – permission logic (authorize middleware)', () => {
  it('authorize returns middleware function requiring permission', () => {
    const mw = authorize('product:create');
    expect(typeof mw).toBe('function');
  });
  it('authorize with no permission still requires auth (returns function)', () => {
    const mw = authorize();
    expect(typeof mw).toBe('function');
  });
  it('middleware rejects unauthenticated', async () => {
    const mw = authorize('product:read');
    const req = { context: null };
    const res = {};
    const next = (err) => {
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(401);
    };
    await mw(req, res, next);
  });
});

describe('Unit – audit sanitize', () => {
  it('sanitizeValue strips/redacts sensitive fields', async () => {
    const { sanitizeValue, sanitizeAuditValues } = await import('../../src/modules/audit/audit.sanitize.js');
    const input = { email: 'a@b.com', password: 'secret', token: 'abc', safe: 'keep', nested: { passwordHash: 'hash', ok: 1 } };
    const out = sanitizeValue(input);
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.safe).toBe('keep');
    expect(out.nested.passwordHash).toBe('[REDACTED]');
    expect(out.nested.ok).toBe(1);
    const av = sanitizeAuditValues({ old: '1', password: 'p' }, { new: '2', secret: 's', keep: 'yes' });
    expect(av.oldValue.password).toBe('[REDACTED]');
    expect(av.newValue.secret).toBe('[REDACTED]');
    expect(av.newValue.keep).toBe('yes');
  });
});

describe('Unit – realtime sanitize', () => {
  it('sanitizeForTest strips secrets', async () => {
    const { sanitizeForTest } = await import('../../src/realtime/realtime.service.js');
    const out = sanitizeForTest({ id: '1', password: 'x', secret: 'y', keep: 'yes', nested: { cookie: 'c', keep2: 'y2' } });
    expect(out.password).toBeUndefined();
    expect(out.secret).toBeUndefined();
    expect(out.keep).toBe('yes');
    expect(out.nested.keep2).toBe('y2');
    expect(out.nested.cookie).toBeUndefined();
  });
});
