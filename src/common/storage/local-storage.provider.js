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
}