import { CacheService } from '../../src/common/cache/cache.service.js';
import { tenantKey, tenantSettingsKey, productListKey, productListPattern, userPermissionsKey, permissionsListKey } from '../../src/common/cache/cache.keys.js';
import { CACHE_TTL } from '../../src/common/cache/cache.config.js';
import { TenantService } from '../../src/modules/tenants/tenants.service.js';
import { PermissionService } from '../../src/modules/permissions/permissions.service.js';
import { ProductService } from '../../src/modules/products/products.service.js';

// In-memory fake redis for deterministic tests
class FakeRedis {
  constructor() {
    this.store = new Map();
    this.ttl = new Map();
    this.failNext = null;
  }
  async get(key) {
    if (this.failNext === 'get') { this.failNext = null; throw new Error('Redis GET failure'); }
    const val = this.store.get(key);
    if (val === undefined) return null;
    const exp = this.ttl.get(key);
    if (exp && Date.now() > exp) {
      this.store.delete(key);
      this.ttl.delete(key);
      return null;
    }
    return val;
  }
  async set(key, value, ...args) {
    if (this.failNext === 'set') { this.failNext = null; throw new Error('Redis SET failure'); }
    this.store.set(key, value);
    const exIndex = args.indexOf('EX');
    if (exIndex !== -1) {
      const ttl = args[exIndex + 1];
      this.ttl.set(key, Date.now() + ttl * 1000);
    }
    return 'OK';
  }
  async del(...keys) {
    if (this.failNext === 'del') { this.failNext = null; throw new Error('Redis DEL failure'); }
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) { this.ttl.delete(k); count++; }
    }
    return count;
  }
  async scan(cursor, ...args) {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx !== -1 ? args[matchIdx + 1] : '*';
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const keys = [...this.store.keys()].filter((k) => regex.test(k));
    return ['0', keys];
  }
  simulateFailure(op) { this.failNext = op; }
}

