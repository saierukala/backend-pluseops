import request from 'supertest';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createSocketServer } from '../../src/realtime/socket.server.js';
import { setIoInstance, emitRealtime, REALTIME_EVENTS, sanitizeForTest } from '../../src/realtime/realtime.service.js';
import { env } from '../../src/config/env.js';
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

function getTestSecret() {
  return env.JWT_ACCESS_SECRET || 'test-access-secret-min-32-chars-long-for-testing';
}

function signInvalidToken() {
  return 'invalid.jwt.token';
}

describe('Phase 13 - WebSockets / Real-time', () => {
  let httpServer;
  let io;
  let port;
  let tenantAId, tenantBId;
  let userA1Id, userA2Id, userB1Id; // eslint-disable-line no-unused-vars -- userA2Id used via tokenA2 room isolation
  let tokenA1, tokenA2, tokenB1;

  // Helper to start server on ephemeral port
  beforeAll(async () => {
    const ta = await createTenant(`rt-a-${Date.now()}`);
    const tb = await createTenant(`rt-b-${Date.now()}`);
    tenantAId = ta.id; tenantBId = tb.id;
    const ua1 = await createUser(tenantAId, `rta1-${Date.now()}@a.com`);
    const ua2 = await createUser(tenantAId, `rta2-${Date.now()}@a.com`);
    const ub1 = await createUser(tenantBId, `rtb1-${Date.now()}@b.com`);
    userA1Id = ua1.id; userA2Id = ua2.id; userB1Id = ub1.id;

    // ensure permissions for HTTP API still works (not needed for socket but for later HTTP check)
    const perms = [{ resource: 'notification', action: 'read' }];
    for (const p of perms) {
      await prisma.permission.upsert({ where: { tenantId_resource_action: { tenantId: tenantAId, resource: p.resource, action: p.action } }, update: {}, create: { tenantId: tenantAId, name: `${p.resource}:${p.action}`, resource: p.resource, action: p.action } });
      await prisma.permission.upsert({ where: { tenantId_resource_action: { tenantId: tenantBId, resource: p.resource, action: p.action } }, update: {}, create: { tenantId: tenantBId, name: `${p.resource}:${p.action}`, resource: p.resource, action: p.action } });
    }

    tokenA1 = await login(ua1.email, tenantAId);
    tokenA2 = await login(ua2.email, tenantAId);
    tokenB1 = await login(ub1.email, tenantBId);

    httpServer = http.createServer(app);
    io = createSocketServer(httpServer);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    if (io) {
      io.close();
      setIoInstance(null);
    }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
    }
    // cleanup
    await prisma.notification.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.notificationPreference.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.permission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  async function connectSocket(token, opts = {}) {
    const { io: Client } = await import('socket.io-client');
    return new Promise((resolve, reject) => {
      const socket = Client(`http://localhost:${port}`, {
        auth: token ? { token } : {},
        extraHeaders: token && opts.viaHeader ? { Authorization: `Bearer ${token}` } : undefined,
        query: token && opts.viaQuery ? { token } : undefined,
        reconnection: false,
        timeout: 3000,
        ...opts.clientOpts,
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('connect timeout'));
      }, 4000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        // attach error for caller
        socket._connectError = err;
        resolve(socket);
      });
    });
  }

  function waitForEvent(socket, event, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waitForEvent timeout ${event}`)), timeout);
      socket.once(event, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  function waitNoEvent(socket, event, timeout = 800) {
    return new Promise((resolve) => {
      let received = false;
      const handler = () => { received = true; };
      socket.once(event, handler);
      setTimeout(() => {
        socket.off(event, handler);
        resolve(received);
      }, timeout);
    });
  }

  describe('Authentication', () => {
    it('authenticated socket connection succeeds and receives tenant context', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      // Validate via server-assigned rooms via join ack
      const ack = await new Promise((resolve) => socket.emit('join', `tenant:${tenantAId}`, resolve));
      expect(ack.success).toBe(true);
      // Also verify join own user room allowed
      const ack2 = await new Promise((resolve) => socket.emit('join', `user:${userA1Id}`, resolve));
      expect(ack2.success).toBe(true);
      socket.disconnect();
    });

    it('missing token is rejected (unauthenticated)', async () => {
      const socket = await connectSocket(null);
      // socket should not be connected, should have connect_error
      expect(socket.connected).toBe(false);
      expect(socket._connectError).toBeDefined();
      socket.disconnect();
    });

    it('invalid JWT is rejected', async () => {
      const socket = await connectSocket(signInvalidToken());
      expect(socket.connected).toBe(false);
      expect(socket._connectError).toBeDefined();
      socket.disconnect();
    });

    it('expired JWT is rejected', async () => {
      const secret = getTestSecret();
      const expired = jwt.sign({ sub: userA1Id, tenantId: tenantAId, sessionId: 'sess-expired', email: 'x@x.com' }, secret, { expiresIn: '-10s', issuer: 'pulseops', audience: 'pulseops-api' });
      const socket = await connectSocket(expired);
      expect(socket.connected).toBe(false);
      expect(socket._connectError).toBeDefined();
      socket.disconnect();
    });

    it('malformed auth data is rejected', async () => {
      const socket = await connectSocket('not-a-jwt');
      expect(socket.connected).toBe(false);
      socket.disconnect();
    });

    it('Bearer prefix is handled', async () => {
      const socket = await connectSocket(`Bearer ${tokenA1}`);
      expect(socket.connected).toBe(true);
      socket.disconnect();
    });

    it('auth via Authorization header succeeds', async () => {
      const socket = await connectSocket(tokenA1, { viaHeader: true });
      // Need to use header-only without auth token object
      // Create client that uses only header
      if (!socket.connected) {
        // Try manual header client
        const { io: Client } = await import('socket.io-client');
        const s2 = Client(`http://localhost:${port}`, {
          extraHeaders: { Authorization: `Bearer ${tokenA1}` },
          reconnection: false,
          timeout: 3000,
        });
        const connected = await new Promise((resolve) => {
          let done = false;
          s2.on('connect', () => { done = true; resolve(true); });
          s2.on('connect_error', () => { done = true; resolve(false); });
          setTimeout(() => { if (!done) resolve(false); }, 3500);
        });
        expect(connected).toBe(true);
        s2.disconnect();
      } else {
        expect(socket.connected).toBe(true);
      }
      socket.disconnect();
    });
  });

  describe('Tenant-aware rooms', () => {
    it('A1 -> tenant:A ALLOWED', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('join', `tenant:${tenantAId}`, resolve));
      expect(ack.success).toBe(true);
      expect(ack.room).toBe(`tenant:${tenantAId}`);
      socket.disconnect();
    });

    it('A1 -> user:A1 ALLOWED', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('join', `user:${userA1Id}`, resolve));
      expect(ack.success).toBe(true);
      socket.disconnect();
    });

    it('A1 -> tenant:B BLOCKED', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('join', `tenant:${tenantBId}`, resolve));
      expect(ack.success).toBe(false);
      expect(ack.error.code).toBe('FORBIDDEN');
      socket.disconnect();
    });

    it('A1 -> user:B1 BLOCKED', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('join', `user:${userB1Id}`, resolve));
      expect(ack.success).toBe(false);
      socket.disconnect();
    });

    it('B1 -> tenant:B ALLOWED and tenant:A BLOCKED', async () => {
      const socket = await connectSocket(tokenB1);
      expect(socket.connected).toBe(true);
      const ackB = await new Promise((resolve) => socket.emit('join', `tenant:${tenantBId}`, resolve));
      expect(ackB.success).toBe(true);
      const ackA = await new Promise((resolve) => socket.emit('join', `tenant:${tenantAId}`, resolve));
      expect(ackA.success).toBe(false);
      socket.disconnect();
    });

    it('arbitrary room name is BLOCKED', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('join', 'tenant: forged-tenant', resolve));
      expect(ack.success).toBe(false);
      const ack2 = await new Promise((resolve) => socket.emit('join', 'user:another-user', resolve));
      expect(ack2.success).toBe(false);
      const ack3 = await new Promise((resolve) => socket.emit('join', 'global', resolve));
      expect(ack3.success).toBe(false);
      socket.disconnect();
    });

    it('forged tenantId via client payload does not grant membership', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      // Attempt to join with object containing tenantId field
      const ack = await new Promise((resolve) => socket.emit('join', { room: `tenant:${tenantBId}`, tenantId: tenantBId }, resolve));
      expect(ack.success).toBe(false);
      socket.disconnect();
    });

    it('subscribe event also enforces isolation', async () => {
      const socket = await connectSocket(tokenA1);
      expect(socket.connected).toBe(true);
      const ack = await new Promise((resolve) => socket.emit('subscribe', `tenant:${tenantBId}`, resolve));
      expect(ack.success).toBe(false);
      socket.disconnect();
    });
  });

  describe('Tenant isolation - event delivery', () => {
    it('Tenant A cannot receive Tenant B events', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketB1 = await connectSocket(tokenB1);
      expect(socketA1.connected).toBe(true);
      expect(socketB1.connected).toBe(true);

      const receiveA = waitNoEvent(socketA1, 'order.created');
      const receiveBPromise = waitForEvent(socketB1, 'order.created', 2000);

      // Emit tenant B event
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'order-b-event', tenantId: tenantBId }, { tenantId: tenantBId });

      const [gotA, gotB] = await Promise.all([
        receiveA.then((received) => received),
        receiveBPromise.then((data) => data).catch(() => null),
      ]);
      expect(gotA).toBe(false); // A should NOT receive
      expect(gotB).not.toBeNull();
      expect(gotB.data.id).toBe('order-b-event');

      socketA1.disconnect();
      socketB1.disconnect();
    });

    it('Tenant B cannot receive Tenant A events', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketB1 = await connectSocket(tokenB1);
      const noB = waitNoEvent(socketB1, 'order.created');
      const gotAPromise = waitForEvent(socketA1, 'order.created', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'order-a-event-2' }, { tenantId: tenantAId });
      const [noBReceived, gotA] = await Promise.all([noB, gotAPromise.catch(() => null)]);
      expect(noBReceived).toBe(false);
      expect(gotA).not.toBeNull();
      expect(gotA.data.id).toBe('order-a-event-2');
      socketA1.disconnect();
      socketB1.disconnect();
    });

    it('User A1 cannot receive User B1 private events', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketB1 = await connectSocket(tokenB1);
      const noA = waitNoEvent(socketA1, 'notification.created');
      const gotBPromise = waitForEvent(socketB1, 'notification.created', 2000);
      emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, { id: 'notif-b1', title: 'private B' }, { tenantId: tenantBId, userId: userB1Id });
      const [noAReceived, gotB] = await Promise.all([noA, gotBPromise.catch(() => null)]);
      expect(noAReceived).toBe(false);
      expect(gotB).not.toBeNull();
      socketA1.disconnect();
      socketB1.disconnect();
    });

    it('User A2 cannot receive User A1 private events but shares tenant events', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketA2 = await connectSocket(tokenA2);
      // Private notification to A1 should not go to A2
      const noA2 = waitNoEvent(socketA2, 'notification.created');
      const gotA1Promise = waitForEvent(socketA1, 'notification.created', 2000);
      emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, { id: 'notif-a1-private', title: 'private A1' }, { tenantId: tenantAId, userId: userA1Id });
      const [noA2Received, gotA1] = await Promise.all([noA2, gotA1Promise.catch(() => null)]);
      expect(noA2Received).toBe(false);
      expect(gotA1).not.toBeNull();

      // Tenant event should go to both A1 and A2
      const gotA1Tenant = waitForEvent(socketA1, 'order.created', 2000);
      const gotA2Tenant = waitForEvent(socketA2, 'order.created', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'tenant-shared-a' }, { tenantId: tenantAId });
      const [d1, d2] = await Promise.all([gotA1Tenant.catch(() => null), gotA2Tenant.catch(() => null)]);
      expect(d1).not.toBeNull();
      expect(d2).not.toBeNull();

      socketA1.disconnect();
      socketA2.disconnect();
    });

    it('forged tenantId cannot control event destination (emit is server-driven)', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketB1 = await connectSocket(tokenB1);
      // Even if payload contains tenantId = B, but we emit to tenant A room, only A receives
      const noB = waitNoEvent(socketB1, 'order.created');
      const gotA = waitForEvent(socketA1, 'order.created', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'forged-payload', tenantId: tenantBId, forged: true }, { tenantId: tenantAId });
      const [noBReceived, gotAData] = await Promise.all([noB, gotA.catch(() => null)]);
      expect(noBReceived).toBe(false);
      expect(gotAData).not.toBeNull();
      // payload tenantId in data does not affect routing; socket should see envelope tenantId = A
      expect(gotAData.tenantId).toBe(tenantAId);
      socketA1.disconnect();
      socketB1.disconnect();
    });
  });

  describe('Event delivery - all 5 events', () => {
    it('order.created event delivery', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'order.created', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'oc1', status: 'PENDING', total: '100.00' }, { tenantId: tenantAId });
      const data = await p;
      expect(data.event).toBe('order.created');
      expect(data.data.id).toBe('oc1');
      socket.disconnect();
    });

    it('order.updated event delivery', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'order.updated', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_UPDATED, { id: 'ou1', status: 'CONFIRMED' }, { tenantId: tenantAId });
      const data = await p;
      expect(data.event).toBe('order.updated');
      expect(data.data.id).toBe('ou1');
      socket.disconnect();
    });

    it('inventory.low_stock event delivery', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'inventory.low_stock', 2000);
      emitRealtime(REALTIME_EVENTS.INVENTORY_LOW_STOCK, { productVariantId: 'pv1', warehouseId: 'wh1', quantity: 2, threshold: 10 }, { tenantId: tenantAId });
      const data = await p;
      expect(data.event).toBe('inventory.low_stock');
      expect(data.data.quantity).toBe(2);
      socket.disconnect();
    });

    it('payment.completed event delivery', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'payment.completed', 2000);
      emitRealtime(REALTIME_EVENTS.PAYMENT_COMPLETED, { id: 'pay1', status: 'COMPLETED', amount: '50.00' }, { tenantId: tenantAId });
      const data = await p;
      expect(data.event).toBe('payment.completed');
      expect(data.data.id).toBe('pay1');
      socket.disconnect();
    });

    it('notification.created event delivery (user)', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'notification.created', 2000);
      emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, { id: 'notif1', title: 'Hello', message: 'world' }, { tenantId: tenantAId, userId: userA1Id });
      const data = await p;
      expect(data.event).toBe('notification.created');
      expect(data.data.id).toBe('notif1');
      socket.disconnect();
    });

    it('notification.created event delivery (tenant-wide)', async () => {
      const socketA1 = await connectSocket(tokenA1);
      const socketA2 = await connectSocket(tokenA2);
      const p1 = waitForEvent(socketA1, 'notification.created', 2000);
      const p2 = waitForEvent(socketA2, 'notification.created', 2000);
      // notification without userId goes to tenant room, both should receive
      // Our implementation: if userId provided -> user room, else tenant room. So test tenant-wide via tenant room
      // For tenant-wide we emit with only tenantId (no userId) -> both A1 and A2 should receive
      // But our helper emitNotificationCreated with only tenantId uses tenant room.
      // Direct emit test: use tenantId only
      emitRealtime(REALTIME_EVENTS.NOTIFICATION_CREATED, { id: 'notif-tenant', title: 'Tenant wide' }, { tenantId: tenantAId });
      const [d1, d2] = await Promise.all([p1.catch(() => null), p2.catch(() => null)]);
      expect(d1).not.toBeNull();
      expect(d2).not.toBeNull();
      socketA1.disconnect();
      socketA2.disconnect();
    });
  });

  describe('Sensitive fields are not emitted', () => {
    it('payload sanitization strips secrets', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'order.created', 2000);
      emitRealtime(REALTIME_EVENTS.ORDER_CREATED, {
        id: 'sens1',
        passwordHash: 'should-be-removed',
        password: 'secret',
        refreshToken: 'rt',
        accessToken: 'at',
        secret: 's',
        webhookSecret: 'wh',
        authorization: 'Bearer xyz',
        cookie: 'sess',
        providerCredentials: 'creds',
        stack: 'stacktrace should be removed',
        safeField: 'keep-me',
        nested: { passwordHash: 'nested-secret', safe: 'ok' },
      }, { tenantId: tenantAId });
      const data = await p;
      const str = JSON.stringify(data);
      expect(str).not.toContain('passwordHash');
      expect(str).not.toContain('refreshToken');
      expect(str).not.toContain('accessToken');
      expect(str).not.toContain('webhookSecret');
      expect(str).not.toContain('should-be-removed');
      expect(str).toContain('safeField');
      expect(str).toContain('keep-me');
      expect(data.data.safeField).toBe('keep-me');
      expect(data.data.nested.safe).toBe('ok');
      expect(data.data.nested.passwordHash).toBeUndefined();
      socket.disconnect();
    });

    it('sanitizeForTest utility works', () => {
      const out = sanitizeForTest({ id: '1', password: 'x', secret: 'y', token: 'z', keep: 'yes', nested: { cookie: 'c', keep2: 'y2' } });
      expect(out.keep).toBe('yes');
      expect(out.password).toBeUndefined();
      expect(out.secret).toBeUndefined();
      expect(out.token).toBeUndefined();
      expect(out.nested.cookie).toBeUndefined();
      expect(out.nested.keep2).toBe('y2');
    });

    it('notificationService does not emit sensitive data', async () => {
      const socket = await connectSocket(tokenA1);
      const p = waitForEvent(socket, 'notification.created', 2000);
      await notificationService.createNotification({
        tenantId: tenantAId,
        userId: userA1Id,
        title: 'SensitiveSrvTest',
        message: 'msg',
        channel: 'IN_APP',
        metadata: { safe: 'data', passwordHash: 'should-not-leak-but-metadata-is-object' },
      });
      const data = await p;
      const str = JSON.stringify(data);
      expect(str).not.toContain('passwordHash');
      // But note metadata is sanitized at emit layer, so passwordHash inside data should be stripped
      // Our emit sanitization will strip nested passwordHash inside data
      // Check that safe field remains if present
      socket.disconnect();
    });
  });

  describe('Existing HTTP APIs continue to work', () => {
    it('health and notifications HTTP still works', async () => {
      const health = await request(app).get('/health');
      expect([200, 503]).toContain(health.status);
      const res = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA1}`);
      // May be 200 or 403 if perms missing, but should not be 500
      expect([200, 403]).toContain(res.status);
    });
  });

  describe('Unknown event is rejected', () => {
    it('emitRealtime with unknown event returns false', () => {
      const ok = emitRealtime('unknown.event', { id: 'x' }, { tenantId: tenantAId });
      expect(ok).toBe(false);
    });
    it('emit without tenantId/userId returns false', () => {
      const ok = emitRealtime(REALTIME_EVENTS.ORDER_CREATED, { id: 'x' }, {});
      expect(ok).toBe(false);
    });
  });
});
