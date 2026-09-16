import { ProductRepository } from './products.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { getCacheService } from '../../common/cache/cache.service.js';
import { productListKey, productListPattern } from '../../common/cache/cache.keys.js';
import { CACHE_TTL } from '../../common/cache/cache.config.js';
import { logger } from '../../config/logger.js';

export class ProductService {
  constructor({ repository, cacheService } = {}) {
    this.repository = repository ?? new ProductRepository();
    this.cache = cacheService ?? getCacheService();
  }

  async invalidateProductListCache(tenantId) {
    try {
      await this.cache.delByPattern(productListPattern(tenantId));
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Product list cache invalidation failed');
    }
  }

  async create(tenantId, data) {
    if (data.categories && data.categories.length > 0) {
      for (const catId of data.categories) {
        const category = await this.repository.prisma.category.findFirst({
          where: { id: catId, tenantId },
        });
        if (!category) {
          throw new AppError(`Category ${catId} not found`, {
            statusCode: 404,
            code: 'CATEGORY_NOT_FOUND',
          });
        }
      }
    }

    const product = await this.repository.create(data, tenantId);

    if (data.categories && data.categories.length > 0) {
      await this.repository.setCategories(product.id, tenantId, data.categories, data.primaryCategoryId);
    }

    const result = await this.repository.findById(product.id, tenantId);
    try {
      await this.invalidateProductListCache(tenantId);
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Product list cache invalidation failed after create');
    }
    return result;
  }

  async getById(id, tenantId) {
    const product = await this.repository.findById(id, tenantId);
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }
    return product;
  }

  async list(tenantId, options = {}) {
    const cacheKey = productListKey(tenantId, options);
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Product list cache GET failed');
    }

    const result = await this.repository.list(tenantId, options);

    try {
      await this.cache.set(cacheKey, result, CACHE_TTL.PRODUCT_LIST);
    } catch (error) {
      logger.warn({ err: error, key: cacheKey }, 'Product list cache SET failed');
    }

    return result;
  }

  async update(id, tenantId, data) {
    await this.getById(id, tenantId);

    if (data.categories && data.categories.length > 0) {
      for (const catId of data.categories) {
        const category = await this.repository.prisma.category.findFirst({
          where: { id: catId, tenantId },
        });
        if (!category) {
          throw new AppError(`Category ${catId} not found`, {
            statusCode: 404,
            code: 'CATEGORY_NOT_FOUND',
          });
        }
      }
      await this.repository.setCategories(id, tenantId, data.categories, data.primaryCategoryId);
    }

    const updateData = {};
    const allowedFields = ['name', 'description', 'brand', 'status', 'basePrice'];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    if (Object.keys(updateData).length > 0) {
      await this.repository.update(id, tenantId, updateData);
    }

    const result = await this.repository.findById(id, tenantId);
    try {
      await this.invalidateProductListCache(tenantId);
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Product list cache invalidation failed after update');
    }
    return result;
  }

  async delete(id, tenantId) {
    await this.getById(id, tenantId);

    const variantCount = await this.repository.prisma.productVariant.count({
      where: { productId: id, tenantId },
    });
    if (variantCount > 0) {
      throw new AppError('Cannot delete product with existing variants. Delete variants first.', {
        statusCode: 400,
        code: 'PRODUCT_HAS_VARIANTS',
      });
    }

    const deleted = await this.repository.delete(id, tenantId);
    try {
      await this.invalidateProductListCache(tenantId);
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Product list cache invalidation failed after delete');
    }
    return deleted;
  }

  async setCategories(productId, tenantId, categoryIds, primaryCategoryId = null) {
    const product = await this.getById(productId, tenantId);
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    for (const catId of categoryIds) {
      const category = await this.repository.prisma.category.findFirst({
        where: { id: catId, tenantId },
      });
      if (!category) {
        throw new AppError(`Category ${catId} not found`, {
          statusCode: 404,
          code: 'CATEGORY_NOT_FOUND',
        });
      }
    }

    const result = await this.repository.setCategories(productId, tenantId, categoryIds, primaryCategoryId);
    try {
      await this.invalidateProductListCache(tenantId);
    } catch (error) {
      logger.warn({ err: error, tenantId }, 'Product list cache invalidation failed after setCategories');
    }
    return result;
  }

  async getCategories(productId, tenantId) {
    const product = await this.getById(productId, tenantId);
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    return this.repository.getCategories(productId, tenantId);
  }
}