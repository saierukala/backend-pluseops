import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { verifyAccessToken } from '../auth/jwt.util.js';
import { toSettings } from '../workspace/workspace.service.js';
import { DEFAULT_CURRENCY } from '../orders/gst.js';
import { env } from '../../config/env.js';

const PLATFORM_TENANT_SLUG = '__platform';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storeNotFound = () => new AppError('Store not found', { statusCode: 404, code: 'STORE_NOT_FOUND' });

export async function findOpenStore(where) {
  const tenant = await getPrismaClient().tenant.findUnique({ where, include: { settings: { select: { metadata: true } } } });
  if (!tenant || tenant.slug === PLATFORM_TENANT_SLUG || !['ACTIVE', 'TRIAL'].includes(tenant.status)) return null;
  const settings = toSettings(tenant.settings?.metadata);
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    settings,
    currency: settings.currency ?? DEFAULT_CURRENCY,
    gstRatePercent: settings.gstRatePercent ?? env.DEFAULT_GST_RATE_PERCENT,
  };
}

/** `/storefront/:store` — the public store is addressed by tenant slug; suspended tenants have no store. */
export function resolveStore() {
  return async (req, res, next) => {
    try {
      const slug = String(req.params.store ?? '').toLowerCase();
      const store = SLUG_RE.test(slug) ? await findOpenStore({ slug }) : null;
      if (!store) throw storeNotFound();
      req.store = store;
      next();
    } catch (error) { next(error); }
  };
}

/** Shopper token (`scope: "customer"`) for this store, with a live session and a non-deleted customer. */
export function authenticateCustomer() {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ')) throw new AppError('Sign in required', { statusCode: 401, code: 'UNAUTHORIZED' });
      let decoded;
      try {
        decoded = verifyAccessToken(header.substring(7));
      } catch (err) {
        if (err.name === 'TokenExpiredError') throw new AppError('Access token has expired', { statusCode: 401, code: 'TOKEN_EXPIRED' });
        throw new AppError('Invalid access token', { statusCode: 401, code: 'INVALID_TOKEN' });
      }
      if (decoded.scope !== 'customer') throw new AppError('Customer sign-in required', { statusCode: 403, code: 'CUSTOMER_AUTH_REQUIRED' });
      if (decoded.tenantId !== req.store.id) throw new AppError('This sign-in belongs to another store', { statusCode: 401, code: 'WRONG_STORE' });
      if (!UUID_RE.test(decoded.sessionId ?? '')) throw new AppError('Invalid token claims', { statusCode: 401, code: 'INVALID_TOKEN_CLAIMS' });
      const session = await getPrismaClient().customerSession.findFirst({
        where: { id: decoded.sessionId, customerId: decoded.sub, tenantId: req.store.id, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { customer: { select: { id: true, deletedAt: true } } },
      });
      if (!session || session.customer.deletedAt) throw new AppError('Session has ended. Please sign in again.', { statusCode: 401, code: 'SESSION_REVOKED' });
      req.customer = { id: decoded.sub, sessionId: decoded.sessionId };
      next();
    } catch (error) { next(error); }
  };
}
