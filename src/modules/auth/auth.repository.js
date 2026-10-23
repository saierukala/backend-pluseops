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

  // Roles with their permissions, for the /auth/me authorization summary
  async findTenantRolesWithPermissions(userId, tenantId) {
    return this.prisma.userRole.findMany({
      where: { userId, tenantId },
      include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findPlatformRolesWithPermissions(userId) {
    return this.prisma.platformUserRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
      orderBy: { createdAt: 'asc' },
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
        sessionId: data.sessionId ?? null,
        userAgent: data.userAgent ?? null,
        ipAddress: data.ipAddress ?? null,
        lastUsedAt: new Date(),
      },
    });
  }

  // A session is active while it holds an unrevoked, unexpired refresh token
  async isSessionActive(sessionId, userId) {
    const count = await this.prisma.refreshToken.count({
      where: { sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    return count > 0;
  }

  // Active sessions for one user in one tenant, oldest token first (that row carries the session's start)
  async findActiveSessionTokens(userId, tenantId) {
    const active = await this.prisma.refreshToken.findMany({
      where: { userId, tenantId, sessionId: { not: null }, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (active.length === 0) return [];
    const starts = await this.prisma.refreshToken.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: active.map((t) => t.sessionId) } },
      _min: { createdAt: true },
    });
    const startedAt = new Map(starts.map((s) => [s.sessionId, s._min.createdAt]));
    return active.map((t) => ({ ...t, startedAt: startedAt.get(t.sessionId) ?? t.createdAt }));
  }

  async revokeSession(sessionId, userId, tenantId) {
    return this.prisma.refreshToken.updateMany({
      where: { sessionId, userId, tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // Revokes every session of the user except `keepSessionId` (null keeps none)
  async revokeUserSessions(userId, { keepSessionId = null } = {}) {
    return this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepSessionId ? { OR: [{ sessionId: null }, { sessionId: { not: keepSessionId } }] } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  async invalidateUnusedEmailVerificationTokens(userId) {
    return this.prisma.emailVerificationToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
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
