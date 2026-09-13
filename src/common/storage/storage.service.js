import { LocalStorageProvider } from './local-storage.provider.js';
import { AppError } from '../errors/app-error.js';

export class StorageService {
  constructor() {
    this.provider = new LocalStorageProvider();
  }

  generateProductImageKey(tenantId, productId, filename) {
    const sanitizedFilename = this.sanitizeFilename(filename);
    return `tenants/${tenantId}/products/${productId}/${sanitizedFilename}`;
  }

  generateVariantImageKey(tenantId, productId, variantId, filename) {
    const sanitizedFilename = this.sanitizeFilename(filename);
    return `tenants/${tenantId}/products/${productId}/variants/${variantId}/${sanitizedFilename}`;
  }

  sanitizeFilename(filename) {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/^\.+/, '')
      .substring(0, 255);
  }

  async uploadProductImage(tenantId, productId, file) {
    const storageKey = this.generateProductImageKey(tenantId, productId, file.originalname);
    const result = await this.provider.upload(storageKey, file.buffer, file.mimetype);
    return { storageKey, ...result };
  }

  async uploadVariantImage(tenantId, productId, variantId, file) {
    const storageKey = this.generateVariantImageKey(tenantId, productId, variantId, file.originalname);
    const result = await this.provider.upload(storageKey, file.buffer, file.mimetype);
    return { storageKey, ...result };
  }

  async deleteFile(storageKey) {
    return this.provider.delete(storageKey);
  }

  async getFileUrl(storageKey) {
    return this.provider.getUrl(storageKey);
  }

  async getFileStream(storageKey) {
    return this.provider.getStream(storageKey);
  }

  async fileExists(storageKey) {
    return this.provider.exists(storageKey);
  }

  validateImageFile(file) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new AppError('Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.', {
        statusCode: 400,
        code: 'INVALID_FILE_TYPE',
      });
    }

    if (file.size > maxSize) {
      throw new AppError('File size exceeds 10MB limit', {
        statusCode: 400,
        code: 'FILE_TOO_LARGE',
      });
    }

    return true;
  }
}