import crypto from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { logger } from '../../config/logger.js';
import { hashPassword, verifyPassword } from '../auth/password.util.js';
import { signAccessToken } from '../auth/jwt.util.js';

const SESSION_DAYS = 30;
const TOKEN_HOURS = 24;
const exposeDevTokens = () => env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Compared against when the email has no account, so a failed login takes the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const invalidCredentials = () => new AppError('Invalid email or password', { statusCode: 401, code: 'INVALID_CREDENTIALS' });
const invalidRefresh = () => new AppError('Invalid or expired refresh token', { statusCode: 401, code: 'INVALID_REFRESH_TOKEN' });

export function toProfile(c) {
  return { id: c.id, email: c.email, firstName: c.firstName, lastName: c.lastName, phone: c.phone, emailVerified: Boolean(c.emailVerifiedAt), createdAt: c.createdAt };
}

async function issueSession(tx, store, customer, client) {
  const secret = crypto.randomBytes(32).toString('hex');
  const session = await tx.customerSession.create({
    data: {
      tenantId: store.id, customerId: customer.id, refreshTokenHash: 'pending',
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000),
      userAgent: client.userAgent?.slice(0, 512) ?? null, ipAddress: client.ipAddress?.slice(0, 64) ?? null,
    },
  });
  const refreshToken = `${session.id}.${secret}`;
  await tx.customerSession.update({ where: { id: session.id }, data: { refreshTokenHash: sha256(refreshToken) } });
  return tokensFor(store, customer, session.id, refreshToken);
}

function tokensFor(store, customer, sessionId, refreshToken) {
  return {
    accessToken: signAccessToken({ sub: customer.id, tenantId: store.id, sessionId, scope: 'customer' }),
    refreshToken,
    sessionId,
    customer: toProfile(customer),
  };
}

/** Emails a one-time link that verifies the address and lets the shopper choose a password. */
async function sendSetPasswordLink(store, customer, purpose) {
  const prisma = getPrismaClient();
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.$transaction([
    prisma.customerToken.updateMany({ where: { customerId: customer.id, type: 'SET_PASSWORD', usedAt: null }, data: { usedAt: new Date() } }),
    prisma.customerToken.create({ data: { tenantId: store.id, customerId: customer.id, type: 'SET_PASSWORD', tokenHash: sha256(raw), expiresAt: new Date(Date.now() + TOKEN_HOURS * 3600000) } }),
  ]);
  try {
    const { enqueueEmail } = await import('../../jobs/queues/email.queue.js');
    await enqueueEmail({
      tenantId: store.id,
      to: customer.email,
      subject: purpose === 'reset' ? `Reset your ${store.name} password` : `Finish creating your ${store.name} account`,
      text: `Use this code to ${purpose === 'reset' ? 'reset your password' : 'set your password'} at ${store.name}: ${raw}\nIt expires in ${TOKEN_HOURS} hours. If you didn't ask for this, ignore this email.`,
      template: 'customer.set_password',
      variables: { storeName: store.name, code: raw, purpose },
    });
  } catch (err) {
    logger.warn({ err, tenantId: store.id }, 'Could not enqueue customer set-password email');
  }
  return raw;
}

const accepted = (devToken) => ({
  message: 'If the email can be used, a link to set your password is on its way.',
  ...(exposeDevTokens() && devToken ? { devToken } : {}),
});

export class StorefrontAuthService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  // Same response whether or not the email already has an account (no account enumeration). An existing
  // customer record (e.g. created by staff) is attached; the password is chosen via the emailed link only,
  // so registering with someone else's email gives no access.
  async register(store, { email, firstName, lastName, phone }) {
    let customer = await this.prisma.customer.findFirst({ where: { tenantId: store.id, email } });
    if (customer?.deletedAt || customer?.passwordHash) return accepted(null);
    if (!customer) {
      try {
        customer = await this.prisma.customer.create({ data: { tenantId: store.id, email, firstName, lastName, phone: phone ?? null, metadata: { source: 'storefront' } } });
      } catch (err) {
        if (err?.code === 'P2002') return accepted(null);
        throw err;
      }
    }
    return accepted(await sendSetPasswordLink(store, customer, 'signup'));
  }

  async forgotPassword(store, { email }) {
    const customer = await this.prisma.customer.findFirst({ where: { tenantId: store.id, email, deletedAt: null } });
    if (!customer) return accepted(null);
    return accepted(await sendSetPasswordLink(store, customer, customer.passwordHash ? 'reset' : 'signup'));
  }

  /** Redeems the emailed code: verifies the email, sets the password, ends other sessions, signs in. */
  async setPassword(store, { token, password }, client = {}) {
    const record = await this.prisma.customerToken.findUnique({ where: { tokenHash: sha256(token) }, include: { customer: true } });
    if (!record || record.tenantId !== store.id || record.type !== 'SET_PASSWORD' || record.usedAt || record.expiresAt < new Date() || record.customer.deletedAt) {
      throw new AppError('This link is invalid or has expired', { statusCode: 400, code: 'INVALID_TOKEN' });
    }
    const passwordHash = await hashPassword(password);
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.customerToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count === 0) throw new AppError('This link is invalid or has expired', { statusCode: 400, code: 'INVALID_TOKEN' });
      const customer = await tx.customer.update({
        where: { id: record.customerId },
        data: { passwordHash, emailVerifiedAt: record.customer.emailVerifiedAt ?? new Date(), lastLoginAt: new Date() },
      });
      await tx.customerSession.updateMany({ where: { customerId: customer.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return issueSession(tx, store, customer, client);
    });
  }

  async login(store, { email, password }, client = {}) {
    const customer = await this.prisma.customer.findFirst({ where: { tenantId: store.id, email, deletedAt: null } });
    const ok = await verifyPassword(customer?.passwordHash ?? await DUMMY_HASH, password);
    if (!customer?.passwordHash || !customer.emailVerifiedAt || !ok) throw invalidCredentials();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id: customer.id }, data: { lastLoginAt: new Date() } });
      return issueSession(tx, store, updated, client);
    });
  }

  // Rotation with reuse detection: presenting an already-rotated token ends the whole session.
  async refresh(store, { refreshToken }) {
    const sessionId = refreshToken.split('.')[0];
    const session = await this.prisma.customerSession.findFirst({ where: { id: sessionId, tenantId: store.id }, include: { customer: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.customer.deletedAt) throw invalidRefresh();
    if (session.refreshTokenHash !== sha256(refreshToken)) {
      await this.prisma.customerSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      logger.warn({ tenantId: store.id, sessionId }, 'Customer refresh token reuse detected; session revoked');
      throw invalidRefresh();
    }
    const next = `${session.id}.${crypto.randomBytes(32).toString('hex')}`;
    const rotated = await this.prisma.customerSession.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: sha256(next), lastUsedAt: new Date() },
    });
    if (rotated.count === 0) throw invalidRefresh();
    return tokensFor(store, session.customer, session.id, next);
  }

  async logout(store, { refreshToken }) {
    const sessionId = refreshToken.split('.')[0];
    await this.prisma.customerSession.updateMany({
      where: { id: sessionId, tenantId: store.id, refreshTokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export const storefrontAuthService = new StorefrontAuthService();
