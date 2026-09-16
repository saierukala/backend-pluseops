import { createHash } from 'node:crypto';
import { CACHE_PREFIX } from './cache.config.js';

function sanitizeId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) && !/^[a-z0-9_-]{1,64}$/i.test(id)) {
    throw new Error('Invalid cache id');
  }
  return id;
}

export function tenantKey(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}`;
}

export function tenantSettingsKey(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:settings`;
}

export function permissionsListKey(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:permissions:list`;
}

export function userPermissionsKey(tenantId, userId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:permissions:user:${sanitizeId(userId)}`;
}

export function productListKey(tenantId, options) {
  const normalized = {
    page: options.page ?? 1,
    limit: options.limit ?? 20,
    search: options.search ?? '',
    status: options.status ?? '',
    categoryId: options.categoryId ?? '',
    minPrice: options.minPrice ?? '',
    maxPrice: options.maxPrice ?? '',
    sku: options.sku ?? '',
    barcode: options.barcode ?? '',
    sortBy: options.sortBy ?? 'createdAt',
    sortOrder: options.sortOrder ?? 'desc',
    attributeFilters: options.attributeFilters ?? {},
  };
  const sortedAttrKeys = Object.keys(normalized.attributeFilters).sort();
  const sortedAttr = {};
  for (const k of sortedAttrKeys) sortedAttr[k] = normalized.attributeFilters[k];

  const payload = JSON.stringify({ ...normalized, attributeFilters: sortedAttr });
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:products:list:${hash}`;
}

export function productListPattern(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:products:list:*`;
}

export function dashboardOverviewKey(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:dashboard:overview`;
}

export function dashboardOverviewPattern(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:dashboard:*`;
}

export function analyticsKey(tenantId, endpoint, params) {
  const normalized = { ...params };
  // Ensure deterministic ordering for hash
  const sortedKeys = Object.keys(normalized).sort();
  const ordered = {};
  for (const k of sortedKeys) ordered[k] = normalized[k] ?? '';
  const payload = JSON.stringify(ordered);
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:analytics:${endpoint}:${hash}`;
}

export function analyticsPattern(tenantId) {
  return `${CACHE_PREFIX}:tenant:${sanitizeId(tenantId)}:analytics:*`;
}
