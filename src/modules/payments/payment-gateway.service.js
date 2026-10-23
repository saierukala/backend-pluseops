import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret-box.js';
import { credentialsValid, KEY_ID_PATTERN, modeOf } from '../../integrations/payment/razorpay.client.js';
import { auditService } from '../audit/audit.service.js';
import { logger } from '../../config/logger.js';

// Phase 35: each shop connects its own Razorpay account. The key secret and webhook secret are stored encrypted and
// never returned by the API; the response only says whether they are set.

export const webhookPathFor = (tenantId) => `/api/v1/payments/webhook/razorpay/${tenantId}`;

function toView(tenantId, row) {
  if (!row) {
    return { provider: 'razorpay', configured: false, enabled: false, keyId: null, mode: null, webhookSecretSet: false, webhookUrlPath: webhookPathFor(tenantId), updatedAt: null };
  }
  return {
    provider: row.provider, configured: true, enabled: row.enabled, keyId: row.keyId, mode: modeOf(row.keyId),
    webhookSecretSet: Boolean(row.webhookSecretEncrypted), webhookUrlPath: webhookPathFor(tenantId), updatedAt: row.updatedAt,
  };
}

export class PaymentGatewayService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async log(tenantId, auditContext, { action, oldValue, newValue, activity, description }) {
    const { userId = null, ipAddress = null, userAgent = null } = auditContext;
    await auditService.logAudit({ tenantId, userId, action, resource: 'payment_gateway', resourceId: tenantId, oldValue, newValue, ipAddress, userAgent });
    await auditService.logActivity({ tenantId, userId, action: activity, description, metadata: { resourceId: tenantId }, ipAddress, userAgent });
  }

  async get(tenantId) {
    return toView(tenantId, await this.prisma.tenantPaymentGateway.findUnique({ where: { tenantId } }));
  }

  /** Connects (or replaces) the shop's Razorpay keys; Razorpay is asked first whether they work. */
  async save(tenantId, { keyId, keySecret, webhookSecret, enabled = true }, auditContext = {}) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new AppError('keyId must be a Razorpay key id (rzp_test_… or rzp_live_…)', { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    const keySecretEncrypted = encryptSecret(keySecret); // 503 here when production has no encryption key
    if (!(await credentialsValid({ keyId, keySecret }))) {
      throw new AppError('Razorpay rejected these keys. Copy the key id and secret again from Razorpay Dashboard → Account & Settings → API Keys.', { statusCode: 422, code: 'RAZORPAY_KEYS_INVALID' });
    }
    const before = await this.get(tenantId);
    const data = {
      keyId, keySecretEncrypted, enabled,
      webhookSecretEncrypted: webhookSecret ? encryptSecret(webhookSecret) : null,
    };
    const row = await this.prisma.tenantPaymentGateway.upsert({ where: { tenantId }, create: { tenantId, provider: 'razorpay', ...data }, update: data });
    const after = toView(tenantId, row);
    const safe = (v) => ({ keyId: v.keyId, mode: v.mode, enabled: v.enabled, webhookSecretSet: v.webhookSecretSet });
    await this.log(tenantId, auditContext, {
      action: before.configured ? 'UPDATE' : 'CREATE', oldValue: before.configured ? safe(before) : null, newValue: safe(after),
      activity: 'payment_gateway.save', description: `Razorpay connected (${after.mode} keys${after.webhookSecretSet ? ', webhook secret set' : ''})`,
    });
    return after;
  }

  async setEnabled(tenantId, enabled, auditContext = {}) {
    const row = await this.prisma.tenantPaymentGateway.findUnique({ where: { tenantId } });
    if (!row) throw new AppError('No payment gateway is connected', { statusCode: 404, code: 'PAYMENT_GATEWAY_NOT_FOUND' });
    const updated = await this.prisma.tenantPaymentGateway.update({ where: { tenantId }, data: { enabled } });
    await this.log(tenantId, auditContext, {
      action: 'UPDATE', oldValue: { enabled: row.enabled }, newValue: { enabled },
      activity: 'payment_gateway.update', description: `Razorpay ${enabled ? 'enabled' : 'disabled'}`,
    });
    return toView(tenantId, updated);
  }

  async remove(tenantId, auditContext = {}) {
    const { count } = await this.prisma.tenantPaymentGateway.deleteMany({ where: { tenantId } });
    if (!count) throw new AppError('No payment gateway is connected', { statusCode: 404, code: 'PAYMENT_GATEWAY_NOT_FOUND' });
    await this.log(tenantId, auditContext, { action: 'DELETE', oldValue: { provider: 'razorpay' }, newValue: null, activity: 'payment_gateway.delete', description: 'Razorpay disconnected' });
  }

  /**
   * Decrypted credentials for server-side calls, or null when the shop has none (or they are disabled or unreadable).
   * `includeDisabled` serves refunds and webhooks for payments taken before the shop switched Razorpay off.
   */
  async credentialsFor(tenantId, { includeDisabled = false } = {}) {
    const row = await this.prisma.tenantPaymentGateway.findUnique({ where: { tenantId } });
    if (!row || (!row.enabled && !includeDisabled)) return null;
    const keySecret = decryptSecret(row.keySecretEncrypted);
    if (!keySecret) {
      logger.error({ tenantId }, 'Stored Razorpay key secret cannot be decrypted (CREDENTIALS_ENCRYPTION_KEY changed?); the shop must re-enter its keys');
      return null;
    }
    return { keyId: row.keyId, keySecret, webhookSecret: decryptSecret(row.webhookSecretEncrypted) };
  }
}

export const paymentGatewayService = new PaymentGatewayService();
