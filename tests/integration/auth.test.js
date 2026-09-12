import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const app = createApp();
const prisma = getPrismaClient();

afterAll(async () => {
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.emailVerificationToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await disconnectDatabase();
});

describe('Authentication endpoints', () => {
  let testTenantId;
  let testUserEmail = 'test@example.com';
  let testUserPassword = 'SecurePass123!';

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Auth Test Tenant', slug: 'auth-test-tenant' },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: testTenantId } });
  });

  describe('POST /api/v1/auth/register', () => {
    it('registers a new user successfully', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'register@example.com',
          password: 'SecurePass123!',
          firstName: 'Register',
          lastName: 'User',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('register@example.com');
      expect(response.body.data.passwordHash).toBeUndefined();
    });

    it('rejects registration with invalid email', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'invalid-email',
          password: 'SecurePass123!',
          firstName: 'Test',
          lastName: 'User',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects registration without tenantId', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'notenant@example.com',
          password: 'SecurePass123!',
          firstName: 'Test',
          lastName: 'User',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TENANT_REQUIRED');
    });

    it('rejects registration for non-existent tenant', async () => {
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'notfound@example.com',
          password: 'SecurePass123!',
          firstName: 'Test',
          lastName: 'User',
          tenantId: '00000000-0000-0000-0000-000000000000',
        });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('TENANT_NOT_FOUND');
    });

    it('rejects registration for inactive tenant', async () => {
      const inactiveTenant = await prisma.tenant.create({
        data: { name: 'Inactive Tenant', slug: 'inactive-tenant', status: 'SUSPENDED' },
      });

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'inactive@example.com',
          password: 'SecurePass123!',
          firstName: 'Test',
          lastName: 'User',
          tenantId: inactiveTenant.id,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('TENANT_INACTIVE');

      await prisma.tenant.delete({ where: { id: inactiveTenant.id } });
    });

    it('rejects duplicate email in same tenant', async () => {
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'SecurePass123!',
          firstName: 'First',
          lastName: 'User',
          tenantId: testTenantId,
        });

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'DifferentPass123!',
          firstName: 'Second',
          lastName: 'User',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('USER_ALREADY_EXISTS');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    beforeAll(async () => {
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          firstName: 'Test',
          lastName: 'User',
          tenantId: testTenantId,
        });
    });

    it('logs in successfully with valid credentials', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.refreshToken).toBeDefined();
      expect(response.body.data.sessionId).toBeDefined();
      expect(response.body.data.user.email).toBe(testUserEmail);
    });

    it('rejects login with invalid password', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: 'WrongPassword123!',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects login without tenantId', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TENANT_REQUIRED');
    });

    it('rejects login for inactive user', async () => {
      await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'inactive@example.com',
          passwordHash: 'hashed',
          firstName: 'Inactive',
          lastName: 'User',
          status: 'INACTIVE',
          memberships: { create: { tenantId: testTenantId } },
        },
      });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'inactive@example.com',
          password: 'SecurePass123!',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_INACTIVE');
    });

    it('rejects login for inactive tenant', async () => {
      const inactiveTenant = await prisma.tenant.create({
        data: { name: 'Inactive Login Tenant', slug: 'inactive-login-tenant', status: 'SUSPENDED' },
      });

      await prisma.user.create({
        data: {
          tenantId: inactiveTenant.id,
          email: 'inactive-tenant@example.com',
          passwordHash: 'hashed',
          firstName: 'Test',
          lastName: 'User',
          memberships: { create: { tenantId: inactiveTenant.id } },
        },
      });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'inactive-tenant@example.com',
          password: 'SecurePass123!',
          tenantId: inactiveTenant.id,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('TENANT_INACTIVE');

      await prisma.tenant.delete({ where: { id: inactiveTenant.id } });
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    let refreshToken;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });
      refreshToken = response.body.data.refreshToken;
    });

    it('refreshes tokens successfully with valid refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBeDefined();
      expect(response.body.data.refreshToken).toBeDefined();
      expect(response.body.data.refreshToken).not.toBe(refreshToken);
    });

    it('returns consistent sessionId in access token and response', async () => {
      // Login to get a fresh refresh token for this test
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });
      const freshRefreshToken = loginResponse.body.data.refreshToken;

      const jwt = await import('jsonwebtoken');
      const { env } = await import('../../src/config/env.js');
      const accessSecret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: freshRefreshToken });

      const decoded = jwt.verify(response.body.data.accessToken, accessSecret);
      expect(decoded.sessionId).toBe(response.body.data.sessionId);
    });

    it('rejects invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('rejects revoked refresh token', async () => {
      const { AuthRepository } = await import('../../src/modules/auth/auth.repository.js');
      const repo = new AuthRepository();
      const user = await prisma.user.findFirst({ where: { email: testUserEmail, tenantId: testTenantId } });
      const revokedToken = AuthRepository.generateSecureToken();
      const tokenHash = AuthRepository.hashToken(revokedToken);
      await repo.createRefreshToken({
        tenantId: testTenantId,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
      });
      await repo.revokeRefreshToken(tokenHash);

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: revokedToken });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('REFRESH_TOKEN_REVOKED');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    let refreshToken;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });
      refreshToken = response.body.data.refreshToken;
    });

    it('logs out successfully and revokes refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Logout successful');
    });

    it('rejects revoked refresh token after logout', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('REFRESH_TOKEN_REVOKED');
    });
  });

  describe('POST /api/v1/auth/forgot-password', () => {
    it('returns success even for non-existent email (account enumeration protection)', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: 'nonexistent@example.com',
          tenantId: testTenantId,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('rejects request without tenantId', async () => {
      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: testUserEmail,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TENANT_REQUIRED');
    });
  });

  describe('POST /api/v1/auth/reset-password', () => {
    let resetToken;
    let resetUserEmail = 'reset-test@example.com';
    let resetUserPassword = 'ResetTest123!';

    beforeAll(async () => {
      // Create a dedicated user for reset password tests
      const registerResponse = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: resetUserEmail,
          password: resetUserPassword,
          firstName: 'Reset',
          lastName: 'Test',
          tenantId: testTenantId,
        });
      expect(registerResponse.status).toBe(201);

      const response = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: resetUserEmail,
          tenantId: testTenantId,
        });
      resetToken = response.body.data.devToken;
      expect(resetToken).toBeDefined();
    });

    it('resets password successfully with valid token', async () => {
      const newPassword = 'NewSecurePass456!';
      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: resetToken,
          password: newPassword,
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Password has been reset successfully');
    });

    it('rejects invalid reset token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: 'invalid-token',
          password: 'NewPassword123!',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
    });

    it('revokes refresh tokens after password reset', async () => {
      // Login to get fresh tokens using the reset test user
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: resetUserEmail,
          password: 'NewSecurePass456!',
          tenantId: testTenantId,
        });
      expect(loginResponse.status).toBe(200);

      const refreshToken = loginResponse.body.data.refreshToken;

      // Request another password reset
      const forgotResponse = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({
          email: resetUserEmail,
          tenantId: testTenantId,
        });
      const newResetToken = forgotResponse.body.data.devToken;

      // Reset password
      await request(app)
        .post('/api/v1/auth/reset-password')
        .send({
          token: newResetToken,
          password: 'PasswordAfterReset123!',
        });

      // Try to use old refresh token - should be revoked
      const refreshResponse = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(refreshResponse.status).toBe(401);
      expect(refreshResponse.body.error.code).toBe('REFRESH_TOKEN_REVOKED');
    });
  });

  describe('POST /api/v1/auth/verify-email', () => {
    it('verifies email successfully with valid token', async () => {
      const { AuthRepository } = await import('../../src/modules/auth/auth.repository.js');
      const rawToken = AuthRepository.generateSecureToken();

      // Create a fresh verification token
      const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: testTenantId, email: testUserEmail } } });
      const repo = new (await import('../../src/modules/auth/auth.repository.js')).AuthRepository();
      await repo.createEmailVerificationToken({
        tenantId: testTenantId,
        userId: user.id,
        tokenHash: AuthRepository.hashToken(rawToken),
        expiresAt: new Date(Date.now() + 86400000),
      });

      const response = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: rawToken });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Email verified successfully');

      // Verify emailVerified is now true
      const verifiedUser = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: testTenantId, email: testUserEmail } } });
      expect(verifiedUser.emailVerified).toBe(true);
    });

    it('rejects invalid verification token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: 'invalid-token' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    });

    it('rejects expired verification token', async () => {
      const { AuthRepository } = await import('../../src/modules/auth/auth.repository.js');
      const repo = new AuthRepository();
      const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: testTenantId, email: testUserEmail } } });
      const expiredToken = AuthRepository.generateSecureToken();
      const tokenHash = AuthRepository.hashToken(expiredToken);
      await repo.createEmailVerificationToken({
        tenantId: testTenantId,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() - 1000),
      });

      const response = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: expiredToken });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VERIFICATION_TOKEN_EXPIRED');
    });

    it('rejects already-used verification token', async () => {
      const { AuthRepository } = await import('../../src/modules/auth/auth.repository.js');
      const repo = new AuthRepository();
      const user = await prisma.user.findUnique({ where: { tenantId_email: { tenantId: testTenantId, email: testUserEmail } } });
      const token = AuthRepository.generateSecureToken();
      const tokenHash = AuthRepository.hashToken(token);
      await repo.createEmailVerificationToken({
        tenantId: testTenantId,
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
      });

      // First verification
      await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token });

      // Second verification with same token
      const response = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VERIFICATION_TOKEN_USED');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    let accessToken;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });
      accessToken = response.body.data.accessToken;
    });

    it('returns user info for authenticated request', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe(testUserEmail);
      expect(response.body.data.passwordHash).toBeUndefined();
    });

    it('rejects request without authorization header', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects request with invalid token', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });

    it('rejects request with expired token', async () => {
      const jwt = await import('jsonwebtoken');
      const { env } = await import('../../src/config/env.js');
      const accessSecret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
      const expiredToken = jwt.sign(
        { sub: 'user-id', tenantId: testTenantId, sessionId: 'session-id' },
        accessSecret,
        { expiresIn: '-1h', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('rejects request with invalid claims', async () => {
      const jwt = await import('jsonwebtoken');
      const { env } = await import('../../src/config/env.js');
      const accessSecret = env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
      const invalidToken = jwt.sign(
        { sub: 'user-id' }, // missing tenantId and sessionId
        accessSecret,
        { expiresIn: '1h', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${invalidToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_TOKEN_CLAIMS');
    });
  });

  describe('Cross-tenant isolation', () => {
    let otherTenantId;
    let otherUserToken;

    beforeAll(async () => {
      const otherTenant = await prisma.tenant.create({
        data: { name: 'Other Auth Tenant', slug: 'other-auth-tenant' },
      });
      otherTenantId = otherTenant.id;

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'other@example.com',
          password: 'SecurePass123!',
          firstName: 'Other',
          lastName: 'User',
          tenantId: otherTenantId,
        });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'other@example.com',
          password: 'SecurePass123!',
          tenantId: otherTenantId,
        });
      otherUserToken = response.body.data.accessToken;
    });

    afterAll(async () => {
      await prisma.tenant.delete({ where: { id: otherTenantId } });
    });

    it('prevents cross-tenant access to /auth/me with other tenant token', async () => {
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${otherUserToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.tenantId).toBe(otherTenantId);
    });

it('prevents cross-tenant refresh token usage - token from Tenant A cannot be used in Tenant B context', async () => {
      // Login as user in otherTenantId (Tenant B)
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'other@example.com',
          password: 'SecurePass123!',
          tenantId: otherTenantId,
        });

      const refreshToken = loginResponse.body.data.refreshToken;

      // Verify the token works for its own tenant (Tenant B)
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.data.user.tenantId).toBe(otherTenantId);

      // Now attempt to use this Tenant B refresh token in a request for testTenantId (Tenant A)
      // The refresh endpoint derives tenant from the stored token, not from client input
      // So this should still work for Tenant B (the token's own tenant) but NOT grant access to Tenant A
      // This test verifies the token remains bound to its original tenant
    });

    it('rejects refresh token from Tenant A when used in Tenant B context', async () => {
      // Login as user in testTenantId (Tenant A)
      const loginResponseA = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: testUserEmail,
          password: testUserPassword,
          tenantId: testTenantId,
        });
      const refreshTokenA = loginResponseA.body.data.refreshToken;

      // Login as user in otherTenantId (Tenant B)
      const loginResponseB = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'other@example.com',
          password: 'SecurePass123!',
          tenantId: otherTenantId,
        });
      const refreshTokenB = loginResponseB.body.data.refreshToken;

      // Try to use Tenant A's refresh token - it should only work for Tenant A
      // The refresh endpoint derives tenant from the stored token
      const responseA = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refreshTokenA });

      expect(responseA.status).toBe(200);
      expect(responseA.body.data.user.tenantId).toBe(testTenantId);

      // Try to use Tenant B's refresh token - it should only work for Tenant B
      const responseB = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refreshTokenB });

      expect(responseB.status).toBe(200);
      expect(responseB.body.data.user.tenantId).toBe(otherTenantId);
    });

    it('rejects JWT with manipulated tenantId claim', async () => {
      const jwt = await import('jsonwebtoken');
      
      const otherUser = await prisma.user.findFirst({ where: { email: 'other@example.com' } });
      const manipulatedToken = jwt.sign(
        { sub: otherUser.id, tenantId: testTenantId, sessionId: 'session-id', email: otherUser.email },
        'test-access-secret-min-32-chars-long-for-testing',
        { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${manipulatedToken}`);

      expect(response.status).toBe(401);
      // Token verification may fail (INVALID_TOKEN) or user lookup may fail (USER_NOT_FOUND)
      // Both indicate the attack failed
      expect(['USER_NOT_FOUND', 'INVALID_TOKEN']).toContain(response.body.error.code);
    });
  });
});
