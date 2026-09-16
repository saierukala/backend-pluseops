import { getCacheService } from '../../common/cache/cache.service.js';
import { dashboardOverviewKey } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';
import { OrderService } from '../orders/orders.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PaymentService } from '../payments/payments.service.js';
import { UserService } from '../users/users.service.js';
import { NotificationService } from '../notifications/notifications.service.js';
import { ProductService } from '../products/products.service.js';

// Dashboard Service is the orchestration layer.
// Architecture: Dashboard Controller → Dashboard Service → existing domain services → repositories → PostgreSQL
// No direct Prisma queries, no duplicated domain logic, no HTTP calls.
// Aggregates results from OrderService, InventoryService, PaymentService, UserService, NotificationService, ProductService.

export class DashboardService {
  constructor({ cacheService, orderService, inventoryService, paymentService, userService, notificationService, productService } = {}) {
    this.cache = cacheService || getCacheService();
    this.orderService = orderService || new OrderService();
    this.inventoryService = inventoryService || new InventoryService();
    this.paymentService = paymentService || new PaymentService();
    this.userService = userService || new UserService();
    this.notificationService = notificationService || new NotificationService();
    this.productService = productService || new ProductService();
  }

  getCacheKey(tenantId) {
    return dashboardOverviewKey(tenantId);
  }

  async getOverview(tenantId) {
    if (!tenantId) {
      const err = new Error('tenantId is required');
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const cacheKey = this.getCacheKey(tenantId);

    try {
      const cached = await this.cache.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        return { data: cached, cached: true, cacheHit: true };
      }
    } catch (error) {
      logger.warn({ err: error, tenantId, cacheKey }, 'Dashboard cache GET failed; falling back to domain services');
    }

    const data = await this.buildOverview(tenantId);

    try {
      await this.cache.set(cacheKey, data, CACHE_TTL.DASHBOARD_OVERVIEW);
    } catch (error) {
      logger.warn({ err: error, tenantId, cacheKey }, 'Dashboard cache SET failed; continuing without cache');
    }

    return { data, cached: false, cacheHit: false };
  }

  async buildOverview(tenantId) {
    const results = await Promise.allSettled([
      this.getOrdersOverview(tenantId),
      this.getInventoryOverview(tenantId),
      this.getPaymentsOverview(tenantId),
      this.getUsersOverview(tenantId),
      this.getNotificationsOverview(tenantId),
      this.getProductsOverview(tenantId),
    ]);

    const [ordersRes, inventoryRes, paymentsRes, usersRes, notificationsRes, productsRes] = results;

    const toSection = (settled, label) => {
      if (settled.status === 'fulfilled') {
        return settled.value;
      }
      logger.warn({ err: settled.reason, tenantId, section: label }, `Dashboard section ${label} failed`);
      return { error: true, message: settled.reason?.message || 'Failed to load', code: settled.reason?.code || 'INTERNAL_ERROR' };
    };

    const hasAtLeastOneSuccess = results.some((r) => r.status === 'fulfilled');
    if (!hasAtLeastOneSuccess) {
      const firstError = results.find((r) => r.status === 'rejected')?.reason;
      throw firstError || new Error('Failed to build dashboard overview');
    }

    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      orders: toSection(ordersRes, 'orders'),
      inventory: toSection(inventoryRes, 'inventory'),
      payments: toSection(paymentsRes, 'payments'),
      users: toSection(usersRes, 'users'),
      notifications: toSection(notificationsRes, 'notifications'),
      products: toSection(productsRes, 'products'),
    };
  }

  // Delegation wrappers — preserve orchestration boundary and allow parallelization/testing hooks

  async getOrdersOverview(tenantId) {
    return this.orderService.getOverview(tenantId);
  }

  async getInventoryOverview(tenantId) {
    return this.inventoryService.getOverview(tenantId);
  }

  async getPaymentsOverview(tenantId) {
    return this.paymentService.getOverview(tenantId);
  }

  async getUsersOverview(tenantId) {
    return this.userService.getOverview(tenantId);
  }

  async getNotificationsOverview(tenantId) {
    return this.notificationService.getOverview(tenantId);
  }

  async getProductsOverview(tenantId) {
    return this.productService.getOverview(tenantId);
  }

  async invalidateCache(tenantId) {
    const key = this.getCacheKey(tenantId);
    try {
      await this.cache.del(key);
    } catch (error) {
      logger.warn({ err: error, tenantId, key }, 'Dashboard cache invalidation failed');
    }
  }
}

export const dashboardService = new DashboardService();
