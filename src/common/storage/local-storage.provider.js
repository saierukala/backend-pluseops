import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

export class LocalStorageProvider {
  constructor() {
    this.basePath = env.LOCAL_STORAGE_PATH || './storage';
    this.baseUrl = env.LOCAL_STORAGE_URL || '/storage';
  }

  async ensureDirectory(dirPath) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  getFullPath(storageKey) {
    const normalizedKey = storageKey.replace(/^\/+/, '');
    const fullPath = path.resolve(this.basePath, normalizedKey);

    const resolvedBase = path.resolve(this.basePath);
    if (!fullPath.startsWith(resolvedBase)) {
      throw new AppError('Invalid storage path: path traversal detected', {
        statusCode: 400,
        code: 'INVALID_STORAGE_PATH',
      });
    }

    return fullPath;
  }

  async upload(storageKey, buffer, mimeType) {
    const fullPath = this.getFullPath(storageKey);
    await this.ensureDirectory(path.dirname(fullPath));

    await fs.writeFile(fullPath, buffer);

    const stats = await fs.stat(fullPath);
    const url = `${this.baseUrl}/${storageKey}`;

    return {
      url,
      size: stats.size,
      mimeType,
    };
  }

  async delete(storageKey) {
    const fullPath = this.getFullPath(storageKey);

    try {
      await fs.unlink(fullPath);
      await this.cleanupEmptyDirectories(path.dirname(fullPath));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async cleanupEmptyDirectories(dirPath) {
    const resolvedBase = path.resolve(this.basePath);
    const resolvedDir = path.resolve(dirPath);

    if (!resolvedDir.startsWith(resolvedBase) || resolvedDir === resolvedBase) {
      return;
    }

    try {
      const entries = await fs.readdir(resolvedDir);
      if (entries.length === 0) {
        await fs.rmdir(resolvedDir);
        await this.cleanupEmptyDirectories(path.dirname(resolvedDir));
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  async getUrl(storageKey) {
    const fullPath = this.getFullPath(storageKey);
    try {
      await fs.access(fullPath);
      return `${this.baseUrl}/${storageKey}`;
    } catch {
      return null;
    }
  }

  async getStream(storageKey) {
    const fullPath = this.getFullPath(storageKey);
    try {
      await fs.access(fullPath);
      return fs.createReadStream(fullPath);
    } catch {
      return null;
    }
  }

  async exists(storageKey) {
    const fullPath = this.getFullPath(storageKey);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  // Private objects: signed URL via HMAC (15min expiry), verified by storage signed-url endpoint
  // Credentials (secret) never reach client; URL contains only storageKey, expires, signature
  async getSignedUrl(storageKey, expiresInSec = 900) {
    // Validate key before signing
    this.getFullPath(storageKey); // also checks traversal via getFullPath
    const secret = env.JWT_ACCESS_SECRET || env.PAYMENT_WEBHOOK_SECRET || 'test-storage-secret-min-32-chars-long-for-testing';
    const expires = Math.floor(Date.now() / 1000) + expiresInSec;
    const data = `${storageKey}:${expires}`;
    const signature = crypto.createHmac('sha256', secret).update(data).digest('hex');
    // Signed URL is served via /api/v1/storage/signed?key=... (query param to avoid path slash issues)
    // Client must use this URL within expiry; server verifies HMAC and tenant isolation via key prefix
    return `/api/v1/storage/signed?key=${encodeURIComponent(storageKey)}&expires=${expires}&signature=${signature}`;
  }

  static verifySignedUrl(storageKey, expires, signature) {
    const secret = env.JWT_ACCESS_SECRET || env.PAYMENT_WEBHOOK_SECRET || 'test-storage-secret-min-32-chars-long-for-testing';
    if (!expires || !signature) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Number(expires) < now) return false;
    const data = `${storageKey}:${expires}`;
    const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}