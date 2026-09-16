import { getCacheService } from '../../common/cache/cache.service.js';
import { analyticsKey } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';
import { AnalyticsRepository } from './analytics.repository.js';

function cacheKeyFor(tenantId, endpoint, params) {
  const normalized = {
    from: params.from || '',
    to: params.to || '',
    groupBy: params.groupBy || '',
    category: params.category || params.categoryId || '',
    product: params.product || params.productId || '',
    status: params.status || '',
    warehouseId: params.warehouseId || params.warehouse || '',
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 20),
  };
  return analyticsKey(tenantId, endpoint, normalized);
}

const TTL_MAP = {
  overview: CACHE_TTL.ANALYTICS_OVERVIEW,
  sales: CACHE_TTL.ANALYTICS_SALES,
  orders: CACHE_TTL.ANALYTICS_ORDERS,
  inventory: CACHE_TTL.ANALYTICS_INVENTORY,
  customers: CACHE_TTL.ANALYTICS_CUSTOMERS,
  revenue: CACHE_TTL.ANALYTICS_REVENUE,
};

export class AnalyticsService {
  constructor({ cacheService, repository } = {}) {
    this.cache = cacheService || getCacheService();
    this.repository = repository || new AnalyticsRepository();
  }

  async _cachedFetch(tenantId, endpoint, params, loader) {
    if (!tenantId) {
      const err = new Error('tenantId is required');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    const key = cacheKeyFor(tenantId, endpoint, params);
    const ttl = TTL_MAP[endpoint] || 60;
    try {
      const cached = await this.cache.get(key);
      if (cached !== null && cached !== undefined) {
        return { data: cached, cacheHit: true, cacheKey: key };
      }
    } catch (error) {
      logger.warn({ err: error, tenantId, cacheKey: key }, 'Analytics cache GET failed; falling back to DB');
    }

    let result;
    try {
      result = await loader();
    } catch (error) {
      logger.warn({ err: error, tenantId, endpoint }, 'Analytics repository failed');
      throw error;
    }

    try {
      await this.cache.set(key, result, ttl);
    } catch (error) {
      logger.warn({ err: error, tenantId, cacheKey: key }, 'Analytics cache SET failed');
    }
    return { data: result, cacheHit: false, cacheKey: key };
  }

  async getOverview(tenantId, params = {}) {
    const loader = () => this.repository.getOverview(tenantId, params);
    return this._cachedFetch(tenantId, 'overview', params, loader);
  }

  async getSales(tenantId, params = {}) {
    const loader = () => this.repository.getSales(tenantId, params);
    return this._cachedFetch(tenantId, 'sales', params, loader);
  }

  async getOrders(tenantId, params = {}) {
    const loader = () => this.repository.getOrders(tenantId, params);
    return this._cachedFetch(tenantId, 'orders', params, loader);
  }

  async getInventory(tenantId, params = {}) {
    const loader = () => this.repository.getInventory(tenantId, params);
    return this._cachedFetch(tenantId, 'inventory', params, loader);
  }

  async getCustomers(tenantId, params = {}) {
    const loader = () => this.repository.getCustomers(tenantId, params);
    return this._cachedFetch(tenantId, 'customers', params, loader);
  }

  async getRevenue(tenantId, params = {}) {
    const loader = () => this.repository.getRevenue(tenantId, params);
    return this._cachedFetch(tenantId, 'revenue', params, loader);
  }

  async invalidateCache(tenantId) {
    const patterns = [
      cacheKeyFor(tenantId, 'overview', {}),
      cacheKeyFor(tenantId, 'sales', {}),
    ];
    for (const key of patterns) {
      try { await this.cache.del(key); } catch (_) { void _; }
    }
    try {
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'overview', { page: '', limit: '' }).split(':overview:')[0]}:overview:*`);
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'sales', { page: '', limit: '' }).split(':sales:')[0]}:sales:*`);
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'orders', { page: '', limit: '' }).split(':orders:')[0]}:orders:*`);
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'inventory', { page: '', limit: '' }).split(':inventory:')[0]}:inventory:*`);
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'customers', { page: '', limit: '' }).split(':customers:')[0]}:customers:*`);
      await this.cache.delByPattern(`${analyticsKey(tenantId, 'revenue', { page: '', limit: '' }).split(':revenue:')[0]}:revenue:*`);
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Analytics cache invalidation pattern failed');
    }
  }
}

export const analyticsService = new AnalyticsService();