describe('Phase 14 - Redis Caching', () => {
  // ---------- CacheService unit tests ----------
  describe('CacheService', () => {
    it('cache miss returns null', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const result = await cache.get('pulseops:v1:miss:key');
      expect(result).toBeNull();
    });

    it('cache hit returns cached value without hitting loader', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      await cache.set('pulseops:v1:test:key', { foo: 'bar' }, 60);
      const hit = await cache.get('pulseops:v1:test:key');
      expect(hit).toEqual({ foo: 'bar' });

      let loaderCalled = false;
      const { value, hit: isHit } = await cache.getOrSet('pulseops:v1:test:key', async () => { loaderCalled = true; return { foo: 'new' }; }, 60);
      expect(isHit).toBe(true);
      expect(loaderCalled).toBe(false);
      expect(value).toEqual({ foo: 'bar' });
    });

    it('cache miss loads, sets, and returns value', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      let loaderCalled = false;
      const { value, hit } = await cache.getOrSet('pulseops:v1:load:key', async () => { loaderCalled = true; return { data: 123 }; }, 60);
      expect(hit).toBe(false);
      expect(loaderCalled).toBe(true);
      expect(value).toEqual({ data: 123 });
      const cached = await cache.get('pulseops:v1:load:key');
      expect(cached).toEqual({ data: 123 });
    });

    it('invalidation deletes entry', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      await cache.set('pulseops:v1:inv:key', { a: 1 }, 60);
      expect(await cache.get('pulseops:v1:inv:key')).toEqual({ a: 1 });
      await cache.del('pulseops:v1:inv:key');
      expect(await cache.get('pulseops:v1:inv:key')).toBeNull();
    });

    it('expiration causes cache miss after TTL', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      await cache.set('pulseops:v1:exp:key', { val: 'short' }, 1);
      expect(await cache.get('pulseops:v1:exp:key')).toEqual({ val: 'short' });
      await new Promise((r) => setTimeout(r, 1100));
      expect(await cache.get('pulseops:v1:exp:key')).toBeNull();
      // after expiration loader should be called
      const { value, hit } = await cache.getOrSet('pulseops:v1:exp:key', async () => ({ val: 'fresh' }), 60);
      expect(hit).toBe(false);
      expect(value).toEqual({ val: 'fresh' });
    });

    it('Redis unavailable on GET falls back to null', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      fake.simulateFailure('get');
      const result = await cache.get('pulseops:v1:fail:key');
      expect(result).toBeNull();
    });

    it('Redis unavailable on SET does not throw', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      fake.simulateFailure('set');
      const result = await cache.set('pulseops:v1:fail:set', { x: 1 }, 60);
      expect(result).toBe(false);
    });

    it('Redis unavailable on DEL does not throw', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      fake.simulateFailure('del');
      const result = await cache.del('pulseops:v1:fail:del');
      expect(result).toBe(false);
    });

    it('does not cache sensitive fields', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      await cache.set('pulseops:v1:sensitive:key', { id: '1', passwordHash: 'hash', email: 'a@b.com', token: 'secret' }, 60);
      const stored = await cache.get('pulseops:v1:sensitive:key');
      expect(stored.passwordHash).toBeUndefined();
      expect(stored.token).toBeUndefined();
      expect(stored.email).toBe('a@b.com');
    });

    it('delByPattern deletes matching keys', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tenantId = '11111111-1111-4111-8111-111111111111';
      await cache.set(productListKey(tenantId, { page: 1 }), { data: 1 }, 60);
      await cache.set(productListKey(tenantId, { page: 2 }), { data: 2 }, 60);
      expect(fake.store.size).toBe(2);
      await cache.delByPattern(productListPattern(tenantId));
      expect(fake.store.size).toBe(0);
    });
  });

  // ---------- Cache key correctness ----------
  describe('Cache keys', () => {
    it('tenant isolation - different tenants produce different keys', () => {
      const tA = '11111111-1111-4111-8111-111111111111';
      const tB = '22222222-2222-4222-8222-222222222222';
      expect(tenantKey(tA)).not.toBe(tenantKey(tB));
      expect(tenantSettingsKey(tA)).not.toBe(tenantSettingsKey(tB));
      expect(permissionsListKey(tA)).not.toBe(permissionsListKey(tB));
      expect(userPermissionsKey(tA, tA)).not.toBe(userPermissionsKey(tB, tA));
      expect(productListKey(tA, { page: 1 })).not.toBe(productListKey(tB, { page: 1 }));
    });

    it('product list key includes all relevant query params', () => {
      const tid = '11111111-1111-4111-8111-111111111111';
      const k1 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'ACTIVE', sortBy: 'createdAt', sortOrder: 'desc' });
      const k2 = productListKey(tid, { page: 2, limit: 20, search: 'a', status: 'ACTIVE', sortBy: 'createdAt', sortOrder: 'desc' });
      const k3 = productListKey(tid, { page: 1, limit: 20, search: 'b', status: 'ACTIVE', sortBy: 'createdAt', sortOrder: 'desc' });
      const k4 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'DRAFT', sortBy: 'createdAt', sortOrder: 'desc' });
      const k5 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'ACTIVE', sortBy: 'name', sortOrder: 'desc' });
      const k6 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'ACTIVE', sortBy: 'createdAt', sortOrder: 'asc' });
      const k7 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'ACTIVE', sku: 'SKU1', sortBy: 'createdAt', sortOrder: 'desc' });
      const k8 = productListKey(tid, { page: 1, limit: 20, search: 'a', status: 'ACTIVE', sku: 'SKU2', sortBy: 'createdAt', sortOrder: 'desc' });
      expect(new Set([k1, k2, k3, k4, k5, k6, k7, k8]).size).toBe(8);
    });

    it('attribute filters affect key', () => {
      const tid = '11111111-1111-4111-8111-111111111111';
      const k1 = productListKey(tid, { page: 1, attributeFilters: { color: 'red' } });
      const k2 = productListKey(tid, { page: 1, attributeFilters: { color: 'blue' } });
      const k3 = productListKey(tid, { page: 1, attributeFilters: {} });
      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
    });

    it('no secrets in keys', () => {
      const tid = '11111111-1111-4111-8111-111111111111';
      const uid = '22222222-2222-4222-8222-222222222222';
      const keys = [tenantKey(tid), tenantSettingsKey(tid), permissionsListKey(tid), userPermissionsKey(tid, uid), productListKey(tid, { page: 1 })];
      for (const k of keys) {
        expect(k).not.toMatch(/password|token|secret/i);
      }
    });
  });

  // ---------- Service cache-aside with fallback ----------
  describe('TenantService cache-aside', () => {
    it('hit avoids DB call, miss queries DB and caches', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      let dbCalls = 0;
      const tenantData = { id: '11111111-1111-4111-8111-111111111111', name: 'T1', settings: { theme: 'dark' } };
      const repo = { findById: async () => { dbCalls++; return tenantData; }, existsBySlug: async () => false, update: async () => tenantData, delete: async () => tenantData };
      const svc = new TenantService({ repository: repo, cacheService: cache });
      const first = await svc.getById(tenantData.id);
      expect(first).toEqual(tenantData);
      expect(dbCalls).toBe(1);
      dbCalls = 0;
      const second = await svc.getById(tenantData.id);
      expect(second).toEqual(tenantData);
      expect(dbCalls).toBe(0);
    });

    it('Redis failure falls back to DB', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tenantData = { id: '11111111-1111-4111-8111-111111111111', name: 'T1' };
      let dbCalls = 0;
      const repo = { findById: async () => { dbCalls++; return tenantData; } };
      const svc = new TenantService({ repository: repo, cacheService: cache });
      fake.simulateFailure('get');
      const result = await svc.getById(tenantData.id);
      expect(result).toEqual(tenantData);
      expect(dbCalls).toBe(1);
    });

    it('invalidation after update removes cache', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      const tenantData = { id: tid, name: 'T1', settings: { a: 1 } };
      const updatedData = { id: tid, name: 'T1-updated', settings: { a: 2 } };
      const repo = { findById: async () => tenantData, existsBySlug: async () => false, update: async () => updatedData };
      const svc = new TenantService({ repository: repo, cacheService: cache });
      await svc.getById(tid);
      expect(await cache.get(tenantKey(tid))).not.toBeNull();
      await svc.update(tid, { name: 'new' });
      expect(await cache.get(tenantKey(tid))).toBeNull();
      expect(await cache.get(tenantSettingsKey(tid))).toBeNull();
    });

    it('invalidation failure does not roll back DB mutation', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      const tenantData = { id: tid, name: 'T1' };
      const repo = { findById: async () => tenantData, existsBySlug: async () => false, update: async () => ({ id: tid, name: 'updated' }) };
      const svc = new TenantService({ repository: repo, cacheService: cache });
      // prime cache
      await cache.set(tenantKey(tid), tenantData, 60);
      fake.simulateFailure('del');
      const result = await svc.update(tid, { name: 'updated' });
      expect(result.name).toBe('updated');
    });
  });

  describe('PermissionService cache-aside', () => {
    it('hit avoids DB, miss caches', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      let calls = 0;
      const tid = '11111111-1111-4111-8111-111111111111';
      const perms = [{ id: '1', tenantId: tid, name: 'p', resource: 'x', action: 'y' }];
      const repo = { findMany: async () => { calls++; return perms; } };
      const svc = new PermissionService({ repository: repo, cacheService: cache });
      const a = await svc.list(tid);
      expect(calls).toBe(1);
      expect(a.length).toBe(1);
      const b = await svc.list(tid);
      expect(calls).toBe(1);
      expect(b).toEqual(a);
    });

    it('Redis failure falls back to DB', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      let calls = 0;
      const repo = { findMany: async () => { calls++; return []; } };
      const svc = new PermissionService({ repository: repo, cacheService: cache });
      fake.simulateFailure('get');
      const r = await svc.list(tid);
      expect(calls).toBe(1);
      expect(r).toEqual([]);
    });

    it('SET failure does not fail operation', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      const repo = { findMany: async () => [{ id: '1', tenantId: tid, name: 'p', resource: 'x', action: 'y' }] };
      const svc = new PermissionService({ repository: repo, cacheService: cache });
      fake.simulateFailure('set');
      // should still return without throwing
      const r = await svc.list(tid);
      expect(r.length).toBe(1);
    });
  });

  describe('ProductService cache-aside', () => {
    it('hit avoids DB, miss caches', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      let calls = 0;
      const tid = '11111111-1111-4111-8111-111111111111';
      const result = { data: [{ id: 'p1' }], meta: { total: 1 } };
      const repo = { list: async () => { calls++; return result; }, create: async () => ({ id: 'p1' }), findById: async () => ({ id: 'p1' }), prisma: { category: { findFirst: async () => ({ id: 'c' }) } }, setCategories: async () => [] };
      const svc = new ProductService({ repository: repo, cacheService: cache });
      const a = await svc.list(tid, { page: 1, search: 'test' });
      expect(calls).toBe(1);
      const b = await svc.list(tid, { page: 1, search: 'test' });
      expect(calls).toBe(1);
      expect(b).toEqual(a);
      // different query misses
      await svc.list(tid, { page: 2, search: 'test' });
      expect(calls).toBe(2);
    });

    it('mutation invalidates product list cache', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      const repo = { list: async () => ({ data: [], meta: {} }), create: async () => ({ id: 'p1' }), findById: async () => ({ id: 'p1' }), update: async () => ({}), delete: async () => ({}), prisma: { category: { findFirst: async () => ({ id: 'c' }), productVariant: { count: async () => 0 } }, productVariant: { count: async () => 0 } }, setCategories: async () => [] };
      // Need to mock prisma.category and prisma.productVariant correctly
      repo.prisma = { category: { findFirst: async () => ({ id: 'c' }) }, productVariant: { count: async () => 0 } };
      const svc = new ProductService({ repository: repo, cacheService: cache });
      await svc.list(tid, { page: 1 });
      expect(fake.store.size).toBe(1);
      await svc.create(tid, { name: 'n' });
      expect(fake.store.size).toBe(0);
      await svc.list(tid, { page: 1 });
      expect(fake.store.size).toBe(1);
      // update invalidates
      repo.findById = async () => ({ id: 'p1', tenantId: tid });
      await svc.update('p1', tid, { name: 'new' });
      expect(fake.store.size).toBe(0);
    });

    it('Redis GET failure falls back to DB', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      let calls = 0;
      const tid = '11111111-1111-4111-8111-111111111111';
      const repo = { list: async () => { calls++; return { data: [], meta: {} }; } };
      const svc = new ProductService({ repository: repo, cacheService: cache });
      fake.simulateFailure('get');
      const r = await svc.list(tid, { page: 1 });
      expect(calls).toBe(1);
      expect(r).toEqual({ data: [], meta: {} });
    });

    it('Redis SET failure does not fail', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tid = '11111111-1111-4111-8111-111111111111';
      const repo = { list: async () => ({ data: [{ id: '1' }], meta: {} }) };
      const svc = new ProductService({ repository: repo, cacheService: cache });
      fake.simulateFailure('set');
      const r = await svc.list(tid, { page: 1 });
      expect(r.data.length).toBe(1);
    });

    it('tenant isolation in product list cache', async () => {
      const fake = new FakeRedis();
      const cache = new CacheService(fake);
      const tidA = '11111111-1111-4111-8111-111111111111';
      const tidB = '22222222-2222-4222-8222-222222222222';
      const repo = { list: async (tid) => ({ data: [{ tid }], meta: {} }) };
      const svc = new ProductService({ repository: repo, cacheService: cache });
      const resA = await svc.list(tidA, { page: 1 });
      const resB = await svc.list(tidB, { page: 1 });
      expect(resA.data[0].tid).toBe(tidA);
      expect(resB.data[0].tid).toBe(tidB);
      // cross-check cached still isolated
      const cachedA = await svc.list(tidA, { page: 1 });
      expect(cachedA.data[0].tid).toBe(tidA);
    });
  });

  describe('TTL config', () => {
    it('has sensible TTLs and none infinite', () => {
      expect(CACHE_TTL.TENANT).toBeGreaterThan(0);
      expect(CACHE_TTL.TENANT_SETTINGS).toBeGreaterThan(0);
      expect(CACHE_TTL.PERMISSIONS).toBeGreaterThan(0);
      expect(CACHE_TTL.PRODUCT_LIST).toBeGreaterThan(0);
      expect(CACHE_TTL.TENANT).toBeLessThan(3600);
      expect(CACHE_TTL.PRODUCT_LIST).toBeLessThan(600);
    });
  });
});
