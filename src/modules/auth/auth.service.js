import { AuthRepository } from './auth.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { signAccessToken } from './jwt.util.js';
import { hashPassword, verifyPassword } from './password.util.js';
import { parseExpiry } from './token-expiry.util.js';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../../config/database.js';

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

  async login(data) {
    const { email, password, tenantId } = data;

    if (!tenantId) {
      throw new AppError('Tenant ID is required for login', {
        statusCode: 400,
        code: 'TENANT_REQUIRED',
      });
    }

    const user = await this.repository.findUserByEmailAndTenant(email, tenantId);
    if (!user) {
      throw new AppError('Invalid credentials', {
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }

    // Validate tenant is active
    if (!this.hasActiveTenant(user, tenantId)) {
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
    const accessToken = this.generateAccessToken(user, sessionId);
    const refreshToken = await this.generateRefreshToken(user, sessionId);

    return {
      user: this.toSafeUser(user),
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  async refresh(data) {
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
      await this.repository.revokeAllUserRefreshTokens(storedToken.userId);
      throw new AppError('Refresh token has been revoked', {
        statusCode: 401,
        code: 'REFRESH_TOKEN_REVOKED',
      });
    }

    const user = await this.repository.findUserByIdAndTenant(storedToken.userId, storedToken.tenantId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppError('User not found or inactive', {
        statusCode: 401,
        code: 'USER_NOT_FOUND',
      });
    }

    // Validate tenant is active
    if (!this.hasActiveTenant(user, storedToken.tenantId)) {
      throw new AppError('Tenant is not active', {
        statusCode: 403,
        code: 'TENANT_INACTIVE',
      });
    }

    const prisma = getPrismaClient();

    // Perform refresh token rotation atomically using Prisma transaction
    const newRefreshTokenRaw = AuthRepository.generateSecureToken();
    const newTokenHash = AuthRepository.hashToken(newRefreshTokenRaw);

    await prisma.$transaction(async (tx) => {
      // Revoke the old refresh token
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

      // Create the new refresh token
      await tx.refreshToken.create({
        data: {
          tenantId: storedToken.tenantId,
          userId: user.id,
          tokenHash: newTokenHash,
          expiresAt: new Date(Date.now() + parseExpiry('7d')),
        },
      });
    });

    const sessionId = randomUUID();

    return {
      user: this.toSafeUser(user),
      accessToken: this.generateAccessToken(user, sessionId),
      refreshToken: newRefreshTokenRaw,
      sessionId,
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

  async forgotPassword(data) {
    const { email, tenantId } = data;

    if (!tenantId) {
      throw new AppError('Tenant ID is required', {
        statusCode: 400,
        code: 'TENANT_REQUIRED',
      });
    }

    const user = await this.repository.findUserByEmailAndTenant(email, tenantId);

    if (!user) {
      return { success: true, message: 'If the email exists, a reset link has been sent' };
    }

    const rawToken = AuthRepository.generateSecureToken();
    const tokenHash = AuthRepository.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + parseExpiry('1h'));

    await this.repository.createPasswordResetToken({
      tenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    return {
      success: true,
      message: 'If the email exists, a reset link has been sent',
      devToken: rawToken,
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

  async getMe(userId, tenantId) {
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
    return this.toSafeUser(user);
  }

  generateAccessToken(user, sessionId, tenantId = user.memberships?.[0]?.tenantId) {
    return signAccessToken({
      sub: user.id,
      tenantId,
      sessionId,
      email: user.email,
    });
  }

  async generateRefreshToken(user, _sessionId, tenantId = user.memberships?.[0]?.tenantId) {
    const rawToken = AuthRepository.generateSecureToken();
    const tokenHash = AuthRepository.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + parseExpiry('7d'));

    await this.repository.createRefreshToken({
      tenantId,
      userId: user.id,
      tokenHash,
      expiresAt,
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

    // Development only - in production this would send an email
    // eslint-disable-next-line no-console
    console.log(`[DEV] Email verification token for user ${userId}: ${rawToken}`);
  }

  toSafeUser(user) {
    return {
      id: user.id,
      tenantId: user.memberships?.[0]?.tenantId ?? user.tenantId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  hasActiveTenant(user, tenantId) {
    const tenant = user.memberships?.find((membership) => membership.tenantId === tenantId)?.tenant;
    return Boolean(tenant && (tenant.status === 'ACTIVE' || tenant.status === 'TRIAL'));
  }
}
