import { AuthRepository } from './auth.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { signAccessToken } from './jwt.util.js';
import { hashPassword, verifyPassword } from './password.util.js';
import { parseExpiry } from './token-expiry.util.js';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const PLATFORM_TENANT_SLUG = '__platform';

// One-time tokens (reset / verification) may be echoed to the caller only where there is no real email delivery
const EXPOSE_DEV_TOKENS = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';

export class AuthService {
  constructor() {
    this.repository = new AuthRepository();
  }

  async register(data) {
    const { email, password, firstName, lastName, tenantId } = data;

    if (!tenantId) {
      throw new AppError('Tenant ID is required for registration', {
        statusCode: 400,
        code: 'TENANT_REQUIRED',
      });
    }

    // Validate tenant exists and is active
    const tenant = await this.repository.findTenantById(tenantId);
    if (!tenant) {
      throw new AppError('Tenant not found', {
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    }
    if (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL') {
      throw new AppError('Tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }
    if (tenant.slug === PLATFORM_TENANT_SLUG) {
      throw new AppError('Cannot register users into platform tenant', {
        statusCode: 403,
        code: 'PLATFORM_TENANT_FORBIDDEN',
      });
    }

    const existingUser = await this.repository.findUserByEmailAndTenant(email, tenantId);
    if (existingUser) {
      throw new AppError('User with this email already exists in this tenant', {
        statusCode: 409,
        code: 'USER_ALREADY_EXISTS',
      });
    }

    const passwordHash = await hashPassword(password);

    const user = await this.repository.createUser({
      tenantId,
      email,
      passwordHash,
      firstName,
      lastName,
    });

    await this.sendEmailVerification(user.id, tenantId);

    return this.toSafeUser(user);
  }

  async login(data, client = {}) {
    const { email, password, scope, tenantId, tenantSlug } = data;
    const resolvedScope = scope || 'tenant';

    if (resolvedScope === 'platform') {
      return this.platformLogin(email, password, client);
    }

    // TENANT scope
    return this.tenantLogin({ email, password, tenantId, tenantSlug }, client);
  }

  async platformLogin(email, password, client = {}) {
    // Find user by email globally
    const user = await this.repository.findUserByEmail(email);
    if (!user) {
      throw new AppError('Invalid credentials', {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError('Account is not active', {
        statusCode: 403,
        code: 'ACCOUNT_INACTIVE',
      });
    }
    const isValid = await verifyPassword(user.passwordHash, password);
    if (!isValid) {
      throw new AppError('Invalid credentials', {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }
    const hasPlatform = await this.repository.hasPlatformRole(user.id);
    if (!hasPlatform) {
      throw new AppError('Platform access denied', {
        statusCode: 403,
        code: 'PLATFORM_ACCESS_DENIED',
      });
    }
    // Resolve platform tenant id (for refresh token storage)
    let platformTenantId = user.memberships.find((m) => m.tenant?.slug === PLATFORM_TENANT_SLUG)?.tenantId;
    if (!platformTenantId) {
      const prisma = getPrismaClient();
      const pt = await prisma.tenant.findUnique({ where: { slug: PLATFORM_TENANT_SLUG } });
      platformTenantId = pt?.id ?? user.tenantId ?? user.memberships[0]?.tenantId;
    }
    // Validate platform tenant active
    const prisma = getPrismaClient();
    const ptTenant = await prisma.tenant.findUnique({ where: { id: platformTenantId } });
    if (ptTenant && ptTenant.status !== 'ACTIVE' && ptTenant.status !== 'TRIAL') {
      throw new AppError('Platform tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }

    await this.repository.updateLastLogin(user.id);

    const sessionId = randomUUID();
    const accessToken = this.generateAccessToken(user, sessionId, platformTenantId, 'platform');
    const refreshToken = await this.generateRefreshToken(user, sessionId, platformTenantId, client);

    return {
      user: this.toSafeUser(user, platformTenantId, 'platform'),
      accessToken,
      refreshToken,
      sessionId,
      scope: 'platform',
    };
  }

  async tenantLogin({ email, password, tenantId, tenantSlug }, client = {}) {
    let resolvedTenantId = tenantId;
    let resolvedTenant = null;

    if (tenantSlug) {
      resolvedTenant = await this.repository.findTenantBySlug(tenantSlug);
      if (!resolvedTenant) {
        throw new AppError('Tenant not found', {
          statusCode: 404,
          code: 'TENANT_NOT_FOUND',
        });
      }
      if (resolvedTenant.slug === PLATFORM_TENANT_SLUG) {
        throw new AppError('Platform tenant cannot be used for tenant login', {
          statusCode: 403,
          code: 'PLATFORM_TENANT_FORBIDDEN',
        });
      }
      resolvedTenantId = resolvedTenant.id;
    }

    let user;
    let effectiveTenantId;

    if (resolvedTenantId) {
      user = await this.repository.findUserByEmailAndTenant(email, resolvedTenantId);
      if (!user) {
        throw new AppError('Invalid credentials', {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
        });
      }
      effectiveTenantId = resolvedTenantId;
    } else {
      // Auto-resolve tenant via email global lookup
      const globalUser = await this.repository.findUserByEmail(email);
      if (!globalUser) {
        throw new AppError('Invalid credentials', {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
        });
      }
      // Filter out platform tenant memberships for auto-resolve
      const tenantMemberships = globalUser.memberships.filter(
        (m) => m.tenant?.slug !== PLATFORM_TENANT_SLUG && m.status === 'ACTIVE'
      );
      if (tenantMemberships.length === 0) {
        // Check if user is platform-only (no business tenant)
        const hasPlatform = await this.repository.hasPlatformRole(globalUser.id);
        if (hasPlatform) {
          throw new AppError('Use platform login for this account', {
            statusCode: 403,
            code: 'USE_PLATFORM_LOGIN',
          });
        }
        throw new AppError('Tenant not found for user', {
          statusCode: 404,
          code: 'TENANT_NOT_FOUND',
        });
      }
      if (tenantMemberships.length > 1) {
        // Ambiguous - require explicit tenantSlug/tenantId
        throw new AppError('Multiple tenants found, tenantSlug or tenantId required', {
          statusCode: 400,
          code: 'TENANT_REQUIRED',
        });
      }
      effectiveTenantId = tenantMemberships[0].tenantId;
      user = await this.repository.findUserByEmailAndTenant(email, effectiveTenantId);
      if (!user) {
        throw new AppError('Invalid credentials', {
          statusCode: 401,
          code: 'INVALID_CREDENTIALS',
        });
      }
      resolvedTenant = tenantMemberships[0].tenant;
    }

    // Validate tenant is active
    if (!resolvedTenant) {
      resolvedTenant = await this.repository.findTenantById(effectiveTenantId);
    }
    if (!resolvedTenant) {
      throw new AppError('Tenant not found', {
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
      });
    }
    if (resolvedTenant.status !== 'ACTIVE' && resolvedTenant.status !== 'TRIAL') {
      throw new AppError('Tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }
    if (!this.hasActiveTenant(user, effectiveTenantId)) {
      throw new AppError('Tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError('Account is not active', {
        statusCode: 403,
        code: 'ACCOUNT_INACTIVE',
      });
    }

    const isValid = await verifyPassword(user.passwordHash, password);
    if (!isValid) {
      throw new AppError('Invalid credentials', {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }

    await this.repository.updateLastLogin(user.id);

    const sessionId = randomUUID();
    const accessToken = this.generateAccessToken(user, sessionId, effectiveTenantId, 'tenant');
    const refreshToken = await this.generateRefreshToken(user, sessionId, effectiveTenantId, client);

    return {
      user: this.toSafeUser(user, effectiveTenantId, 'tenant'),
      accessToken,
      refreshToken,
      sessionId,
      scope: 'tenant',
    };
  }

  async refresh(data, client = {}) {
    const { refreshToken } = data;

    const tokenHash = AuthRepository.hashToken(refreshToken);

    const storedToken = await this.repository.findRefreshTokenByHash(tokenHash);
    if (!storedToken) {
      throw new AppError('Invalid refresh token', {
        statusCode: 401,
        code: 'INVALID_REFRESH_TOKEN',
      });
    }

    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Refresh token has expired', {
        statusCode: 401,
        code: 'REFRESH_TOKEN_EXPIRED',
      });
    }

    if (storedToken.revokedAt) {
      // Replay of a rotated token means this session's chain leaked: end that session (its whole token family).
      // Legacy tokens have no session id, so fall back to signing the user out everywhere.
      if (storedToken.sessionId) {
        await this.repository.revokeSession(storedToken.sessionId, storedToken.userId, storedToken.tenantId);
      } else {
        await this.repository.revokeAllUserRefreshTokens(storedToken.userId);
      }
      throw new AppError('Refresh token has been revoked', {
        statusCode: 401,
        code: 'REFRESH_TOKEN_REVOKED',
      });
    }

    // Determine scope based on stored token tenant slug
    let scope = 'tenant';
    const prisma = getPrismaClient();
    const tenantRecord = await prisma.tenant.findUnique({ where: { id: storedToken.tenantId } });
    if (tenantRecord?.slug === PLATFORM_TENANT_SLUG) {
      scope = 'platform';
    }

    let user;
    if (scope === 'platform') {
      user = await this.repository.findUserByEmail(storedToken.user?.email ?? '');
      // Fallback to direct lookup if email missing
      if (!user) {
        user = await getPrismaClient().user.findUnique({
          where: { id: storedToken.userId },
          include: { memberships: { include: { tenant: true } }, platformUserRoles: { include: { role: true } } },
        });
      }
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('User not found or inactive', {
          statusCode: 401,
          code: 'USER_NOT_FOUND',
        });
      }
      const hasPlatform = await this.repository.hasPlatformRole(user.id);
      if (!hasPlatform) {
        throw new AppError('Platform access denied', {
          statusCode: 403,
          code: 'PLATFORM_ACCESS_DENIED',
        });
      }
    } else {
      user = await this.repository.findUserByIdAndTenant(storedToken.userId, storedToken.tenantId);
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError('User not found or inactive', {
          statusCode: 401,
          code: 'USER_NOT_FOUND',
        });
      }
      if (!this.hasActiveTenant(user, storedToken.tenantId)) {
        throw new AppError('Tenant is not active', {
          statusCode: 403,
          code: 'TENANT_INACTIVE',
        });
      }
    }

    // The session survives rotation; legacy tokens (pre-Phase 28) start a session on first refresh
    const sessionId = storedToken.sessionId ?? randomUUID();

    // Perform refresh token rotation atomically using Prisma transaction
    const newRefreshTokenRaw = AuthRepository.generateSecureToken();
    const newTokenHash = AuthRepository.hashToken(newRefreshTokenRaw);

    await prisma.$transaction(async (tx) => {
      const oldToken = await tx.refreshToken.findFirst({
        where: { tokenHash },
      });
      if (!oldToken) {
        throw new AppError('Invalid refresh token', {
          statusCode: 401,
          code: 'INVALID_REFRESH_TOKEN',
        });
      }
      await tx.refreshToken.update({
        where: { id: oldToken.id },
        data: { revokedAt: new Date() },
      });

      await tx.refreshToken.create({
        data: {
          tenantId: storedToken.tenantId,
          userId: user.id,
          tokenHash: newTokenHash,
          expiresAt: new Date(Date.now() + parseExpiry('7d')),
          sessionId,
          userAgent: client.userAgent ?? storedToken.userAgent ?? null,
          ipAddress: client.ipAddress ?? storedToken.ipAddress ?? null,
          lastUsedAt: new Date(),
        },
      });
    });

    return {
      user: this.toSafeUser(user, storedToken.tenantId, scope),
      accessToken: this.generateAccessToken(user, sessionId, storedToken.tenantId, scope),
      refreshToken: newRefreshTokenRaw,
      sessionId,
      scope,
    };
  }

  async logout(data) {
    const { refreshToken } = data;

    if (refreshToken) {
      const tokenHash = AuthRepository.hashToken(refreshToken);
      await this.repository.revokeRefreshToken(tokenHash);
    }

    return { success: true, message: 'Logged out successfully' };
  }

  // ── Phase 28: account self-service ─────────────────────────────────

  async findActiveUser(userId) {
    const user = await this.repository.findUserById(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('User not found or inactive', { statusCode: 401, code: 'USER_NOT_FOUND' });
    }
    return user;
  }

  /** Changes the password and signs out every other session; the caller's session stays valid. */
  async changePassword(userId, sessionId, { currentPassword, newPassword }) {
    const user = await this.findActiveUser(userId);
    // 400, not 401: a wrong current password must not look like an expired login to the client
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError('Current password is incorrect', { statusCode: 400, code: 'INVALID_CURRENT_PASSWORD' });
    }
    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw new AppError('New password must be different from the current password', { statusCode: 400, code: 'PASSWORD_UNCHANGED' });
    }

    await this.repository.updateUser(userId, { passwordHash: await hashPassword(newPassword) });
    const { count } = await this.repository.revokeUserSessions(userId, { keepSessionId: sessionId });
    return { success: true, otherSessionsRevoked: count };
  }

  async updateMe(userId, tenantId, { firstName, lastName }) {
    await this.findActiveUser(userId);
    await this.repository.updateUser(userId, {
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {}),
    });
    return this.getMe(userId, tenantId, 'tenant');
  }

  async resendVerification(userId, tenantId) {
    const user = await this.findActiveUser(userId);
    if (user.emailVerified) {
      throw new AppError('Email is already verified', { statusCode: 409, code: 'EMAIL_ALREADY_VERIFIED' });
    }
    // Only the newest link works
    await this.repository.invalidateUnusedEmailVerificationTokens(userId);
    const devToken = await this.sendEmailVerification(userId, tenantId);
    return { success: true, ...(devToken ? { devToken } : {}) };
  }

  async listSessions(userId, tenantId, currentSessionId) {
    const tokens = await this.repository.findActiveSessionTokens(userId, tenantId);
    const sessions = new Map();
    for (const t of tokens) {
      if (sessions.has(t.sessionId)) continue; // newest token per session wins (ordered desc)
      sessions.set(t.sessionId, {
        id: t.sessionId,
        current: t.sessionId === currentSessionId,
        userAgent: t.userAgent,
        ipAddress: t.ipAddress,
        createdAt: t.startedAt,
        lastUsedAt: t.lastUsedAt ?? t.createdAt,
        expiresAt: t.expiresAt,
      });
    }
    return [...sessions.values()];
  }

  async revokeSession(userId, tenantId, sessionId) {
    const { count } = await this.repository.revokeSession(sessionId, userId, tenantId);
    if (count === 0) {
      throw new AppError('Session not found', { statusCode: 404, code: 'SESSION_NOT_FOUND' });
    }
    return { success: true };
  }

  async logoutAll(userId) {
    const { count } = await this.repository.revokeUserSessions(userId);
    return { success: true, sessionsRevoked: count };
  }

  async forgotPassword(data) {
    const { email, tenantId, tenantSlug } = data;

    let resolvedTenantId = tenantId;
    if (tenantSlug) {
      const t = await this.repository.findTenantBySlug(tenantSlug);
      if (!t) return { success: true, message: 'If the email exists, a reset link has been sent' };
      resolvedTenantId = t.id;
    }

    let user;
    let effectiveTenantId = resolvedTenantId;
    if (resolvedTenantId) {
      user = await this.repository.findUserByEmailAndTenant(email, resolvedTenantId);
    } else {
      const globalUser = await this.repository.findUserByEmail(email);
      if (!globalUser) {
        return { success: true, message: 'If the email exists, a reset link has been sent' };
      }
      const activeMemberships = globalUser.memberships.filter(
        (m) => m.tenant?.slug !== PLATFORM_TENANT_SLUG && m.status === 'ACTIVE'
      );
      if (activeMemberships.length === 1) {
        effectiveTenantId = activeMemberships[0].tenantId;
        user = await this.repository.findUserByEmailAndTenant(email, effectiveTenantId);
      } else if (activeMemberships.length === 0) {
        return { success: true, message: 'If the email exists, a reset link has been sent' };
      } else {
        // ambiguous requires tenantId/tenantSlug - avoid enumeration, return success
        return { success: true, message: 'If the email exists, a reset link has been sent' };
      }
    }

    if (!user) {
      return { success: true, message: 'If the email exists, a reset link has been sent' };
    }

    const rawToken = AuthRepository.generateSecureToken();
    const tokenHash = AuthRepository.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + parseExpiry('1h'));

    await this.repository.createPasswordResetToken({
      tenantId: effectiveTenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return {
      success: true,
      message: 'If the email exists, a reset link has been sent',
      ...(EXPOSE_DEV_TOKENS ? { devToken: rawToken } : {}),
    };
  }

  async resetPassword(data) {
    const { token, password } = data;

    const tokenHash = AuthRepository.hashToken(token);
    const storedToken = await this.repository.findPasswordResetTokenByHash(tokenHash);

    if (!storedToken) {
      throw new AppError('Invalid or expired reset token', {
        statusCode: 400,
        code: 'INVALID_RESET_TOKEN',
      });
    }

    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Reset token has expired', {
        statusCode: 400,
        code: 'RESET_TOKEN_EXPIRED',
      });
    }

    if (storedToken.usedAt) {
      throw new AppError('Reset token has already been used', {
        statusCode: 400,
        code: 'RESET_TOKEN_USED',
      });
    }

    const passwordHash = await hashPassword(password);

    await this.repository.updateUser(storedToken.userId, { passwordHash });
    await this.repository.markPasswordResetTokenUsed(tokenHash);
    await this.repository.revokeAllUserRefreshTokens(storedToken.userId);

    return { success: true, message: 'Password has been reset successfully' };
  }

  async verifyEmail(data) {
    const { token } = data;

    const tokenHash = AuthRepository.hashToken(token);
    const storedToken = await this.repository.findEmailVerificationTokenByHash(tokenHash);

    if (!storedToken) {
      throw new AppError('Invalid or expired verification token', {
        statusCode: 400,
        code: 'INVALID_VERIFICATION_TOKEN',
      });
    }

    if (storedToken.expiresAt < new Date()) {
      throw new AppError('Verification token has expired', {
        statusCode: 400,
        code: 'VERIFICATION_TOKEN_EXPIRED',
      });
    }

    if (storedToken.usedAt) {
      throw new AppError('Verification token has already been used', {
        statusCode: 400,
        code: 'VERIFICATION_TOKEN_USED',
      });
    }

    await this.repository.updateUser(storedToken.userId, { emailVerified: true });
    await this.repository.markEmailVerificationTokenUsed(tokenHash);

    return { success: true, message: 'Email verified successfully' };
  }

  async getMe(userId, tenantId, scope = 'tenant') {
    if (scope === 'platform') {
      const user = await this.repository.findUserByEmail(
        (await getPrismaClient().user.findUnique({ where: { id: userId } }))?.email ?? ''
      );
      const full = user ?? await getPrismaClient().user.findUnique({
        where: { id: userId },
        include: { memberships: { include: { tenant: true } }, platformUserRoles: { include: { role: true } } },
      });
      if (!full || full.status !== 'ACTIVE') {
        throw new AppError('User not found', { statusCode: 404, code: 'USER_NOT_FOUND' });
      }
      const platformRoles = await this.repository.findPlatformRolesWithPermissions(userId);
      if (platformRoles.length === 0) throw new AppError('Platform access denied', { statusCode: 403, code: 'PLATFORM_ACCESS_DENIED' });
      return {
        ...this.toSafeUser(full, tenantId, 'platform'),
        ...this.toAuthorizationSummary(platformRoles.map((ur) => ({
          role: ur.role,
          permissions: ur.role.permissions.map((rp) => rp.permission),
        }))),
      };
    }
    const user = await this.repository.findUserByIdAndTenant(userId, tenantId);
    if (!user) {
      throw new AppError('User not found', {
        statusCode: 404,
        code: 'USER_NOT_FOUND',
      });
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError('Account is not active', {
        statusCode: 403,
        code: 'ACCOUNT_INACTIVE',
      });
    }
    if (!this.hasActiveTenant(user, tenantId)) {
      throw new AppError('Tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }
    const tenantRoles = await this.repository.findTenantRolesWithPermissions(userId, tenantId);
    const tenant = user.memberships.find((m) => m.tenantId === tenantId).tenant;
    return {
      ...this.toSafeUser(user, tenantId, 'tenant'),
      // Phase 30 (frontend F08): the business this login belongs to
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, plan: tenant.plan },
      ...this.toAuthorizationSummary(tenantRoles.map((ur) => ({
        role: ur.role,
        permissions: ur.role.rolePermissions.map((rp) => rp.permission),
      }))),
    };
  }

  /**
   * What the client may show: the user's roles and the de-duplicated union of their permission
   * names (`resource:action`). Informational only — every request is still authorized server-side.
   */
  toAuthorizationSummary(grants) {
    const permissions = new Set();
    for (const { permissions: granted } of grants) {
      for (const permission of granted) permissions.add(permission.name ?? `${permission.resource}:${permission.action}`);
    }
    return {
      roles: grants.map(({ role }) => ({ id: role.id, name: role.name, description: role.description, isSystem: role.isSystem })),
      permissions: [...permissions].sort(),
    };
  }

  generateAccessToken(user, sessionId, tenantId = user.memberships?.[0]?.tenantId, scope = 'tenant') {
    return signAccessToken({
      sub: user.id,
      tenantId,
      sessionId,
      email: user.email,
      scope,
    });
  }

  async generateRefreshToken(user, sessionId, tenantId = user.memberships?.[0]?.tenantId, client = {}) {
    const rawToken = AuthRepository.generateSecureToken();
    const tokenHash = AuthRepository.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + parseExpiry('7d'));

    await this.repository.createRefreshToken({
      tenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
      sessionId,
      userAgent: client.userAgent,
      ipAddress: client.ipAddress,
    });

    return rawToken;
  }

  async sendEmailVerification(userId, tenantId) {
    const rawToken = AuthRepository.generateSecureToken();
    const tokenHash = AuthRepository.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + parseExpiry('24h'));

    await this.repository.createEmailVerificationToken({
      tenantId,
      userId,
      tokenHash,
      expiresAt,
    });

    // No email delivery yet: surface the token only in development/test, never in deployed logs
    if (EXPOSE_DEV_TOKENS) {
      logger.info({ userId }, `[DEV] Email verification token: ${rawToken}`);
    }
    return EXPOSE_DEV_TOKENS ? rawToken : undefined;
  }

  toSafeUser(user, tenantIdOverride = null, scope = null) {
    const tenantId = tenantIdOverride ?? user.memberships?.[0]?.tenantId ?? user.tenantId;
    const base = {
      id: user.id,
      tenantId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
    if (scope) base.scope = scope;
    return base;
  }

  hasActiveTenant(user, tenantId) {
    const tenant = user.memberships?.find((membership) => membership.tenantId === tenantId)?.tenant;
    return Boolean(tenant && (tenant.status === 'ACTIVE' || tenant.status === 'TRIAL'));
  }
}
