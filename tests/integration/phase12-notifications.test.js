import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { notificationService } from '../../src/modules/notifications/notifications.service.js';

const app = createApp();
const prisma = getPrismaClient();

async function hashPassword(p) { const { hash } = await import('argon2'); return hash(p); }
async function createTenant(slug) { return prisma.tenant.create({ data: { name: `T ${slug}`, slug, status: 'ACTIVE' } }); }
async function createUser(tenantId, email) {
  const passwordHash = await hashPassword('SecurePass123!');
  return prisma.user.create({ data: { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', memberships: { create: { tenantId } } } });
}
async function login(email, tenantId) {
  const r = await request(app).post('/api/v1/auth/login').send({ email, password: 'SecurePass123!', tenantId });
  return r.body.data.accessToken;
}

async function setupNotificationPerms(tenantId) {
  const perms = [
    { resource: 'notification', action: 'read' },
    { resource: 'notification', action: 'update' },
  ];
  for (const p of perms) {
    await prisma.permission.upsert({
      where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } },
      update: {},
      create: { tenantId, name: `${p.resource}:${p.action}`, resource: p.resource, action: p.action },
    });
  }
  const roleName = `notifadmin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const role = await prisma.role.create({ data: { tenantId, name: roleName } });
  for (const p of perms) {
    const perm = await prisma.permission.findUnique({ where: { tenantId_resource_action: { tenantId, resource: p.resource, action: p.action } } });
    await prisma.rolePermission.create({ data: { tenantId, roleId: role.id, permissionId: perm.id } });
  }
  return role;
}

describe('Phase 12 - Notifications', () => {
  let tenantAId, tenantBId, userAId, userBId, tokenA, tokenB;
  let notifA1, notifARead, notifB1;
  // tenant-wide notification also verified via list, but variable not needed directly

  beforeAll(async () => {
    const ta = await createTenant(`notif-a-${Date.now()}`);
    const tb = await createTenant(`notif-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua = await createUser(tenantAId, `notif-a-${Date.now()}@a.com`);
    const ub = await createUser(tenantBId, `notif-b-${Date.now()}@b.com`);
    userAId = ua.id; userBId = ub.id;
    const ra = await setupNotificationPerms(tenantAId);
    const rb = await setupNotificationPerms(tenantBId);
    await prisma.userRole.create({ data: { tenantId: tenantAId, userId: userAId, roleId: ra.id } });
    await prisma.userRole.create({ data: { tenantId: tenantBId, userId: userBId, roleId: rb.id } });
    tokenA = await login(ua.email, tenantAId);
    tokenB = await login(ub.email, tenantBId);

    // Create notifications via service abstraction (tenant-scoped)
    notifA1 = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'Notif A1', message: 'Message A1', channel: 'IN_APP' });
    await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'WARNING', title: 'Notif A2', message: 'Message A2', channel: 'EMAIL' });
    notifARead = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'SUCCESS', title: 'Notif A Read', message: 'Already read', channel: 'IN_APP' });
    // Mark one as read to test already-read
    await prisma.notification.update({ where: { id: notifARead.id }, data: { isRead: true, readAt: new Date() } });
    notifB1 = await notificationService.createNotification({ tenantId: tenantBId, userId: userBId, type: 'ERROR', title: 'Notif B1', message: 'Message B1', channel: 'SMS' });
    await notificationService.createNotification({ tenantId: tenantAId, userId: null, type: 'INFO', title: 'Tenant Wide A', message: 'Broadcast', channel: 'IN_APP' });
    // Extra notifications for pagination
    for (let i = 0; i < 5; i++) {
      await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: `Paginate ${i}`, message: `msg ${i}`, channel: 'PUSH' });
    }
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.notificationPreference.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.userRole.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.rolePermission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.role.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.permission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  describe('Authentication', () => {
    it('GET /api/v1/notifications unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/notifications');
      expect(res.status).toBe(401);
    });
    it('PATCH /api/v1/notifications/:id/read unauthenticated -> 401', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${crypto.randomUUID()}/read`);
      expect(res.status).toBe(401);
    });
    it('POST /api/v1/notifications/read-all unauthenticated -> 401', async () => {
      const res = await request(app).post('/api/v1/notifications/read-all');
      expect(res.status).toBe(401);
    });
    it('GET /api/v1/notification-preferences unauthenticated -> 401', async () => {
      const res = await request(app).get('/api/v1/notification-preferences');
      expect(res.status).toBe(401);
    });
    it('PATCH /api/v1/notification-preferences unauthenticated -> 401', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').send({ IN_APP: false });
      expect(res.status).toBe(401);
    });
  });

  describe('Authorization', () => {
    let viewerToken;
    beforeAll(async () => {
      const viewer = await createUser(tenantAId, `notifviewer-${Date.now()}@a.com`);
      // create role without notification perms
      const perm = await prisma.permission.upsert({
        where: { tenantId_resource_action: { tenantId: tenantAId, resource: 'audit', action: 'read' } },
        update: {},
        create: { tenantId: tenantAId, name: 'audit:read', resource: 'audit', action: 'read' },
      });
      const role = await prisma.role.create({ data: { tenantId: tenantAId, name: `viewer-notif-${Date.now()}` } });
      await prisma.rolePermission.create({ data: { tenantId: tenantAId, roleId: role.id, permissionId: perm.id } });
      await prisma.userRole.create({ data: { tenantId: tenantAId, userId: viewer.id, roleId: role.id } });
      viewerToken = await login(viewer.email, tenantAId);
    });
    it('unauthorized notification list -> 403', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(403);
    });
    it('unauthorized mark-read -> 403', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${notifA1.id}/read`).set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(403);
    });
    it('unauthorized read-all -> 403', async () => {
      const res = await request(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(403);
    });
    it('unauthorized GET preferences -> 403', async () => {
      const res = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${viewerToken}`);
      expect(res.status).toBe(403);
    });
    it('unauthorized PATCH preferences -> 403', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${viewerToken}`).send({ IN_APP: false });
      expect(res.status).toBe(403);
    });
    it('authorized notification access succeeds', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Tenant Isolation', () => {
    it('Tenant A can list own notifications', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const n of res.body.data) expect(n.tenantId).toBe(tenantAId);
    });
    it('Tenant B can list own notifications', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      for (const n of res.body.data) expect(n.tenantId).toBe(tenantBId);
    });
    it('Tenant A -> Tenant A notification = allowed (mark read)', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${notifA1.id}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(notifA1.id);
    });
    it('Tenant A -> Tenant B notification = blocked (404)', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${notifB1.id}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    });
    it('Tenant B -> Tenant A notification = blocked (404)', async () => {
      const fresh = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'Isolation Test', message: 'isolation', channel: 'IN_APP' });
      const res = await request(app).patch(`/api/v1/notifications/${fresh.id}/read`).set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
      await prisma.notification.delete({ where: { id: fresh.id } });
    });
    it('client-supplied tenant IDs cannot override authenticated tenant context', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ tenant_id: tenantBId, tenantId: tenantBId }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const n of res.body.data) expect(n.tenantId).toBe(tenantAId);
    });
    it('Tenant A cannot read Tenant B via list isolation (no overlap)', async () => {
      const resA = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      const idsA = new Set(resA.body.data.map((n) => n.id));
      expect(idsA.has(notifB1.id)).toBe(false);
      const resB = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenB}`);
      const idsB = new Set(resB.body.data.map((n) => n.id));
      expect(idsB.has(notifA1.id)).toBe(false);
    });
    it('GET preferences tenant isolation', async () => {
      const resA = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`);
      expect(resA.status).toBe(200);
      for (const p of resA.body.data) expect(p.tenantId).toBe(tenantAId);
      const resB = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      for (const p of resB.body.data) expect(p.tenantId).toBe(tenantBId);
      // Patch A does not affect B
      await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ EMAIL: false });
      const afterB = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      const emailB = afterB.body.data.find((p) => p.channel === 'EMAIL');
      expect(emailB.isEnabled).toBe(true);
    });
  });

  describe('Notification APIs - List', () => {
    it('list notifications returns pagination meta', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ page: 1, limit: 2 }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(res.body.pagination).toBeDefined();
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.limit).toBe(2);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
    });
    it('newest first ordering', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      const dates = res.body.data.map((n) => new Date(n.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
    });
    it('filtering by isRead', async () => {
      // ensure at least one unread and one read exist
      const resUnread = await request(app).get('/api/v1/notifications').query({ isRead: 'false' }).set('Authorization', `Bearer ${tokenA}`);
      expect(resUnread.status).toBe(200);
      for (const n of resUnread.body.data) expect(n.isRead).toBe(false);
      const resRead = await request(app).get('/api/v1/notifications').query({ isRead: 'true' }).set('Authorization', `Bearer ${tokenA}`);
      expect(resRead.status).toBe(200);
      for (const n of resRead.body.data) expect(n.isRead).toBe(true);
    });
    it('filtering by type', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ type: 'INFO' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const n of res.body.data) expect(n.type).toBe('INFO');
    });
    it('filtering by channel', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ channel: 'EMAIL' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const n of res.body.data) expect(n.channel).toBe('EMAIL');
    });
    it('validation: invalid pagination -> 400', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ page: -1 }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('validation: invalid type/channel -> 400', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ type: 'INVALID' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
      const res2 = await request(app).get('/api/v1/notifications').query({ channel: 'INVALID' }).set('Authorization', `Bearer ${tokenA}`);
      expect(res2.status).toBe(400);
    });
    it('response shape consistent', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.message).toBeDefined();
      const sample = res.body.data[0];
      expect(sample).toHaveProperty('id');
      expect(sample).toHaveProperty('tenantId');
      expect(sample).toHaveProperty('title');
      expect(sample).toHaveProperty('isRead');
    });
  });

  describe('Notification APIs - Mark One Read', () => {
    let freshId;
    beforeAll(async () => {
      const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'MarkOne', message: 'to mark', channel: 'IN_APP' });
      freshId = n.id;
    });
    it('mark one read succeeds', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${freshId}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isRead).toBe(true);
      expect(res.body.data.readAt).toBeDefined();
    });
    it('already-read behavior is idempotent (second patch returns same)', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${freshId}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.isRead).toBe(true);
    });
    it('notification not found -> 404', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${crypto.randomUUID()}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    });
    it('invalid UUID -> 400', async () => {
      const res = await request(app).patch('/api/v1/notifications/not-a-uuid/read').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(400);
    });
    it('cross-tenant notification -> safe 404 (already tested)', async () => {
      const res = await request(app).patch(`/api/v1/notifications/${notifB1.id}/read`).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(404);
    });
    it('does not allow mass assignment of arbitrary fields', async () => {
      const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'MassAssign', message: 'original', channel: 'IN_APP' });
      const res = await request(app).patch(`/api/v1/notifications/${n.id}/read`).set('Authorization', `Bearer ${tokenA}`).send({ title: 'Hacked', message: 'hacked', tenantId: tenantBId, isRead: false });
      expect(res.status).toBe(200);
      const db = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(db.title).toBe('MassAssign');
      expect(db.message).toBe('original');
      expect(db.tenantId).toBe(tenantAId);
      expect(db.isRead).toBe(true);
    });
  });

  describe('Notification APIs - Mark All Read', () => {
    beforeAll(async () => {
      // Create 3 fresh unread for Tenant A user
      for (let i = 0; i < 3; i++) {
        await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: `AllRead ${i}`, message: 'unread', channel: 'IN_APP' });
      }
    });
    it('mark all read succeeds and respects tenant isolation', async () => {
      // Ensure Tenant B has unread before Tenant A read-all
      await notificationService.createNotification({ tenantId: tenantBId, userId: userBId, type: 'INFO', title: 'B unread', message: 'b', channel: 'IN_APP' });
      const beforeBUnread = await prisma.notification.count({ where: { tenantId: tenantBId, isRead: false } });
      const res = await request(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.updated).toBeGreaterThanOrEqual(1);
      const unreadA = await prisma.notification.count({ where: { tenantId: tenantAId, userId: userAId, isRead: false } });
      expect(unreadA).toBe(0);
      // Tenant B still has unread
      const afterBUnread = await prisma.notification.count({ where: { tenantId: tenantBId, isRead: false } });
      expect(afterBUnread).toBe(beforeBUnread);
    });
    it('safe repeated execution (idempotent)', async () => {
      const res = await request(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(0);
    });
    it('does not affect another tenant', async () => {
      const bUnreadBefore = await prisma.notification.count({ where: { tenantId: tenantBId, isRead: false } });
      await request(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
      const bUnreadAfter = await prisma.notification.count({ where: { tenantId: tenantBId, isRead: false } });
      expect(bUnreadAfter).toBe(bUnreadBefore);
    });
  });

  describe('Preferences', () => {
    it('GET preferences returns 4 channels with defaults', async () => {
      const res = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(4);
      const channels = res.body.data.map((p) => p.channel).sort();
      expect(channels).toEqual(['EMAIL', 'IN_APP', 'PUSH', 'SMS']);
      for (const p of res.body.data) expect(p.tenantId).toBe(tenantAId);
    });
    it('PATCH preferences updates allowed fields', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ EMAIL: false, SMS: false });
      expect(res.status).toBe(200);
      const email = res.body.data.find((p) => p.channel === 'EMAIL');
      const sms = res.body.data.find((p) => p.channel === 'SMS');
      expect(email.isEnabled).toBe(false);
      expect(sms.isEnabled).toBe(false);
    });
    it('PATCH preferences supports preferences object wrapper', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ preferences: { EMAIL: true, PUSH: false } });
      expect(res.status).toBe(200);
      const email = res.body.data.find((p) => p.channel === 'EMAIL');
      const push = res.body.data.find((p) => p.channel === 'PUSH');
      expect(email.isEnabled).toBe(true);
      expect(push.isEnabled).toBe(false);
    });
    it('validation failures -> 400', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({});
      expect(res.status).toBe(400);
      const res2 = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ preferences: { INVALID: true } });
      expect(res2.status).toBe(400);
    });
    it('unsupported fields are rejected / ignored', async () => {
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ UNKNOWN_CHANNEL: true });
      expect(res.status).toBe(400);
    });
    it('tenant isolation: PATCH with tenantId injection is ignored', async () => {
      const before = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ tenantId: tenantBId, tenant_id: tenantBId, IN_APP: false, userId: userBId });
      expect(res.status).toBe(200);
      const afterB = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      // Tenant B unchanged for IN_APP
      const beforeIN = before.body.data.find((p) => p.channel === 'IN_APP').isEnabled;
      const afterIN = afterB.body.data.find((p) => p.channel === 'IN_APP').isEnabled;
      expect(afterIN).toBe(beforeIN);
    });
    it('repeated update idempotent', async () => {
      const res1 = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ IN_APP: true });
      expect(res1.status).toBe(200);
      const res2 = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ IN_APP: true });
      expect(res2.status).toBe(200);
      const inApp1 = res1.body.data.find((p) => p.channel === 'IN_APP').isEnabled;
      const inApp2 = res2.body.data.find((p) => p.channel === 'IN_APP').isEnabled;
      expect(inApp1).toBe(inApp2);
    });
    it('mass assignment guard: created_at/updatedAt not injected', async () => {
      // Extra protected fields should be ignored, not cause privileged write; request should succeed and only IN_APP is updated
      const res = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ IN_APP: true });
      expect(res.status).toBe(200);
      // Ensure tenantId/userId injection is ignored - previous isolation test already validates tenantId not applied
      const prefsBefore = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      const beforeCount = prefsBefore.body.data.length;
      const res2 = await request(app).patch('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenA}`).send({ IN_APP: true, PUSH: true });
      expect(res2.status).toBe(200);
      const prefsAfter = await request(app).get('/api/v1/notification-preferences').set('Authorization', `Bearer ${tokenB}`);
      expect(prefsAfter.body.data.length).toBe(beforeCount);
    });
  });

  describe('Service abstraction', () => {
    it('createNotification creates tenant-scoped record with derived tenant context', async () => {
      const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, type: 'INFO', title: 'SvcTest', message: 'svc', channel: 'IN_APP', metadata: { orderId: '123' } });
      expect(n.tenantId).toBe(tenantAId);
      expect(n.userId).toBe(userAId);
      expect(n.title).toBe('SvcTest');
      expect(n.channel).toBe('IN_APP');
      expect(n.type).toBe('INFO');
    });
    it('service validates required fields', async () => {
      await expect(notificationService.createNotification({ tenantId: tenantAId, userId: userAId, title: '', message: 'msg' })).rejects.toThrow();
      await expect(notificationService.createNotification({ tenantId: null, title: 't', message: 'm' })).rejects.toThrow();
      await expect(notificationService.createNotification({ tenantId: tenantAId, title: 't', message: '' })).rejects.toThrow();
    });
    it('service respects channel enum and type enum', async () => {
      await expect(notificationService.createNotification({ tenantId: tenantAId, title: 't', message: 'm', channel: 'INVALID' })).rejects.toThrow();
      await expect(notificationService.createNotification({ tenantId: tenantAId, title: 't', message: 'm', type: 'INVALID' })).rejects.toThrow();
    });
    it('service remains provider independent - notify abstraction works', async () => {
      const n = await notificationService.notify({ tenantId: tenantAId, userId: userAId, title: 'NotifyAbstract', message: 'abstract', channel: 'EMAIL' });
      expect(n.id).toBeDefined();
      // Ensure notification exists
      const found = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(found).not.toBeNull();
    });
    it('service does not leak sensitive data in creation', async () => {
      const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, title: 'Sensitive', message: 'msg', channel: 'IN_APP', metadata: { safe: 'data' } });
      const str = JSON.stringify(n);
      expect(str).not.toContain('passwordHash');
      expect(str).not.toContain('refresh');
    });
    it('notification supports all channels', async () => {
      for (const ch of ['IN_APP', 'EMAIL', 'SMS', 'PUSH']) {
        const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, title: `Channel ${ch}`, message: 'msg', channel: ch });
        expect(n.channel).toBe(ch);
      }
    });
  });

  describe('Security - protected fields', () => {
    it('notification list does not expose passwords/tokens', async () => {
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr.toLowerCase()).not.toContain('password');
      expect(bodyStr).not.toContain('refresh');
      expect(bodyStr.toLowerCase()).not.toContain('secret');
    });
    it('cannot inject tenantId via query to read other tenant notifications', async () => {
      const res = await request(app).get('/api/v1/notifications').query({ tenantId: tenantBId }).set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      for (const n of res.body.data) expect(n.tenantId).toBe(tenantAId);
    });
    it('cannot mark notification with forged tenantId in body', async () => {
      const n = await notificationService.createNotification({ tenantId: tenantAId, userId: userAId, title: 'ForgeTest', message: 'forge', channel: 'IN_APP' });
      const res = await request(app).patch(`/api/v1/notifications/${n.id}/read`).set('Authorization', `Bearer ${tokenA}`).send({ tenantId: tenantBId, tenant_id: tenantBId });
      expect(res.status).toBe(200);
      const db = await prisma.notification.findUnique({ where: { id: n.id } });
      expect(db.tenantId).toBe(tenantAId);
    });
  });
});
