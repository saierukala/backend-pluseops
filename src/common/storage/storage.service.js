import { LocalStorageProvider } from './local-storage.provider.js';
import { S3StorageProvider, MockS3StorageProvider } from '../../integrations/storage/s3-storage.provider.js';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

export function createStorageProvider(providerName = env.STORAGE_PROVIDER || 'local') {
  if (providerName === 's3') {
    return new S3StorageProvider();
  }
  return new LocalStorageProvider();
}

export function createMockS3Provider(options = {}) {
  return new MockS3StorageProvider(options);
}

export class StorageService {
  constructor(providerName) {
    const resolved = providerName || env.STORAGE_PROVIDER || 'local';
    this.providerName = resolved;
    this.provider = createStorageProvider(resolved);
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
    this.assertTenantScopedKey(storageKey);
    return this.provider.delete(storageKey);
  }

  async getFileUrl(storageKey) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.getUrl(storageKey);
  }

  async getFileStream(storageKey) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.getStream(storageKey);
  }

  async fileExists(storageKey) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.exists(storageKey);
  }

  assertTenantScopedKey(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new AppError('Invalid storage key', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    }
    if (storageKey.includes('..') || storageKey.startsWith('/') || storageKey.includes('\\') || storageKey.includes('\0')) {
      throw new AppError('Invalid storage path: path traversal detected', { statusCode: 400, code: 'INVALID_STORAGE_PATH' });
    }
    if (!storageKey.startsWith('tenants/')) {
      throw new AppError('Storage key must be tenant-scoped', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    }
    // No arbitrary client-controlled paths outside tenancy: caller must use generate* helpers
  }

  // Provider-independent operations for Phase 16 contract
  async upload(storageKey, buffer, mimeType) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.upload(storageKey, buffer, mimeType);
  }

  async delete(storageKey) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.delete(storageKey);
  }

  async getUrl(storageKey) {
    this.assertTenantScopedKey(storageKey);
    return this.provider.getUrl(storageKey);
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