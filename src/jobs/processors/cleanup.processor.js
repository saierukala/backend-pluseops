import { logger } from '../../config/logger.js';
import { QUEUE_NAMES, JOB_NAMES } from '../jobs.config.js';
import { getPrismaClient } from '../../config/database.js';

/**
 * Cleanup expired tokens.
 * Tenant-scoped: if tenantId provided, deletes only that tenant's expired tokens; otherwise global.
 * Idempotent: repeated execution deletes only still-expired not-yet-deleted tokens, so retry is safe.
 * Tenant isolation: uses tenantId filter where provided; global cleanup is admin-only server-triggered, not user-triggered.
 */

export async function processCleanupExpiredTokens(payload, opts = {}) {
  const start = Date.now();
  const { tenantId = null } = payload;
  const jobId = opts.jobId || 'unknown';
  const attemptNumber = opts.attempt ?? 1;

  logger.info({ queue: QUEUE_NAMES.CLEANUP, jobId, tenantId: tenantId || 'global', jobName: JOB_NAMES.CLEANUP_EXPIRED_TOKENS, attemptNumber }, 'Processing cleanup job');

  const prisma = getPrismaClient();
  const now = new Date();

  try {
    // Delete expired refresh tokens (revoked or expired)
    const expiredRefresh = await prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lt: now },
        ...(tenantId ? { tenantId } : {}),
      },
    });

    // Delete expired password reset tokens that are expired and not used? We delete all expired regardless of usedAt to keep table tidy
    const expiredPassword = await prisma.passwordResetToken.deleteMany({
      where: {
        expiresAt: { lt: now },
        ...(tenantId ? { tenantId } : {}),
      },
    });

    const expiredEmail = await prisma.emailVerificationToken.deleteMany({
      where: {
        expiresAt: { lt: now },
        ...(tenantId ? { tenantId } : {}),
      },
    });

    // Also delete used tokens that are older than 30 days? Optional tidy but not required for idempotency test
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldUsedPassword = await prisma.passwordResetToken.deleteMany({
      where: {
        usedAt: { not: null, lt: thirtyDaysAgo },
        ...(tenantId ? { tenantId } : {}),
      },
    });
    const oldUsedEmail = await prisma.emailVerificationToken.deleteMany({
      where: {
        usedAt: { not: null, lt: thirtyDaysAgo },
        ...(tenantId ? { tenantId } : {}),
      },
    });

    const result = {
      refreshTokensDeleted: expiredRefresh.count,
      passwordResetTokensDeleted: expiredPassword.count,
      emailVerificationTokensDeleted: expiredEmail.count,
      oldUsedPasswordDeleted: oldUsedPassword.count,
      oldUsedEmailDeleted: oldUsedEmail.count,
      tenantId: tenantId || 'global',
    };

    logger.info({ queue: QUEUE_NAMES.CLEANUP, jobId, tenantId: tenantId || 'global', durationMs: Date.now() - start, result }, 'Cleanup job succeeded');
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    // DB errors are retryable
    logger.error({ queue: QUEUE_NAMES.CLEANUP, jobId, tenantId: tenantId || 'global', attemptNumber, durationMs, err: err?.message }, 'Cleanup job failed');
    throw err;
  }
}
