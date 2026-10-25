import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../errors/app-error.js';
import { logger } from '../../config/logger.js';

/**
 * Phase 39: `Idempotency-Key` for requests that must never run twice (checkout, counter sale, new order).
 *
 * The first request with a key runs and its 2xx response is stored. Repeating it (double click, retry after a
 * timeout) returns the stored response instead of running again. The same key with a different body is refused;
 * a repeat that arrives while the first is still running gets 409. Failed requests (4xx/5xx) free the key so
 * the client can fix the request and try again. Keys are scoped per business (or per shop for the storefront).
 * Without the header the request runs normally.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

const hashOf = (req) => crypto.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

export function idempotent(scopeOf = (req) => req.context?.tenantId) {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (!KEY_PATTERN.test(key)) {
      return next(new AppError('Idempotency-Key must be 8–255 letters, digits or ._:-', { statusCode: 400, code: 'INVALID_IDEMPOTENCY_KEY' }));
    }
    const scopeId = scopeOf(req);
    if (!scopeId) return next();

    const prisma = getPrismaClient();
    const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const requestHash = hashOf(req);

    try {
      // Claim the key; only one request can insert it
      const claimed = await prisma.$executeRaw`INSERT INTO "idempotency_keys" ("scope_id", "key", "route", "request_hash") VALUES (${scopeId}, ${key}, ${route}, ${requestHash}) ON CONFLICT DO NOTHING`;
      if (claimed === 0) {
        const existing = await prisma.idempotencyKey.findUnique({ where: { scopeId_key: { scopeId, key } } });
        if (!existing) return next(new AppError('Please retry the request', { statusCode: 409, code: 'IDEMPOTENCY_RETRY' }));
        if (existing.route !== route || existing.requestHash !== requestHash) {
          return next(new AppError('This Idempotency-Key was already used for a different request', { statusCode: 422, code: 'IDEMPOTENCY_KEY_REUSED' }));
        }
        if (existing.statusCode === null) {
          return next(new AppError('The same request is still being processed', { statusCode: 409, code: 'IDEMPOTENCY_IN_PROGRESS' }));
        }
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.statusCode).json(existing.response);
      }
    } catch (err) {
      return next(err);
    }

    // Remember the response once it's known: 2xx is kept for replay, anything else frees the key
    const json = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode;
      const save = statusCode >= 200 && statusCode < 300
        ? prisma.idempotencyKey.update({ where: { scopeId_key: { scopeId, key } }, data: { statusCode, response: body } })
        : prisma.idempotencyKey.delete({ where: { scopeId_key: { scopeId, key } } });
      // Send only after the result is recorded, so an immediate repeat replays instead of seeing "in progress"
      save
        .catch((err) => logger.warn({ err: err?.message, key }, 'Could not record idempotency result'))
        .finally(() => json(body));
      return res;
    };
    next();
  };
}

/** Keys older than this are forgotten by the nightly cleanup. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;
