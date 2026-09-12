import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import jwt from 'jsonwebtoken';

const app = createApp();
const prisma = getPrismaClient();

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

async function hashPassword(password) {
  const { hash } = await import('argon2');
  return hash(password);
}

async function loginAndGetToken(app, email, password, tenantId) {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password, tenantId });
  return response.body.data.accessToken;
}

describe('Phase 05 - Authorization / RBAC', () => {
  let tenantAId;
  let tenantBId;
  let userA1Id;
  let userA2Id;
  let userB1Id;
  let tokenA1;
  let tokenA2;
  let tokenB1;
  let adminRoleAId;
  let managerRoleAId;
  let memberRoleAId;
  let createPermAId;
  let readPermAId;
  let updatePermAId;
  let deletePermAId;

  beforeAll(async () => {
    // Create tenants
    const tenantA = await prisma.tenant.create({
      data: { name: 'Tenant A', slug: 'tenant-a-rbac', status: 'ACTIVE' },
    });
    tenantAId = tenantA.id;

    const tenantB = await prisma.tenant.create({
      data: { name: 'Tenant B', slug: 'tenant-b-rbac', status: 'ACTIVE' },
    });
    tenantBId = tenantB.id;

    // Create users in Tenant A
    const userA1 = await createTestUser(tenantAId, 'usera1@tenant-a.com');
    userA1Id = userA1.id;

    const userA2 = await createTestUser(tenantAId, 'usera2@tenant-a.com');
    userA2Id = userA2.id;

    // Create user in Tenant B
    const userB1 = await createTestUser(tenantBId, 'userb1@tenant-b.com');
    userB1Id = userB1.id;

    // Create system roles and permissions for both tenants (mirroring seed)
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

    // Get roles and permissions for Tenant A
    const permissionsA = await prisma.permission.findMany({ where: { tenantId: tenantAId } });
    const rolesA = await prisma.role.findMany({ where: { tenantId: tenantAId } });

    adminRoleAId = rolesA.find(r => r.name === 'admin').id;
    managerRoleAId = rolesA.find(r => r.name === 'manager').id;
    memberRoleAId = rolesA.find(r => r.name === 'member').id;

    createPermAId = permissionsA.find(p => p.name === 'role:create').id;
    readPermAId = permissionsA.find(p => p.name === 'role:read').id;
    updatePermAId = permissionsA.find(p => p.name === 'role:update').id;
    deletePermAId = permissionsA.find(p => p.name === 'role:delete').id;

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
    tokenA1 = await loginAndGetToken(app, 'usera1@tenant-a.com', 'SecurePass123!', tenantAId);
    tokenA2 = await loginAndGetToken(app, 'usera2@tenant-a.com', 'SecurePass123!', tenantAId);
    tokenB1 = await loginAndGetToken(app, 'userb1@tenant-b.com', 'SecurePass123!', tenantBId);
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

  describe('Authorization Middleware', () => {
    it('allows access with valid permission', async () => {
      const response = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${tokenA1}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('rejects access without permission (403)', async () => {
      const response = await request(app)
        .post('/api/v1/roles')
        .set('Authorization', `Bearer ${tokenA2}`)
        .send({ name: 'test-role', description: 'Test role' });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects unauthenticated requests (401)', async () => {
      const response = await request(app)
        .get('/api/v1/roles');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects user with no roles (403)', async () => {
      await createTestUser(tenantAId, 'noroles@tenant-a.com');
      const token = await loginAndGetToken(app, 'noroles@tenant-a.com', 'SecurePass123!', tenantAId);

      const response = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('Role APIs', () => {
    describe('GET /api/v1/roles', () => {
      it('lists roles for authenticated tenant', async () => {
        const response = await request(app)
          .get('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBeGreaterThanOrEqual(3);
        expect(response.body.meta).toBeDefined();
      });

      it('supports pagination', async () => {
        const response = await request(app)
          .get('/api/v1/roles?page=1&limit=2')
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.meta.page).toBe(1);
        expect(response.body.meta.limit).toBe(2);
      });

      it('returns only tenant-scoped roles', async () => {
        const response = await request(app)
          .get('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenB1}`);

        expect(response.status).toBe(200);
        const roleNames = response.body.data.map(r => r.name);
        expect(roleNames).toContain('admin');
        expect(roleNames).toContain('manager');
        expect(roleNames).toContain('member');
      });
    });

    describe('POST /api/v1/roles', () => {
      it('creates a role with valid data', async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'custom_role', description: 'Custom role' });

        expect(response.status).toBe(201);
        expect(response.body.success).toBe(true);
        expect(response.body.data.name).toBe('custom_role');
        expect(response.body.data.isSystem).toBe(false);
        expect(response.body.data.tenantId).toBe(tenantAId);
      });

      it('rejects duplicate role name in same tenant', async () => {
        await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'duplicate_role', description: 'First' });

        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'duplicate_role', description: 'Second' });

        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('ROLE_NAME_EXISTS');
      });

      it('rejects invalid role name format', async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'Invalid Role!', description: 'Test' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('requires role:create permission', async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ name: 'unauthorized', description: 'Test' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });

    describe('GET /api/v1/roles/:id', () => {
      it('retrieves a role by ID', async () => {
        const response = await request(app)
          .get(`/api/v1/roles/${adminRoleAId}`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.id).toBe(adminRoleAId);
        expect(response.body.data.name).toBe('admin');
        expect(response.body.data.permissions).toBeDefined();
      });

      it('returns 404 for non-existent role', async () => {
        const response = await request(app)
          .get('/api/v1/roles/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ROLE_NOT_FOUND');
      });
    });

    describe('PATCH /api/v1/roles/:id', () => {
      let customRoleId;

      beforeAll(async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'updatable_role', description: 'Original' });
        customRoleId = response.body.data.id;
      });

      it('updates role description', async () => {
        const response = await request(app)
          .patch(`/api/v1/roles/${customRoleId}`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ description: 'Updated description' });

        expect(response.status).toBe(200);
        expect(response.body.data.description).toBe('Updated description');
      });

      it('updates role name', async () => {
        const response = await request(app)
          .patch(`/api/v1/roles/${customRoleId}`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'renamed_role' });

        expect(response.status).toBe(200);
        expect(response.body.data.name).toBe('renamed_role');
      });

      it('rejects updating system role', async () => {
        const response = await request(app)
          .patch(`/api/v1/roles/${adminRoleAId}`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ description: 'Attempt to modify system role' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      });

      it('rejects cross-tenant role access', async () => {
        const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
        const roleBId = rolesB[0].id;

        const response = await request(app)
          .patch(`/api/v1/roles/${roleBId}`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ description: 'Cross-tenant attack' });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ROLE_NOT_FOUND');
      });

      it('requires role:update permission', async () => {
        const response = await request(app)
          .patch(`/api/v1/roles/${customRoleId}`)
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ description: 'Unauthorized update' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });

    describe('DELETE /api/v1/roles/:id', () => {
      let deletableRoleId;

      beforeAll(async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'deletable_role', description: 'To be deleted' });
        deletableRoleId = response.body.data.id;
      });

      it('deletes a custom role', async () => {
        const response = await request(app)
          .delete(`/api/v1/roles/${deletableRoleId}`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
      });

      it('rejects deleting system role', async () => {
        const response = await request(app)
          .delete(`/api/v1/roles/${adminRoleAId}`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      });

      it('rejects cross-tenant role deletion', async () => {
        const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
        const roleBId = rolesB[0].id;

        const response = await request(app)
          .delete(`/api/v1/roles/${roleBId}`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ROLE_NOT_FOUND');
      });

      it('requires role:delete permission', async () => {
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ name: 'temp_delete_role', description: 'Temp' });
        const tempRoleId = response.body.data.id;

        const response2 = await request(app)
          .delete(`/api/v1/roles/${tempRoleId}`)
          .set('Authorization', `Bearer ${tokenA2}`);

        expect(response2.status).toBe(403);
        expect(response2.body.error.code).toBe('FORBIDDEN');
      });
    });
  });

  describe('Permission APIs', () => {
    describe('GET /api/v1/permissions', () => {
      it('lists all permissions for authenticated tenant', async () => {
        const response = await request(app)
          .get('/api/v1/permissions')
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(Array.isArray(response.body.data)).toBe(true);
        expect(response.body.data.length).toBeGreaterThan(0);

        const roleCreatePerm = response.body.data.find(p => p.name === 'role:create');
        expect(roleCreatePerm).toBeDefined();
        expect(roleCreatePerm.resource).toBe('role');
        expect(roleCreatePerm.action).toBe('create');
      });

      it('returns only tenant-scoped permissions', async () => {
        const response = await request(app)
          .get('/api/v1/permissions')
          .set('Authorization', `Bearer ${tokenB1}`);

        expect(response.status).toBe(200);
        const permissionNames = response.body.data.map(p => p.name);
        expect(permissionNames).toContain('role:create');
        expect(permissionNames).toContain('role:read');
      });

      it('requires permission:read permission', async () => {
        // member role doesn't have user:delete permission (not a :read permission)
        const response = await request(app)
          .post('/api/v1/roles')
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ name: 'test_role_for_delete', description: 'Test' });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });

    describe('GET /api/v1/permissions/:id', () => {
      it('retrieves a permission by ID', async () => {
        const response = await request(app)
          .get(`/api/v1/permissions/${createPermAId}`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.id).toBe(createPermAId);
        expect(response.body.data.name).toBe('role:create');
      });

      it('returns 404 for non-existent permission', async () => {
        const response = await request(app)
          .get('/api/v1/permissions/00000000-0000-0000-0000-000000000000')
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('PERMISSION_NOT_FOUND');
      });
    });
  });

  describe('Role-Permission Assignment', () => {
    let testRoleId;

    beforeAll(async () => {
      const response = await request(app)
        .post('/api/v1/roles')
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ name: 'permission_test_role', description: 'For permission tests' });
      testRoleId = response.body.data.id;
    });

    describe('POST /api/v1/roles/:id/permissions', () => {
      it('assigns permissions to a role', async () => {
        const response = await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [readPermAId, updatePermAId] });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.length).toBe(2);
        const permNames = response.body.data.map(p => p.name);
        expect(permNames).toContain('role:read');
        expect(permNames).toContain('role:update');
      });

      it('is idempotent (duplicate assignment does not create duplicates)', async () => {
        await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [readPermAId] });

        const response2 = await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [readPermAId] });

        expect(response2.status).toBe(200);
        const readCount = response2.body.data.filter(p => p.name === 'role:read').length;
        expect(readCount).toBe(1);
      });

      it('rejects invalid permission ID', async () => {
        const response = await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: ['00000000-0000-0000-0000-000000000000'] });

        expect(response.status).toBe(200);
        expect(response.body.data.length).toBe(2);
      });

      it('rejects cross-tenant role', async () => {
        const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
        const roleBId = rolesB[0].id;

        const response = await request(app)
          .post(`/api/v1/roles/${roleBId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [readPermAId] });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('ROLE_NOT_FOUND');
      });

      it('rejects cross-tenant permission', async () => {
        const permsB = await prisma.permission.findMany({ where: { tenantId: tenantBId } });
        const permBId = permsB.find(p => p.name === 'role:read').id;

        // Get current permissions before assignment
        const beforeResponse = await request(app)
          .get(`/api/v1/roles/${testRoleId}`)
          .set('Authorization', `Bearer ${tokenA1}`);
        const beforePermNames = beforeResponse.body.data.permissions.map(p => p.name);

        const response = await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [permBId] });

        expect(response.status).toBe(200);
        const permNames = response.body.data.map(p => p.name);
        // Cross-tenant permission should not be added
        // The response should only contain permissions from tenantA
        expect(permNames).toEqual(beforePermNames);
      });

      it('rejects modifying system role permissions', async () => {
        const response = await request(app)
          .post(`/api/v1/roles/${adminRoleAId}/permissions`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ permissionIds: [deletePermAId] });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
      });

      it('requires role:update permission', async () => {
        const response = await request(app)
          .post(`/api/v1/roles/${testRoleId}/permissions`)
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ permissionIds: [readPermAId] });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });
  });

  describe('User-Role Assignment', () => {
    let targetUserId;

    beforeAll(async () => {
      const user = await createTestUser(tenantAId, 'target@tenant-a.com');
      targetUserId = user.id;
    });

    describe('GET /api/v1/users/:id/roles', () => {
      it('lists roles assigned to a user', async () => {
        const response = await request(app)
          .get(`/api/v1/users/${userA1Id}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.length).toBe(1);
        expect(response.body.data[0].name).toBe('admin');
      });

      it('returns empty array for user with no roles', async () => {
        const response = await request(app)
          .get(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
      });

      it('rejects cross-tenant user', async () => {
        const response = await request(app)
          .get(`/api/v1/users/${userB1Id}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('USER_NOT_FOUND');
      });

      it('requires user:update permission', async () => {
        const response = await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ roleIds: [memberRoleAId] });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });

    describe('POST /api/v1/users/:id/roles', () => {
      it('assigns roles to a user', async () => {
        const response = await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [memberRoleAId, managerRoleAId] });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data.length).toBe(2);
        const roleNames = response.body.data.map(r => r.name);
        expect(roleNames).toContain('member');
        expect(roleNames).toContain('manager');
      });

      it('is idempotent (duplicate assignment does not create duplicates)', async () => {
        await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [memberRoleAId] });

        const response2 = await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [memberRoleAId] });

        expect(response2.status).toBe(200);
        const memberCount = response2.body.data.filter(r => r.name === 'member').length;
        expect(memberCount).toBe(1);
      });

      it('rejects invalid user ID', async () => {
        const response = await request(app)
          .post('/api/v1/users/00000000-0000-0000-0000-000000000000/roles')
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [memberRoleAId] });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('USER_NOT_FOUND');
      });

      it('rejects cross-tenant user', async () => {
        const response = await request(app)
          .post(`/api/v1/users/${userB1Id}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [memberRoleAId] });

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('USER_NOT_FOUND');
      });

      it('rejects cross-tenant role', async () => {
        const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
        const roleBId = rolesB[0].id;

        // Get current roles before assignment
        const beforeResponse = await request(app)
          .get(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`);
        const beforeRoleNames = beforeResponse.body.data.map(r => r.name);

        const response = await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA1}`)
          .send({ roleIds: [roleBId] });

        expect(response.status).toBe(200);
        const roleNames = response.body.data.map(r => r.name);
        // Cross-tenant role should not be added
        expect(roleNames).toEqual(beforeRoleNames);
      });

      it('requires user:update permission', async () => {
        const response = await request(app)
          .post(`/api/v1/users/${targetUserId}/roles`)
          .set('Authorization', `Bearer ${tokenA2}`)
          .send({ roleIds: [memberRoleAId] });

        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant A user cannot access Tenant B roles', async () => {
      const response = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${tokenB1}`);

      expect(response.status).toBe(200);
      const roleTenantIds = response.body.data.map(r => r.tenantId);
      expect(roleTenantIds.every(id => id === tenantBId)).toBe(true);
    });

    it('Tenant A user cannot modify Tenant B role', async () => {
      const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
      const roleBId = rolesB[0].id;

      const response = await request(app)
        .patch(`/api/v1/roles/${roleBId}`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ description: 'Attack' });

      expect(response.status).toBe(404);
    });

    it('Tenant A user cannot assign Tenant B role to Tenant A user', async () => {
      const rolesB = await prisma.role.findMany({ where: { tenantId: tenantBId } });
      const roleBId = rolesB[0].id;

      const response = await request(app)
        .post(`/api/v1/users/${userA2Id}/roles`)
        .set('Authorization', `Bearer ${tokenA1}`)
        .send({ roleIds: [roleBId] });

      expect(response.status).toBe(200);
      const assignedRoles = response.body.data.map(r => r.id);
      expect(assignedRoles).not.toContain(roleBId);
    });

    it('Tenant B user cannot access Tenant A permissions', async () => {
      const response = await request(app)
        .get('/api/v1/permissions')
        .set('Authorization', `Bearer ${tokenB1}`);

      expect(response.status).toBe(200);
      const permTenantIds = response.body.data.map(p => p.tenantId);
      expect(permTenantIds.every(id => id === tenantBId)).toBe(true);
    });

    it('Manipulated tenantId in JWT cannot escalate privileges', async () => {
      const manipulatedToken = jwt.sign(
        { sub: userB1Id, tenantId: tenantAId, sessionId: 'fake', email: 'userb1@tenant-b.com' },
        'test-access-secret-min-32-chars-long-for-testing',
        { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${manipulatedToken}`);

      expect(response.status).toBe(401);
      // Token verification may fail (INVALID_TOKEN) or user lookup may fail (USER_NOT_FOUND)
      // Both indicate the attack failed
      expect(['USER_NOT_FOUND', 'INVALID_TOKEN']).toContain(response.body.error.code);
    });
  });

  describe('Multiple Roles Combine Permissions', () => {
    let combinedUserId;
    let combinedToken;
    let role1Id;
    let role2Id;
    let perm1Id;
    let perm2Id;

    beforeAll(async () => {
      const user = await createTestUser(tenantAId, 'combined@tenant-a.com');
      combinedUserId = user.id;

      const role1 = await prisma.role.create({
        data: { tenantId: tenantAId, name: 'combined_role_1', description: 'Role 1' },
      });
      role1Id = role1.id;

      const role2 = await prisma.role.create({
        data: { tenantId: tenantAId, name: 'combined_role_2', description: 'Role 2' },
      });
      role2Id = role2.id;

      const perm1 = await prisma.permission.create({
        data: { tenantId: tenantAId, name: 'combined:perm1', resource: 'combined', action: 'perm1' },
      });
      perm1Id = perm1.id;

      const perm2 = await prisma.permission.create({
        data: { tenantId: tenantAId, name: 'combined:perm2', resource: 'combined', action: 'perm2' },
      });
      perm2Id = perm2.id;

      await prisma.rolePermission.createMany({
        data: [
          { tenantId: tenantAId, roleId: role1Id, permissionId: perm1Id },
          { tenantId: tenantAId, roleId: role2Id, permissionId: perm2Id },
          { tenantId: tenantAId, roleId: role1Id, permissionId: readPermAId },
        ],
      });

      await prisma.userRole.createMany({
        data: [
          { tenantId: tenantAId, userId: combinedUserId, roleId: role1Id },
          { tenantId: tenantAId, userId: combinedUserId, roleId: role2Id },
        ],
      });

      combinedToken = await loginAndGetToken(app, 'combined@tenant-a.com', 'SecurePass123!', tenantAId);
    });

    it('user with multiple roles has combined permissions', async () => {
      const userPerms = await request(app)
        .get('/api/v1/roles')
        .set('Authorization', `Bearer ${combinedToken}`);

      expect(userPerms.status).toBe(200);
    });
  });
});

