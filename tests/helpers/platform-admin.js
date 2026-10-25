/**
 * Creates a disposable platform administrator for integration tests.
 *
 * Uses its own platform role and user so tests never touch the seeded platform admin.
 * The shared `__platform` tenant is created if missing but never deleted.
 */
import request from 'supertest';
import { hashPassword } from '../../src/modules/auth/password.util.js';
import { PLATFORM_PERMISSIONS } from '../../src/modules/permissions/system-permissions.js';

const PLATFORM_TENANT_SLUG = '__platform';
const PASSWORD = 'PlatformTest#Pass123';

export async function createPlatformAdmin(app, prisma, { suffix = Date.now().toString(36), permissions } = {}) {
  const grants = permissions ?? PLATFORM_PERMISSIONS.map((p) => p.name);

  const platformTenant = await prisma.tenant.upsert({
    where: { slug: PLATFORM_TENANT_SLUG },
    update: {},
    create: { name: 'Platform', slug: PLATFORM_TENANT_SLUG, status: 'ACTIVE', plan: 'platform' },
  });

  const role = await prisma.platformRole.create({ data: { name: `test_platform_${suffix}`, description: 'Test platform role' } });
  for (const name of grants) {
    const separator = name.lastIndexOf(':');
    const resource = name.slice(0, separator);
    const action = name.slice(separator + 1);
    const permission = await prisma.platformPermission.upsert({
      where: { resource_action: { resource, action } },
      update: {},
      create: { name, resource, action },
    });
    await prisma.platformRolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }

  const email = `platform-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      tenantId: platformTenant.id,
      email,
      passwordHash: await hashPassword(PASSWORD),
      firstName: 'Platform',
      lastName: 'Tester',
      status: 'ACTIVE',
      emailVerified: true,
      memberships: { create: { tenantId: platformTenant.id, status: 'ACTIVE' } },
    },
  });
  await prisma.platformUserRole.create({ data: { userId: user.id, roleId: role.id } });

  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD, scope: 'platform' });
  if (login.status !== 200) throw new Error(`Platform test login failed: ${login.status} ${JSON.stringify(login.body)}`);

  return {
    token: login.body.data.accessToken,
    userId: user.id,
    email,
    password: PASSWORD,
    async cleanup() {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.platformRole.delete({ where: { id: role.id } });
    },
  };
}
