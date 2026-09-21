import { getPrismaClient } from '../../config/database.js';
import { randomBytes, createHash } from 'node:crypto';

export class AuthRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findUserByEmailAndTenant(email, tenantId) {
    return this.prisma.user.findFirst({
      where: {
        email,
        memberships: { some: { tenantId, status: 'ACTIVE' } },
      },
      include: {
        memberships: { where: { tenantId, status: 'ACTIVE' }, include: { tenant: true } },
        platformUserRoles: { include: { role: true } },
      },
    });
  }

  async findUserByEmail(email) {
    return this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: { include: { tenant: true } },
        platformUserRoles: { include: { role: true } },
      },
    });
  }

  async findTenantBySlug(slug) {
    return this.prisma.tenant.findUnique({
      where: { slug },
    });
  }

  async findPlatformRolesForUser(userId) {
    return this.prisma.platformUserRole.findMany({
      where: { userId },
      include: { role: true },
    });
  }

  async hasPlatformRole(userId) {
    const count = await this.prisma.platformUserRole.count({ where: { userId } });
    return count > 0;
  }

  async findTenantById(tenantId) {
    return this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
  }

  async findUserById(id) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        tenant: true,
      },
    });
  }

  async findUserByIdAndTenant(id, tenantId) {
    return this.prisma.user.findFirst({
      where: { id, memberships: { some: { tenantId, status: 'ACTIVE' } } },
      include: {
        memberships: { where: { tenantId, status: 'ACTIVE' }, include: { tenant: true } },
      },
    });
  }

  async createUser(data) {
    return this.prisma.user.create({
      data: {
        tenantId: data.tenantId,
        email: data.email,
        passwordHash: data.passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        memberships: { create: { tenantId: data.tenantId } },
      },
      include: {
        memberships: { include: { tenant: true } },
      },
    });
  }

  async updateUser(id, data) {
    return this.prisma.user.update({
      where: { id },
      data,
      include: {
        tenant: true,
      },
    });
  }

  async updateLastLogin(userId) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date() },
    });
  }

  async createRefreshToken(data) {
    return this.prisma.refreshToken.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findRefreshTokenByHash(tokenHash) {
    return this.prisma.refreshToken.findFirst({
      where: { tokenHash },
      include: {
        user: {
          include: {
            tenant: true,
          },
        },
        tenant: true,
      },
    });
  }

  async revokeRefreshToken(tokenHash) {
    const token = await this.findRefreshTokenByHash(tokenHash);
    if (!token) return null;
    return this.prisma.refreshToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllUserRefreshTokens(userId) {
    return this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async createPasswordResetToken(data) {
    return this.prisma.passwordResetToken.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findPasswordResetTokenByHash(tokenHash) {
    return this.prisma.passwordResetToken.findFirst({
      where: { tokenHash },
      include: {
        user: {
          include: {
            tenant: true,
          },
        },
        tenant: true,
      },
    });
  }

  async markPasswordResetTokenUsed(tokenHash) {
    const token = await this.findPasswordResetTokenByHash(tokenHash);
    if (!token) return null;
    return this.prisma.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
  }

  async createEmailVerificationToken(data) {
    return this.prisma.emailVerificationToken.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
      },
    });
  }

  async findEmailVerificationTokenByHash(tokenHash) {
    return this.prisma.emailVerificationToken.findFirst({
      where: { tokenHash },
      include: {
        user: {
          include: {
            tenant: true,
          },
        },
        tenant: true,
      },
    });
  }

  async markEmailVerificationTokenUsed(tokenHash) {
    const token = await this.findEmailVerificationTokenByHash(tokenHash);
    if (!token) return null;
    return this.prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
  }

  static generateSecureToken() {
    return randomBytes(32).toString('hex');
  }

  static hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }
}