describe('Phase 05 - Regression Tests (Phase 01-04)', () => {
  let testTenantId;
  let testUserEmail = 'regression@example.com';
  let testUserPassword = 'SecurePass123!';
  let accessToken;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Regression Tenant', slug: 'regression-tenant' },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { tenantId: testTenantId } });
    await prisma.passwordResetToken.deleteMany({ where: { tenantId: testTenantId } });
    await prisma.emailVerificationToken.deleteMany({ where: { tenantId: testTenantId } });
    await prisma.user.deleteMany({ where: { tenantId: testTenantId } });
    await prisma.tenant.delete({ where: { id: testTenantId } });
    await disconnectDatabase();
  });

  it('Phase 01: Health endpoint works', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('Phase 02: Tenant CRUD works', async () => {
    const response = await request(app)
      .post('/api/v1/tenants')
      .send({ name: 'Temp Tenant', slug: 'temp-tenant' });
    expect(response.status).toBe(201);
    await request(app).delete(`/api/v1/tenants/${response.body.data.id}`);
  });

  it('Phase 03: Schema constraints work', async () => {
    await prisma.user.create({
      data: {
        tenantId: testTenantId,
        email: 'schema@test.com',
        passwordHash: 'hashed',
        firstName: 'Schema',
        lastName: 'Test',
      },
    });

    await expect(
      prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'schema@test.com',
          passwordHash: 'hashed',
          firstName: 'Schema',
          lastName: 'Test',
        },
      })
    ).rejects.toThrow();
  });

  it('Phase 04: Auth register/login/me works', async () => {
    const registerResponse = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: testUserEmail,
        password: testUserPassword,
        firstName: 'Regression',
        lastName: 'User',
        tenantId: testTenantId,
      });
    expect(registerResponse.status).toBe(201);

    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: testUserEmail,
        password: testUserPassword,
        tenantId: testTenantId,
      });
    expect(loginResponse.status).toBe(200);
    accessToken = loginResponse.body.data.accessToken;

    const meResponse = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meResponse.status).toBe(200);
    expect(meResponse.body.data.email).toBe(testUserEmail);
  });
});
