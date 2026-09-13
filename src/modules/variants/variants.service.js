import { VariantRepository } from './variants.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class VariantService {
  constructor() {
    this.repository = new VariantRepository();
  }

  async create(productId, tenantId, data) {
    const product = await this.repository.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    const existingSku = await this.repository.findBySku(data.sku, tenantId);
    if (existingSku) {
      throw new AppError('SKU already exists', {
        statusCode: 409,
        code: 'SKU_EXISTS',
      });
    }

    if (data.barcode) {
      const existingBarcode = await this.repository.prisma.productVariant.findFirst({
        where: { barcode: data.barcode, tenantId },
      });
      if (existingBarcode) {
        throw new AppError('Barcode already exists', {
          statusCode: 409,
          code: 'BARCODE_EXISTS',
        });
      }
    }

    const variant = await this.repository.create(data, tenantId, productId);

    if (data.attributes && data.attributes.length > 0) {
      await this.repository.setAttributes(variant.id, tenantId, data.attributes);
    }

    return this.repository.findById(variant.id, tenantId);
  }

  async getById(variantId, tenantId, productId = null) {
    const variant = await this.repository.findById(variantId, tenantId);
    if (!variant) {
      throw new AppError('Variant not found', {
        statusCode: 404,
        code: 'VARIANT_NOT_FOUND',
      });
    }
    if (productId && variant.productId !== productId) {
      throw new AppError('Variant not found or does not belong to product', {
        statusCode: 404,
        code: 'VARIANT_NOT_FOUND',
      });
    }
    return variant;
  }

  async listByProduct(productId, tenantId, options = {}) {
    const product = await this.repository.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    return this.repository.listByProduct(productId, tenantId, options);
  }

  async update(variantId, tenantId, data, productId = null) {
    const variant = await this.getById(variantId, tenantId, productId);

    if (data.sku && data.sku !== variant.sku) {
      const existingSku = await this.repository.findBySku(data.sku, tenantId);
      if (existingSku) {
        throw new AppError('SKU already exists', {
          statusCode: 409,
          code: 'SKU_EXISTS',
        });
      }
    }

    if (data.barcode && data.barcode !== variant.barcode) {
      const existingBarcode = await this.repository.prisma.productVariant.findFirst({
        where: { barcode: data.barcode, tenantId },
      });
      if (existingBarcode) {
        throw new AppError('Barcode already exists', {
          statusCode: 409,
          code: 'BARCODE_EXISTS',
        });
      }
    }

    if (data.attributes) {
      await this.repository.setAttributes(variantId, tenantId, data.attributes);
    }

    const updateData = {};
    const allowedFields = ['sku', 'barcode', 'price', 'costPrice', 'status'];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    if (Object.keys(updateData).length > 0) {
      await this.repository.update(variantId, tenantId, updateData);
    }

    return this.repository.findById(variantId, tenantId);
  }

  async delete(variantId, tenantId, productId = null) {
    await this.getById(variantId, tenantId, productId);
    return this.repository.delete(variantId, tenantId);
  }

  async setAttributes(variantId, tenantId, attributes, productId = null) {
    await this.getById(variantId, tenantId, productId);
    return this.repository.setAttributes(variantId, tenantId, attributes);
  }

  async getAttributes(variantId, tenantId, productId = null) {
    await this.getById(variantId, tenantId, productId);
    return this.repository.getAttributes(variantId, tenantId);
  }
}