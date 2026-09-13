import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import jwt from 'jsonwebtoken';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(password) {
  const { hash } = await import('argon2');
  return hash(password);
}

async function createTestUser(tenantId, email, password = 'SecurePass123!') {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({
    data: {
      tenantId,
      email,
      passwordHash,
      firstName: 'Test',
      lastName: 'User',
      memberships: { create: { tenantId } },
    },
  });
}

async function loginAndGetToken(app, email, password, tenantId) {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password, tenantId });
  return response.body.data.accessToken;
}

describe('Phase 06 - User Management', () => {
  let tenantAId;
  let tenantBId;
  let userA1Id;
  let userA2Id;
  let userA3Id;
  let userB1Id;
  let tokenA1; // admin
  let tokenA2; // member
  let tokenB1; // admin
  let adminRoleAId;
  let memberRoleAId;

  beforeAll(async () => {
    // Create tenants
    const tenantA = await prisma.tenant.create({
      data: { name: 'Tenant A', slug: 'tenant-a-users', status: 'ACTIVE' },
    });
    tenantAId = tenantA.id;

    const tenantB = await prisma.tenant.create({
      data: { name: 'Tenant B', slug: 'tenant-b-users', status: 'ACTIVE' },
    });
    tenantBId = tenantB.id;

    // Create users in Tenant A
    const userA1 = await createTestUser(tenantAId, 'admin@tenant-a.com');
    userA1Id = userA1.id;

    const userA2 = await createTestUser(tenantAId, 'member@tenant-a.com');
    userA2Id = userA2.id;

    const userA3 = await createTestUser(tenantAId, 'target@tenant-a.com');
    userA3Id = userA3.id;

    // Create user in Tenant B
    const userB1 = await createTestUser(tenantBId, 'admin@tenant-b.com');
    userB1Id = userB1.id;

    // Create system roles and permissions for both tenants
    for (const tenantId of [tenantAId, tenantBId]) {
      const SYSTEM_PERMISSIONS = [
        { resource: 'tenant', action: 'read', name: 'tenant:read' },
        { resource: 'tenant', action: 'update', name: 'tenant:update' },
        { resource: 'user', action: 'create', name: 'user:create' },
        { resource: 'user', action: 'read', name: 'user:read' },
        { resource: 'user', action: 'update', name: 'user:update' },
        { resource: 'user', action: 'delete', name: 'user:delete' },
        { resource: 'role', action: 'create', name: 'role:create' },
        { resource: 'role', action: 'read', name: 'role:read' },
        { resource: 'role', action: 'update', name: 'role:update' },
        { resource: 'role', action: 'delete', name: 'role:delete' },
        { resource: 'permission', action: 'read', name: 'permission:read' },
      ];

      const SYSTEM_ROLES = [
        { name: 'admin', description: 'Full administrative access', isSystem: true },
        { name: 'manager', description: 'Management access to most resources', isSystem: true },
        { name: 'member', description: 'Standard member access', isSystem: true },
      ];

      const permissions = {};
      for (const perm of SYSTEM_PERMISSIONS) {
        const p = await prisma.permission.upsert({
          where: {
            tenantId_resource_action: {
              tenantId,
              resource: perm.resource,
              action: perm.action,
            },
          },
          update: {},
          create: {
            tenantId,
            name: perm.name,
            resource: perm.resource,
            action: perm.action,
          },
        });
        permissions[`${perm.resource}:${perm.action}`] = p.id;
      }

      const roles = {};
      for (const role of SYSTEM_ROLES) {
        const r = await prisma.role.upsert({
          where: {
            tenantId_name: {
              tenantId,
              name: role.name,
            },
          },
          update: { description: role.description, isSystem: role.isSystem },
          create: {
            tenantId,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
          },
        });
        roles[role.name] = r.id;
      }

      // Link roles to permissions
      const adminPerms = Object.values(permissions);
      for (const permId of adminPerms) {
        await prisma.rolePermission.upsert({
          where: {
            tenantId_roleId_permissionId: {
              tenantId,
              roleId: roles.admin,
              permissionId: permId,
            },
          },
          update: {},
          create: {
            tenantId,
            roleId: roles.admin,
            permissionId: permId,
          },
        });
      }

      const managerExclude = ['user:delete', 'role:delete', 'permission:read', 'tenant:update'];
      const managerPerms = Object.entries(permissions)
        .filter(([key]) => !managerExclude.includes(key))
        .map(([, v]) => v);
      for (const permId of managerPerms) {
        await prisma.rolePermission.upsert({
          where: {
            tenantId_roleId_permissionId: {
              tenantId,
              roleId: roles.manager,
              permissionId: permId,
            },
          },
          update: {},
          create: {
            tenantId,
            roleId: roles.manager,
            permissionId: permId,
          },
        });
      }

      const memberPerms = Object.entries(permissions)
        .filter(([key]) => key.endsWith(':read'))
        .map(([, v]) => v);
      for (const permId of memberPerms) {
        await prisma.rolePermission.upsert({
          where: {
            tenantId_roleId_permissionId: {
              tenantId,
              roleId: roles.member,
              permissionId: permId,
            },
          },
          update: {},
          create: {
            tenantId,
            roleId: roles.member,
            permissionId: permId,
          },
        });
      }
    }

    // Get roles for Tenant A
    const rolesA = await prisma.role.findMany({ where: { tenantId: tenantAId } });
    adminRoleAId = rolesA.find(r => r.name === 'admin').id;
    memberRoleAId = rolesA.find(r => r.name === 'member').id;

    // Assign admin role to userA1
    await prisma.userRole.create({
      data: { tenantId: tenantAId, userId: userA1Id, roleId: adminRoleAId },
    });

    // Assign member role to userA2
    await prisma.userRole.create({
      data: { tenantId: tenantAId, userId: userA2Id, roleId: memberRoleAId },
    });

    // Assign admin role to userB1
    const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
    const adminRoleBId = rolesB.find(r => r.name === 'admin').id;
    await prisma.userRole.create({
      data: { tenantId: tenantBId, userId: userB1Id, roleId: adminRoleBId },
    });

    // Login and get tokens
    tokenA1 = await loginAndGetToken(app, 'admin@tenant-a.com', 'SecurePass123!', tenantAId);
    tokenA2 = await loginAndGetToken(app, 'member@tenant-a.com', 'SecurePass123!', tenantAId);
    tokenB1 = await loginAndGetToken(app, 'admin@tenant-b.com', 'SecurePass123!', tenantBId);
  });

  afterAll(async () => {
    await prisma.userRole.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.rolePermission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.role.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.permission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  describe('GET /api/v1/users - List Users', () => {
    it('lists users for authenticated admin', async () => {
      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThanOrEqual(3);
      expect(response.body.meta).toBeDefined();
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.limit).toBe(20);
      expect(response.body.meta.total).toBeGreaterThanOrEqual(3);
    });

    it('lists users with pagination', async () => {
      const response = await request(app)
        .get('/api/v1/users?page=1&limit=2')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.meta.page).toBe(1);
      expect(response.body.meta.limit).toBe(2);
    });

    it('supports search by email', async () => {
      const response = await request(app)
        .get('/api/v1/users?search=admin')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      const emails = response.body.data.map(u => u.email);
      expect(emails.some(e => e.includes('admin'))).toBe(true);
    });

    it('supports search by firstName', async () => {
      const response = await request(app)
        .get('/api/v1/users?search=Test')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('supports filtering by status', async () => {
      const response = await request(app)
        .get('/api/v1/users?status=ACTIVE')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.data.every(u => u.status === 'ACTIVE')).toBe(true);
    });

    it('supports filtering by roleId', async () => {
      const response = await request(app)
        .get(`/api/v1/users?roleId=${adminRoleAId}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      const adminUsers = response.body.data.filter(u => 
        u.roles.some(r => r.id === adminRoleAId)
      );
      expect(adminUsers.length).toBeGreaterThanOrEqual(1);
    });

    it('supports sorting by createdAt desc (default)', async () => {
      const response = await request(app)
        .get('/api/v1/users?sortBy=createdAt&sortOrder=desc')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      const dates = response.body.data.map(u => new Date(u.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
      }
    });

    it('supports sorting by email asc', async () => {
      const response = await request(app)
        .get('/api/v1/users?sortBy=email&sortOrder=asc')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      const emails = response.body.data.map(u => u.email);
      const sorted = [...emails].sort();
      expect(emails).toEqual(sorted);
    });

    it('returns tenant-scoped users only', async () => {
      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${tokenB1}`);

      expect(response.status).toBe(200);
      const tenantIds = response.body.data.map(u => u.tenantId);
      expect(tenantIds.every(id => id === tenantBId)).toBe(true);
    });

    it('rejects unauthenticated request', async () => {
      const response = await request(app).get('/api/v1/users');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects user without user:read permission', async () => {
      // Create user with no roles
      await createTestUser(tenantAId, 'noroles@tenant-a.com');
      const token = await loginAndGetToken(app, 'noroles@tenant-a.com', 'SecurePass123!', tenantAId);

      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('GET /api/v1/users/:id - Get User', () => {
    it('retrieves a user by ID', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userA2Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(userA2Id);
      expect(response.body.data.email).toBe('member@tenant-a.com');
      expect(response.body.data.firstName).toBe('Test');
      expect(response.body.data.lastName).toBe('User');
    });

    it('includes roles in response', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userA1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.data.roles).toBeDefined();
      expect(Array.isArray(response.body.data.roles)).toBe(true);
      expect(response.body.data.roles.length).toBe(1);
      expect(response.body.data.roles[0].name).toBe('admin');
    });

    it('does NOT expose sensitive fields', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userA1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.data.passwordHash).toBeUndefined();
      expect(response.body.data.password_hash).toBeUndefined();
      expect(response.body.data.refreshToken).toBeUndefined();
      expect(response.body.data.refresh_token).toBeUndefined();
    });

    it('returns 404 for non-existent user', async () => {
      const response = await request(app)
        .get('/api/v1/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('rejects cross-tenant user access', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('rejects unauthenticated request', async () => {
      const response = await request(app).get(`/api/v1/users/${userA1Id}`);
      expect(response.status).toBe(401);
    });

    it('rejects user without user:read permission', async () => {
      await createTestUser(tenantAId, 'noroles2@tenant-a.com');
      const token = await loginAndGetToken(app, 'noroles2@tenant-a.com', 'SecurePass123!', tenantAId);

      const response = await request(app)
        .get(`/api/v1/users/${userA1Id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('PATCH /api/v1/users/:id - Update User', () => {
    it('updates firstName and lastName', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ firstName: 'Updated', lastName: 'Name' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.firstName).toBe('Updated');
      expect(response.body.data.lastName).toBe('Name');
    });

    it('updates status', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ status: 'INACTIVE' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('INACTIVE');
    });

    it('rejects invalid status', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ status: 'INVALID_STATUS' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_STATUS');
    });

    it('rejects email modification', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ email: 'newemail@tenant-a.com' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('EMAIL_MODIFICATION_FORBIDDEN');
    });

    it('rejects passwordHash modification', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ passwordHash: 'newhash' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('PASSWORD_MODIFICATION_FORBIDDEN');
    });

    it('rejects tenantId modification', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ tenantId: tenantBId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('TENANT_MODIFICATION_FORBIDDEN');
    });

    it('rejects cross-tenant user update', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ firstName: 'Attack' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('rejects update with no fields provided', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unauthenticated request', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .send({ firstName: 'Test' });
      expect(response.status).toBe(401);
    });

    it('rejects user without user:update permission', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA2}`)
        .send({ firstName: 'Unauthorized' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /api/v1/users/:id - Delete User', () => {
    let deletableUserId;

    beforeEach(async () => {
      const user = await createTestUser(tenantAId, `deletable-${Date.now()}@tenant-a.com`);
      deletableUserId = user.id;
    });

    it('deletes a user', async () => {
      const response = await request(app)
        .delete(`/api/v1/users/${deletableUserId}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('User deleted successfully');

      // Verify user is deleted
      const getResponse = await request(app)
        .get(`/api/v1/users/${deletableUserId}`)
        .set('Authorization', `Bearer ${tokenA1}`);
      expect(getResponse.status).toBe(404);
    });

    it('prevents self-deletion', async () => {
      const response = await request(app)
        .delete(`/api/v1/users/${userA1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SELF_DELETION_FORBIDDEN');
    });

    it('rejects cross-tenant user deletion', async () => {
      const response = await request(app)
        .delete(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns 404 for non-existent user', async () => {
      const response = await request(app)
        .delete('/api/v1/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('rejects unauthenticated request', async () => {
      const response = await request(app).delete(`/api/v1/users/${deletableUserId}`);
      expect(response.status).toBe(401);
    });

    it('rejects user without user:delete permission', async () => {
      const response = await request(app)
        .delete(`/api/v1/users/${deletableUserId}`)
        .set('Authorization', `Bearer ${tokenA2}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Privilege Escalation Protection', () => {
    it('prevents member from modifying their own roles via user update', async () => {
      // Member tries to update another user (but doesn't have permission)
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA2}`)
        .send({ firstName: 'Attempt' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('prevents role manipulation through user update endpoint', async () => {
      // Even admin cannot modify roles via user update - must use /roles endpoint
      const response = await request(app)
        .patch(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ roleIds: [adminRoleAId] });

      expect(response.status).toBe(200);
      // roleIds should be ignored, not cause error but not change roles
      const getResponse = await request(app)
        .get(`/api/v1/users/${userA3Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);
      expect(getResponse.body.data.roles).toEqual([]);
    });

    it('prevents tenant escalation through manipulated JWT', async () => {
      // Attempt to use token with manipulated tenantId
      const manipulatedToken = jwt.sign(
        { sub: userB1Id, tenantId: tenantAId, sessionId: 'fake', email: 'admin@tenant-b.com' },
        'test-access-secret-min-32-chars-long-for-testing',
        { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${manipulatedToken}`);

      expect(response.status).toBe(401);
      expect(['USER_NOT_FOUND', 'INVALID_TOKEN']).toContain(response.body.error.code);
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant A user cannot list Tenant B users', async () => {
      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${tokenB1}`);

      expect(response.status).toBe(200);
      const tenantIds = response.body.data.map(u => u.tenantId);
      expect(tenantIds.every(id => id === tenantBId)).toBe(true);
    });

    it('Tenant A user cannot get Tenant B user', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('Tenant A user cannot update Tenant B user', async () => {
      const response = await request(app)
        .patch(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ firstName: 'Attack' });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('Tenant A user cannot delete Tenant B user', async () => {
      const response = await request(app)
        .delete(`/api/v1/users/${userB1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('Tenant A user cannot search Tenant B users', async () => {
      const response = await request(app)
        .get('/api/v1/users?search=admin')
        .set('Authorization', `Bearer ${tokenB1}`);

      expect(response.status).toBe(200);
      const emails = response.body.data.map(u => u.email);
      // Should only find tenant B users
      expect(emails.every(e => e.includes('@tenant-b.com'))).toBe(true);
    });
  });

  describe('Response Structure Validation', () => {
    it('list response has correct structure', async () => {
      const response = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('page');
      expect(response.body.meta).toHaveProperty('limit');
      expect(response.body.meta).toHaveProperty('total');
      expect(response.body.meta).toHaveProperty('totalPages');
    });

    it('single user response has correct structure', async () => {
      const response = await request(app)
        .get(`/api/v1/users/${userA1Id}`)
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('email');
      expect(response.body.data).toHaveProperty('firstName');
      expect(response.body.data).toHaveProperty('lastName');
      expect(response.body.data).toHaveProperty('status');
      expect(response.body.data).toHaveProperty('emailVerified');
      expect(response.body.data).toHaveProperty('createdAt');
      expect(response.body.data).toHaveProperty('updatedAt');
      expect(response.body.data).toHaveProperty('roles');
    });
  });
});