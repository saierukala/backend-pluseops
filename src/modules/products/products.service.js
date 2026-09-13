import { ProductRepository } from './products.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class ProductService {
  constructor() {
    this.repository = new ProductRepository();
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

    return this.repository.findById(product.id, tenantId);
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
    return this.repository.list(tenantId, options);
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

    return this.repository.findById(id, tenantId);
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

    return this.repository.delete(id, tenantId);
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

    return this.repository.setCategories(productId, tenantId, categoryIds, primaryCategoryId);
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