import { StorageService } from '../../common/storage/storage.service.js';
import { LocalStorageProvider } from '../../common/storage/local-storage.provider.js';
import { AppError } from '../../common/errors/app-error.js';

const storageService = new StorageService();

const CONTENT_TYPES = { '.csv': 'text/csv; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

function setFileHeaders(res, storageKey) {
  const ext = storageKey.slice(storageKey.lastIndexOf('.')).toLowerCase();
  res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (ext === '.csv') res.setHeader('Content-Disposition', `attachment; filename="${storageKey.split('/').pop()}"`);
}

export async function getSignedFile(req, res, next) {
  try {
    const storageKey = req.query.key;
    const expires = req.query.expires;
    const signature = req.query.signature;
    if (!storageKey || !expires || !signature) {
      throw new AppError('Missing signed URL parameters', { statusCode: 400, code: 'INVALID_SIGNED_URL' });
    }
    // Verify HMAC and expiry
    const ok = LocalStorageProvider.verifySignedUrl(storageKey, expires, signature);
    if (!ok) {
      throw new AppError('Invalid or expired signed URL', { statusCode: 403, code: 'INVALID_SIGNED_URL' });
    }
    // Tenant isolation: signed URL itself is tenant-scoped via key, but also verify key format
    storageService.assertTenantScopedKey(storageKey);
    const stream = await storageService.getFileStream(storageKey);
    if (!stream) {
      throw new AppError('File not found', { statusCode: 404, code: 'FILE_NOT_FOUND' });
    }
    setFileHeaders(res, storageKey);
    res.setHeader('Cache-Control', 'private, max-age=60');
    stream.pipe(res);
  } catch (error) { next(error); }
}

export async function getAuthenticatedFile(req, res, next) {
  try {
    const tenantId = req.context?.tenantId;
    const storageKey = req.query.key || req.params.storageKey;
    if (!storageKey) throw new AppError('Storage key required', { statusCode: 400, code: 'INVALID_STORAGE_KEY' });
    // Tenant isolation: key must belong to caller's tenant
    storageService.assertTenantScopedKey(storageKey);
    const keyTenant = storageKey.split('/')[1];
    if (keyTenant !== tenantId) {
      throw new AppError('Access denied to storage object', { statusCode: 403, code: 'FORBIDDEN' });
    }
    const stream = await storageService.getFileStream(storageKey);
    if (!stream) throw new AppError('File not found', { statusCode: 404, code: 'FILE_NOT_FOUND' });
    setFileHeaders(res, storageKey);
    stream.pipe(res);
  } catch (error) { next(error); }
}
