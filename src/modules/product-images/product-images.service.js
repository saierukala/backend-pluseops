import { ProductImageRepository } from './product-images.repository.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { AppError } from '../../common/errors/app-error.js';

export class ProductImageService {
  constructor() {
    this.repository = new ProductImageRepository();
    this.storageService = new StorageService();
  }

  async createProductImage(productId, tenantId, file, data = {}) {
    const product = await this.repository.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    this.storageService.validateImageFile(file);

    const uploadResult = await this.storageService.uploadProductImage(tenantId, productId, file);

    const isPrimary = data.isPrimary ?? false;
    if (isPrimary) {
      await this.repository.prisma.productImage.updateMany({
        where: { productId, tenantId, variantId: null, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const image = await this.repository.create({
      productId,
      storageKey: uploadResult.storageKey,
      url: uploadResult.url,
      altText: data.altText,
      sortOrder: data.sortOrder ?? 0,
      isPrimary,
    }, tenantId);

    return image;
  }

  async createVariantImage(productId, variantId, tenantId, file, data = {}) {
    const product = await this.repository.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    const variant = await this.repository.prisma.productVariant.findFirst({
      where: { id: variantId, productId, tenantId },
    });
    if (!variant) {
      throw new AppError('Variant not found or does not belong to product', {
        statusCode: 404,
        code: 'VARIANT_NOT_FOUND',
      });
    }

    this.storageService.validateImageFile(file);

    const uploadResult = await this.storageService.uploadVariantImage(tenantId, productId, variantId, file);

    const isPrimary = data.isPrimary ?? false;
    if (isPrimary) {
      await this.repository.prisma.productImage.updateMany({
        where: { productId, tenantId, variantId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    const image = await this.repository.create({
      productId,
      variantId,
      storageKey: uploadResult.storageKey,
      url: uploadResult.url,
      altText: data.altText,
      sortOrder: data.sortOrder ?? 0,
      isPrimary,
    }, tenantId);

    return image;
  }

  async getImage(id, tenantId, productId = null) {
    const image = await this.repository.findById(id, tenantId);
    if (!image) {
      throw new AppError('Image not found', {
        statusCode: 404,
        code: 'IMAGE_NOT_FOUND',
      });
    }
    if (productId && image.productId !== productId) {
      throw new AppError('Image not found', {
        statusCode: 404,
        code: 'IMAGE_NOT_FOUND',
      });
    }
    return image;
  }

  async listProductImages(productId, tenantId, options = {}) {
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

  async listVariantImages(productId, variantId, tenantId, options = {}) {
    const product = await this.repository.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) {
      throw new AppError('Product not found', {
        statusCode: 404,
        code: 'PRODUCT_NOT_FOUND',
      });
    }

    const variant = await this.repository.prisma.productVariant.findFirst({
      where: { id: variantId, productId, tenantId },
    });
    if (!variant) {
      throw new AppError('Variant not found or does not belong to product', {
        statusCode: 404,
        code: 'VARIANT_NOT_FOUND',
      });
    }

    return this.repository.listByProduct(productId, tenantId, { ...options, variantId });
  }

  async updateImage(id, tenantId, data, productId = null) {
    const image = await this.getImage(id, tenantId, productId);

    if (data.isPrimary) {
      await this.repository.setPrimary(id, tenantId, image.productId, image.variantId);
    }

    return this.repository.update(id, tenantId, data);
  }

  async deleteImage(id, tenantId, productId = null) {
    const image = await this.getImage(id, tenantId, productId);

    await this.storageService.deleteFile(image.storageKey);

    return this.repository.delete(id, tenantId);
  }
}