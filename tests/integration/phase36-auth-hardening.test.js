import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app/app.js';
import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';
import { createPlatformAdmin } from '../helpers/platform-admin.js';
import { createAccessTokenKeys, thumbprint } from '../../src/modules/auth/jwt.util.js';

const app = createApp();
const prisma = getPrismaClient();
const RUN = Date.now().toString(36);
const PASSWORD = 'Phase36#Auth123';
const COOKIE_MODE = { 'X-Refresh-Token-Transport': 'cookie' };

let platformAdmin;
let tenant;

const rsa = (bits = 2048) => crypto.generateKeyPairSync('rsa', {
  modulusLength: bits, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const cookieFrom = (res, name) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
const cookieValue = (setCookie) => setCookie?.split(';')[0];

beforeAll(async () => {
  platformAdmin = await createPlatformAdmin(app, prisma, { suffix: `p36auth_${RUN}` });
  const slug = `phase36auth-${RUN}`;
  const email = `p36auth-${RUN}@test.local`;
  const res = await request(app).post('/api/v1/platform/tenants').set('Authorization', `Bearer ${platformAdmin.token}`)
    .send({ name: 'Phase 36 auth', slug, status: 'ACTIVE', admin: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Auth' } });
  tenant = { id: res.body.data.tenant.id, slug, email };
});

afterAll(async () => {
  if (tenant?.id) await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  await platformAdmin?.cleanup();
  await disconnectDatabase();
});

describe('Phase 36 — RS256 and key rotation', () => {
  const oldPair = rsa();
  const newPair = rsa();
  const payload = { sub: 'u1', tenantId: 't1', sessionId: 's1', scope: 'tenant' };

  it('signs RS256 with a thumbprint kid and verifies with the public key', () => {
    const keys = createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: newPair.privateKey });
    const token = keys.sign(payload, '5m');
    const { header } = jwt.decode(token, { complete: true });
    expect(header).toMatchObject({ alg: 'RS256', kid: thumbprint(crypto.createPublicKey(newPair.publicKey)) });
    expect(keys.verify(token)).toMatchObject(payload);
    expect(jwt.verify(token, newPair.publicKey, { algorithms: ['RS256'] }).sub).toBe('u1');
  });

  it('accepts tokens of the previous key during rotation, and not after it is removed', () => {
    const oldToken = createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: oldPair.privateKey }).sign(payload, '5m');
    const rotating = createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: newPair.privateKey, previousPublicKeysPem: oldPair.publicKey });
    expect(rotating.verify(oldToken).sub).toBe('u1');
    expect(rotating.jwks().keys.map((k) => k.kid)).toEqual([rotating.kid, thumbprint(crypto.createPublicKey(oldPair.publicKey))]);
    expect(rotating.jwks().keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    expect(JSON.stringify(rotating.jwks())).not.toMatch(/"d"|"p"|"q"/);
    const done = createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: newPair.privateKey });
    expect(() => done.verify(oldToken)).toThrow(jwt.JsonWebTokenError);
  });

  it('refuses algorithm confusion: HS256 signed with the public key, alg none, HS256 secrets', () => {
    const keys = createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: newPair.privateKey });
    const forged = jwt.sign(payload, newPair.publicKey, { algorithm: 'HS256', issuer: 'pulseops', audience: 'pulseops-api', header: { kid: keys.kid } });
    expect(() => keys.verify(forged)).toThrow(jwt.JsonWebTokenError);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: keys.kid })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...payload, iss: 'pulseops', aud: 'pulseops-api' })).toString('base64url')}.`;
    expect(() => keys.verify(none)).toThrow(jwt.JsonWebTokenError);
    const hs = createAccessTokenKeys({ algorithm: 'HS256', secret: 'x'.repeat(40) }).sign(payload, '5m');
    expect(() => keys.verify(hs)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects small keys and a missing private key; PEMs with escaped newlines work', () => {
    expect(() => createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: rsa(1024).privateKey })).toThrow(/2048/);
    expect(() => createAccessTokenKeys({ algorithm: 'RS256' })).toThrow(/JWT_PRIVATE_KEY/);
    const escaped = newPair.privateKey.replace(/\n/g, '\\n');
    expect(createAccessTokenKeys({ algorithm: 'RS256', privateKeyPem: escaped }).kid).toBe(thumbprint(crypto.createPublicKey(newPair.publicKey)));
  });

  it('wires up from the environment: RS256 tokens and a JWKS endpoint (separate process)', () => {
    const script = `
      const { signAccessToken, verifyAccessToken } = await import('./src/modules/auth/jwt.util.js');
      const { createApp } = await import('./src/app/app.js');
      const { default: request } = await import('supertest');
      const token = signAccessToken({ sub: 'u1', sessionId: 's1', tenantId: 't1' });
      const jwks = (await request(createApp()).get('/.well-known/jwks.json')).body;
      console.log(JSON.stringify({ alg: JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).alg, ok: verifyAccessToken(token).sub, keys: jwks.keys.length }));
      process.exit(0);`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, JWT_ALGORITHM: 'RS256', JWT_PRIVATE_KEY: newPair.privateKey.replace(/\n/g, '\\n'), JWT_PREVIOUS_PUBLIC_KEYS: oldPair.publicKey, LOG_LEVEL: 'silent' },
      stdio: 'pipe',
    }).toString().trim().split('\n').pop();
    expect(JSON.parse(out)).toEqual({ alg: 'RS256', ok: 'u1', keys: 2 });
    expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
      env: { ...process.env, JWT_ALGORITHM: 'RS256', JWT_PRIVATE_KEY: '' }, stdio: 'pipe',
    })).toThrow(/JWT_PRIVATE_KEY/);
  });

  it('publishes no keys with HS256 (the default)', async () => {
    const res = await request(app).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });
});

describe('Phase 36 — refresh token in an httpOnly cookie (staff)', () => {
  let cookie;

  it('without the header nothing changes: the refresh token is in the body, no cookie', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: tenant.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeTruthy();
    expect(cookieFrom(res, 'pulseops_refresh')).toBeUndefined();
  });

  it('login in cookie mode sets an httpOnly, SameSite=Strict cookie on the auth path and leaves it out of the body', async () => {
    const res = await request(app).post('/api/v1/auth/login').set(COOKIE_MODE).send({ email: tenant.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.body.data).toMatchObject({ refreshTokenTransport: 'cookie', accessToken: expect.any(String) });
    const set = cookieFrom(res, 'pulseops_refresh');
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/api\/v1\/auth/);
    expect(set).toMatch(/Max-Age=604800/);
    cookie = cookieValue(set);
  });

  it('refresh reads the cookie only with the header (CSRF), and rotates it', async () => {
    const noHeader = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).send({});
    expect(noHeader.status).toBe(400);
    const res = await request(app).post('/api/v1/auth/refresh').set(COOKIE_MODE).set('Cookie', cookie).send();
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    const next = cookieValue(cookieFrom(res, 'pulseops_refresh'));
    expect(next).toBeTruthy();
    expect(next).not.toBe(cookie);
    // The old cookie is spent: replaying it is refused
    expect((await request(app).post('/api/v1/auth/refresh').set(COOKIE_MODE).set('Cookie', cookie).send()).status).toBe(401);
    // Replay detection ends that session; sign in again for the logout check
    const again = await request(app).post('/api/v1/auth/login').set(COOKIE_MODE).send({ email: tenant.email, password: PASSWORD });
    cookie = cookieValue(cookieFrom(again, 'pulseops_refresh'));
  });

  it('logout revokes the cookie\'s session and clears the cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout').set(COOKIE_MODE).set('Cookie', cookie).send();
    expect(res.status).toBe(200);
    expect(cookieFrom(res, 'pulseops_refresh')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post('/api/v1/auth/refresh').set(COOKIE_MODE).set('Cookie', cookie).send()).status).toBe(401);
  });

  it('CORS lets allowed origins send the header with credentials, and nobody else', async () => {
    const ok = await request(app).options('/api/v1/auth/refresh')
      .set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,x-refresh-token-transport');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-headers'].toLowerCase()).toContain('x-refresh-token-transport');
    const evil = await request(app).options('/api/v1/auth/refresh')
      .set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'x-refresh-token-transport');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Phase 36 — refresh cookie on the storefront', () => {
  it('is scoped to the store\'s auth path and works for refresh and logout', async () => {
    const base = `/api/v1/storefront/${tenant.slug}/auth`;
    const email = `p36-shopper-${RUN}@test.local`;
    const reg = await request(app).post(`${base}/register`).send({ email, firstName: 'Sam', lastName: 'Shopper' });
    const set = await request(app).post(`${base}/set-password`).set(COOKIE_MODE).send({ token: reg.body.data.devToken, password: PASSWORD });
    expect(set.status).toBe(200);
    expect(set.body.data.refreshToken).toBeUndefined();
    const setCookie = cookieFrom(set, 'pulseops_shop_refresh');
    expect(setCookie).toMatch(new RegExp(`Path=${base.replace(/\//g, '\\/')}`));
    expect(setCookie).toMatch(/HttpOnly/i);

    const refreshed = await request(app).post(`${base}/refresh`).set(COOKIE_MODE).set('Cookie', cookieValue(setCookie)).send();
    expect(refreshed.status).toBe(200);
    const next = cookieValue(cookieFrom(refreshed, 'pulseops_shop_refresh'));
    const out = await request(app).post(`${base}/logout`).set(COOKIE_MODE).set('Cookie', next).send();
    expect(out.status).toBe(200);
    expect(cookieFrom(out, 'pulseops_shop_refresh')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post(`${base}/refresh`).set(COOKIE_MODE).set('Cookie', next).send()).status).toBe(401);

    const login = await request(app).post(`${base}/login`).set(COOKIE_MODE).send({ email, password: PASSWORD });
    expect(login.body.data).toMatchObject({ refreshTokenTransport: 'cookie' });
  });
});
