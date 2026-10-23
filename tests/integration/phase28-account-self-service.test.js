import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase28#Pass123';
const NEW_PASSWORD = 'Phase28#Changed456';

let platformAdmin;
let tenantId;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function login(email, password = PASSWORD, userAgent = 'jest-agent') {
  const res = await request(app).post('/api/v1/auth/login').set('User-Agent', userAgent).send({ email, password });
  return res.body.data;
}

async function newUser(label) {
  const email = `p28-${label}-${RUN}@test.local`;
  await request(app).post('/api/v1/auth/register').send({ email, password: PASSWORD, firstName: 'Pat', lastName: label, tenantId });
  return email;
}

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p28_${RUN}` });
  const created = await request(app)
    .post('/api/v1/platform/tenants')
    .set(bearer(platformAdmin.token))
    .send({ name: 'Phase 28', slug: `phase28-${RUN}`, status: 'ACTIVE', admin: { email: `p28-admin-${RUN}@test.local`, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' } });
  tenantId = created.body.data.tenant.id;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 28 — sessions', () => {
  let email;
  let laptop;
  let phone;

  beforeAll(async () => {
    email = await newUser('sessions');
    laptop = await login(email, PASSWORD, 'Laptop/1.0');
    phone = await login(email, PASSWORD, 'Phone/2.0');
  });

  it('lists each login as a session and marks the current one', async () => {
    const res = await request(app).get('/api/v1/auth/sessions').set(bearer(laptop.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id).sort()).toEqual([laptop.sessionId, phone.sessionId].sort());
    const current = res.body.data.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: laptop.sessionId, userAgent: 'Laptop/1.0' });
    expect(res.body.data.find((s) => s.id === phone.sessionId).userAgent).toBe('Phone/2.0');
  });

  it('keeps the same session across refresh-token rotation', async () => {
    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: phone.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.sessionId).toBe(phone.sessionId);
    phone = { ...phone, ...refreshed.body.data };

    const list = await request(app).get('/api/v1/auth/sessions').set(bearer(laptop.accessToken));
    expect(list.body.data).toHaveLength(2);
  });

  it('revoking a session cuts off its access and refresh tokens immediately', async () => {
    const revoke = await request(app).delete(`/api/v1/auth/sessions/${phone.sessionId}`).set(bearer(laptop.accessToken));
    expect(revoke.status).toBe(200);

    const access = await request(app).get('/api/v1/auth/me').set(bearer(phone.accessToken));
    expect(access.status).toBe(401);
    expect(access.body.error.code).toBe('SESSION_REVOKED');
    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: phone.refreshToken });
    expect(refresh.status).toBe(401);

    expect((await request(app).get('/api/v1/auth/me').set(bearer(laptop.accessToken))).status).toBe(200);
  });

  it('404s for unknown sessions and other users\' sessions', async () => {
    const other = await login(await newUser('other'));
    const unknown = await request(app).delete('/api/v1/auth/sessions/00000000-0000-4000-8000-000000000000').set(bearer(laptop.accessToken));
    const foreign = await request(app).delete(`/api/v1/auth/sessions/${other.sessionId}`).set(bearer(laptop.accessToken));

    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('SESSION_NOT_FOUND');
    expect(foreign.status).toBe(404);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(other.accessToken))).status).toBe(200);
  });

  it('logout ends the session for the access token too', async () => {
    const s = await login(email);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: s.refreshToken });

    const res = await request(app).get('/api/v1/auth/me').set(bearer(s.accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('logout-all signs out every session', async () => {
    const a = await login(email);
    const b = await login(email);
    const res = await request(app).post('/api/v1/auth/logout-all').set(bearer(a.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.sessionsRevoked).toBeGreaterThanOrEqual(2);
    for (const s of [a, b, laptop]) {
      expect((await request(app).get('/api/v1/auth/me').set(bearer(s.accessToken))).status).toBe(401);
    }
  });

  it('rejects tokens whose session id is not a real session', async () => {
    const res = await request(app).get('/api/v1/auth/sessions').set(bearer('not.a.token'));
    expect(res.status).toBe(401);
  });
});

describe('Phase 28 — change password', () => {
  let email;
  let current;
  let other;

  beforeAll(async () => {
    email = await newUser('pw');
    current = await login(email);
    other = await login(email);
  });

  it('rejects a wrong current password with 400 (not 401)', async () => {
    const res = await request(app).post('/api/v1/auth/change-password').set(bearer(current.accessToken))
      .send({ currentPassword: 'Wrong#Pass999', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('rejects a weak or unchanged new password', async () => {
    const weak = await request(app).post('/api/v1/auth/change-password').set(bearer(current.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'weak' });
    const same = await request(app).post('/api/v1/auth/change-password').set(bearer(current.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD });

    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
  });

  it('changes the password, keeps this session and signs out the others', async () => {
    const res = await request(app).post('/api/v1/auth/change-password').set(bearer(current.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(current.accessToken))).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(other.accessToken))).status).toBe(401);

    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const newLogin = await request(app).post('/api/v1/auth/login').send({ email, password: NEW_PASSWORD });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('works for platform administrators too', async () => {
    const res = await request(app).post('/api/v1/auth/change-password').set(bearer(platformAdmin.token))
      .send({ currentPassword: 'PlatformTest#Pass123', newPassword: 'PlatformTest#Pass456' });
    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe('Phase 28 — profile and email verification', () => {
  let email;
  let session;

  beforeAll(async () => {
    email = await newUser('profile');
    session = await login(email);
  });

  it('PATCH /auth/me updates the display name and returns the full profile', async () => {
    const res = await request(app).patch('/api/v1/auth/me').set(bearer(session.accessToken)).send({ firstName: 'Patricia', lastName: '  Smith  ' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ firstName: 'Patricia', lastName: 'Smith', email });
    expect(Array.isArray(res.body.data.permissions)).toBe(true);
  });

  it('PATCH /auth/me rejects other fields and empty bodies', async () => {
    const emailChange = await request(app).patch('/api/v1/auth/me').set(bearer(session.accessToken)).send({ email: 'evil@test.local' });
    const empty = await request(app).patch('/api/v1/auth/me').set(bearer(session.accessToken)).send({});

    expect(emailChange.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it('resend-verification issues a fresh token and invalidates older ones', async () => {
    const first = await request(app).post('/api/v1/auth/resend-verification').set(bearer(session.accessToken));
    const second = await request(app).post('/api/v1/auth/resend-verification').set(bearer(session.accessToken));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const stale = await request(app).post('/api/v1/auth/verify-email').send({ token: first.body.data.devToken });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('VERIFICATION_TOKEN_USED');

    const verified = await request(app).post('/api/v1/auth/verify-email').send({ token: second.body.data.devToken });
    expect(verified.status).toBe(200);
  });

  it('resend-verification refuses once the email is verified', async () => {
    const res = await request(app).post('/api/v1/auth/resend-verification').set(bearer(session.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_VERIFIED');
  });
});
