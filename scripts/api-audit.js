/**
 * PulseOps live API audit.
 *
 * Exercises every mounted route end-to-end against a RUNNING server and reports
 * PASS/FAIL per check. Expectations encode the *correct* behaviour, so a FAIL is
 * either a bug or a known gap (see docs/PROJECT_STATUS_AND_ROADMAP.md).
 *
 * Usage:
 *   AUDIT_BASE_URL=http://localhost:3100 node scripts/api-audit.js [--out report.json]
 *
 * Needs: running API (raise RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX for the run) and a
 * seeded platform admin (npm run db:seed). Everything goes through the HTTP API.
 *
 * Creates two tenants with slug prefix `audit-` per run. There is no tenant
 * delete on the platform API, so they remain in the database afterwards.
 */
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';
import { env } from '../src/config/env.js';

const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const PLATFORM_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'sairram@gmail.com';
const PLATFORM_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || 'Sairram@123';
const RUN = Date.now().toString(36);
const PASSWORD = 'Audit#Pass123';

const results = [];
let group = 'general';

async function call(method, path, { token, body, headers = {}, form, raw } = {}) {
  const url = path.startsWith('http') ? path : `${path.startsWith('/api/') || path.startsWith('/health') || path.startsWith('/ready') || path.startsWith('/metrics') || path.startsWith('/api-docs') || path.startsWith('/openapi') || path.startsWith('/storage') ? BASE : API}${path}`;
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (raw !== undefined) { payload = raw; h['Content-Type'] = 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text, headers: res.headers, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, json: null, text: String(err), headers: new Headers(), ms: Date.now() - started };
  }
}

async function check(name, method, path, expect, opts = {}) {
  const res = await call(method, path, opts);
  const expected = Array.isArray(expect) ? expect : [expect];
  const ok = expected.includes(res.status) && (!opts.assert || opts.assert(res));
  results.push({
    group, name, method, path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'),
    expected: expected.join('|'), actual: res.status, ok,
    code: res.json?.error?.code || res.json?.code || undefined,
    note: ok ? undefined : (opts.note || res.json?.error?.message || res.json?.message || res.text.slice(0, 160)),
    ms: res.ms,
  });
  return res;
}

function record(name, ok, note) {
  results.push({ group, name, method: '-', path: '-', expected: 'true', actual: ok, ok, note: ok ? undefined : note });
}

const data = (res) => res?.json?.data;

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function imageForm(extra = {}) {
  const f = new FormData();
  f.append('image', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
  for (const [k, v] of Object.entries(extra)) f.append(k, String(v));
  return f;
}

async function socketCheck(name, token, expectConnect) {
  const ok = await new Promise((resolve) => {
    const s = ioClient(BASE, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, timeout: 4000 });
    const done = (v) => { s.close(); resolve(v); };
    s.on('connected', () => done(expectConnect));
    s.on('connect_error', () => done(!expectConnect));
    setTimeout(() => done(false), 5000);
  });
  record(name, ok, expectConnect ? 'socket did not connect' : 'socket connected but should be rejected');
}

async function main() {
  // ── Public infrastructure ───────────────────────────────────────────
  group = 'health';
  await check('liveness', 'GET', '/health', 200);
  await check('postgres readiness', 'GET', '/health/db', 200);
  await check('redis readiness', 'GET', '/health/redis', 200);
  await check('bullmq health', 'GET', '/api/v1/health/bullmq', 200);
  await check('readiness', 'GET', '/ready', 200);
  await check('readiness live', 'GET', '/ready/live', 200);
  await check('metrics', 'GET', '/metrics', 200);
  await check('swagger ui', 'GET', '/api-docs/', 200);
  const spec = await check('openapi json', 'GET', '/api-docs.json', 200);
  await check('openapi alias', 'GET', '/openapi.json', 200);
  await check('openapi alias v1', 'GET', '/api/v1/openapi.json', 200);
  await check('unknown route 404', 'GET', '/api/v1/does-not-exist', 404);
  await check('private storage not static', 'GET', '/storage/tenants/x/y.png', 404);

  // ── Platform admin ───────────────────────────────────────────────────
  group = 'platform';
  await check('platform login wrong password', 'POST', '/auth/login', 401, { body: { email: PLATFORM_EMAIL, password: 'Wrong#Pass1', scope: 'platform' } });
  const pLogin = await check('platform login', 'POST', '/auth/login', 200, { body: { email: PLATFORM_EMAIL, password: PLATFORM_PASSWORD, scope: 'platform' }, assert: (r) => data(r)?.scope === 'platform' });
  const P = data(pLogin)?.accessToken;
  if (!P) throw new Error('Platform login failed — run `npm run db:seed` and check PLATFORM_ADMIN_* env');
  await check('list tenants', 'GET', '/platform/tenants?page=1&limit=5', 200, { token: P, assert: (r) => !data(r).some((t) => t.slug === '__platform') });
  await check('list tenants no token', 'GET', '/platform/tenants', 401);
  const adminA = { email: `admin-a-${RUN}@audit.test`, password: PASSWORD, firstName: 'Ada', lastName: 'Admin' };
  const tA = await check('create tenant A + admin', 'POST', '/platform/tenants', 201, { token: P, body: { name: `Audit A ${RUN}`, slug: `audit-a-${RUN}`, status: 'ACTIVE', plan: 'free', admin: adminA } });
  const tenantA = data(tA)?.tenant;
  await check('duplicate slug 409', 'POST', '/platform/tenants', 409, { token: P, body: { name: 'Dup', slug: `audit-a-${RUN}`, admin: { ...adminA, email: `x-${RUN}@audit.test` } } });
  await check('duplicate admin email 409', 'POST', '/platform/tenants', 409, { token: P, body: { name: 'Dup2', slug: `audit-dup-${RUN}`, admin: adminA } });
  await check('reserved __platform slug rejected', 'POST', '/platform/tenants', [400, 403], { token: P, body: { name: 'Bad', slug: '__platform', admin: { ...adminA, email: `y-${RUN}@audit.test` } } });
  const adminB = { email: `admin-b-${RUN}@audit.test`, password: PASSWORD, firstName: 'Bob', lastName: 'Admin' };
  const tB = await check('create tenant B + admin', 'POST', '/platform/tenants', 201, { token: P, body: { name: `Audit B ${RUN}`, slug: `audit-b-${RUN}`, admin: adminB } });
  const tenantB = data(tB)?.tenant;
  await check('get tenant', 'GET', `/platform/tenants/${tenantA.id}`, 200, { token: P });
  await check('update tenant', 'PATCH', `/platform/tenants/${tenantA.id}`, 200, { token: P, body: { plan: 'pro' } });
  await check('add second admin', 'POST', `/platform/tenants/${tenantA.id}/admin`, 201, { token: P, body: { email: `admin2-a-${RUN}@audit.test`, password: PASSWORD, firstName: 'Second', lastName: 'Admin' } });
  await check('suspend tenant B', 'PATCH', `/platform/tenants/${tenantB.id}/status`, 200, { token: P, body: { status: 'SUSPENDED' } });
  await check('suspended tenant login blocked', 'POST', '/auth/login', 403, { body: { email: adminB.email, password: PASSWORD } });
  await check('reactivate tenant B', 'PATCH', `/platform/tenants/${tenantB.id}/status`, 200, { token: P, body: { status: 'ACTIVE' } });
  await check('platform token on tenant route 403', 'GET', '/users', 403, { token: P });
  await check('platform token on /auth/me', 'GET', '/auth/me', [200, 403], { token: P });

  // ── Legacy tenant CRUD: platform admins only (Phase 26) ──────────────
  group = 'legacy-tenants';
  await check('anonymous POST /tenants rejected', 'POST', '/tenants', 401, { body: { name: 'Anon', slug: `audit-anon-${RUN}` }, note: 'anyone on the internet can create a tenant' });
  await check('anonymous GET /tenants/:id rejected', 'GET', `/tenants/${tenantA.id}`, 401, { note: 'tenant details readable without auth' });
  await check('anonymous PATCH /tenants/:id rejected', 'PATCH', `/tenants/${tenantA.id}`, 401, { body: { name: 'Hijacked' }, note: 'tenant can be renamed without auth' });
  await check('anonymous DELETE /tenants/:id rejected', 'DELETE', `/tenants/${tenantA.id}`, 401, { note: 'tenant (and all its data, cascade) can be deleted without auth' });
  const legacy = await check('platform POST /tenants', 'POST', '/tenants', 201, { token: P, body: { name: `Audit Legacy ${RUN}`, slug: `audit-legacy-${RUN}` } });
  const legacyId = data(legacy)?.id;
  await check('platform GET /tenants/:id', 'GET', `/tenants/${legacyId}`, 200, { token: P });
  await check('platform PATCH /tenants/:id', 'PATCH', `/tenants/${legacyId}`, 200, { token: P, body: { plan: 'pro' } });
  await check('platform DELETE /tenants/:id', 'DELETE', `/tenants/${legacyId}`, 200, { token: P });
  await check('deleted tenant gone', 'GET', `/tenants/${legacyId}`, 404, { token: P });

  // ── Tenant authentication ────────────────────────────────────────────
  group = 'auth';
  const aLogin = await check('tenant login (auto-resolve)', 'POST', '/auth/login', 200, { body: { email: adminA.email, password: PASSWORD }, assert: (r) => data(r)?.scope === 'tenant' && data(r)?.user?.tenantId === tenantA.id });
  let A = data(aLogin).accessToken;
  const aRefresh = data(aLogin).refreshToken;
  await check('tenant login by slug', 'POST', '/auth/login', 200, { body: { email: adminA.email, password: PASSWORD, tenantSlug: tenantA.slug } });
  await check('tenant login wrong password', 'POST', '/auth/login', 401, { body: { email: adminA.email, password: 'Wrong#Pass1' } });
  await check('tenant login unknown email', 'POST', '/auth/login', [401, 404], { body: { email: `nobody-${RUN}@audit.test`, password: PASSWORD } });
  await check('login validation error', 'POST', '/auth/login', 400, { body: { email: 'not-an-email' } });
  await check('me', 'GET', '/auth/me', 200, { token: A });
  await check('me no token', 'GET', '/auth/me', 401);
  await check('me garbage token', 'GET', '/auth/me', 401, { token: 'abc.def.ghi' });
  await check('tenant token on platform route', 'GET', '/platform/tenants', 403, { token: A });
  await check('tenant token cannot delete tenant (legacy route)', 'DELETE', `/tenants/${tenantA.id}`, 403, { token: A });
  const rf = await check('refresh', 'POST', '/auth/refresh', 200, { body: { refreshToken: aRefresh } });
  await check('refresh token reuse rejected', 'POST', '/auth/refresh', 401, { body: { refreshToken: aRefresh } });
  // Replaying a rotated token ends that whole session (Phase 28), including the access token it just issued
  await check('token reuse ends the session', 'GET', '/auth/me', 401, { token: data(rf)?.accessToken, assert: (r) => r.json?.error?.code === 'SESSION_REVOKED' });
  const aRelogin = data(await call('POST', '/auth/login', { body: { email: adminA.email, password: PASSWORD } }));
  A = aRelogin.accessToken;
  const bLogin = await check('tenant B login', 'POST', '/auth/login', 200, { body: { email: adminB.email, password: PASSWORD } });
  const B = data(bLogin).accessToken;
  const staff = { email: `staff-${RUN}@audit.test`, password: PASSWORD, firstName: 'Sam', lastName: 'Staff' };
  await check('register without tenantId', 'POST', '/auth/register', 400, { body: staff });
  const reg = await check('register into tenant A', 'POST', '/auth/register', 201, { body: { ...staff, tenantId: tenantA.id } });
  const staffId = data(reg)?.id || data(reg)?.user?.id;
  const sLogin = await check('staff login', 'POST', '/auth/login', 200, { body: { email: staff.email, password: PASSWORD } });
  const S = data(sLogin)?.accessToken;
  await check('staff without role cannot list products', 'GET', '/products', 403, { token: S });
  await check('forgot password (no enumeration)', 'POST', '/auth/forgot-password', 200, { body: { email: staff.email } });
  await check('forgot password unknown email still 200', 'POST', '/auth/forgot-password', 200, { body: { email: `ghost-${RUN}@audit.test` } });
  await check('reset password bad token', 'POST', '/auth/reset-password', [400, 401], { body: { token: 'bogus', password: PASSWORD } });
  await check('verify email bad token', 'POST', '/auth/verify-email', [400, 401], { body: { token: 'bogus' } });

  // ── Account self-service (Phase 28) — on a throwaway user, logout-all must not touch the staff session
  group = 'self-service';
  const self = { email: `self-${RUN}@audit.test`, password: PASSWORD, firstName: 'Sel', lastName: 'Fie' };
  await call('POST', '/auth/register', { body: { ...self, tenantId: tenantA.id } });
  const selfA = data(await call('POST', '/auth/login', { body: { email: self.email, password: PASSWORD }, headers: { 'User-Agent': 'audit-laptop' } }));
  const selfB = data(await call('POST', '/auth/login', { body: { email: self.email, password: PASSWORD }, headers: { 'User-Agent': 'audit-phone' } }));
  await check('list sessions', 'GET', '/auth/sessions', 200, { token: selfA.accessToken, assert: (r) => data(r).length === 2 && data(r).filter((x) => x.current).length === 1 });
  const rot = await check('refresh keeps session id', 'POST', '/auth/refresh', 200, { body: { refreshToken: selfB.refreshToken }, assert: (r) => data(r).sessionId === selfB.sessionId });
  await check('revoke other session', 'DELETE', `/auth/sessions/${selfB.sessionId}`, 200, { token: selfA.accessToken });
  await check('revoked session access token rejected', 'GET', '/auth/me', 401, { token: data(rot)?.accessToken, assert: (r) => r.json?.error?.code === 'SESSION_REVOKED' });
  await check('revoke unknown session 404', 'DELETE', '/auth/sessions/00000000-0000-4000-8000-000000000000', 404, { token: selfA.accessToken });
  await check('update own profile', 'PATCH', '/auth/me', 200, { token: selfA.accessToken, body: { firstName: 'Selma' }, assert: (r) => data(r).firstName === 'Selma' });
  await check('profile rejects email change', 'PATCH', '/auth/me', 400, { token: selfA.accessToken, body: { email: `x-${RUN}@audit.test` } });
  await check('resend verification', 'POST', '/auth/resend-verification', 200, { token: selfA.accessToken });
  await check('change password wrong current 400', 'POST', '/auth/change-password', 400, { token: selfA.accessToken, body: { currentPassword: 'Wrong#Pass999', newPassword: 'Audit#Pass456' } });
  const selfC = data(await call('POST', '/auth/login', { body: { email: self.email, password: PASSWORD } }));
  await check('change password', 'POST', '/auth/change-password', 200, { token: selfA.accessToken, body: { currentPassword: PASSWORD, newPassword: 'Audit#Pass456' } });
  await check('other sessions signed out after password change', 'GET', '/auth/me', 401, { token: selfC.accessToken });
  await check('current session survives password change', 'GET', '/auth/me', 200, { token: selfA.accessToken });
  await check('logout-all', 'POST', '/auth/logout-all', 200, { token: selfA.accessToken });
  await check('signed out everywhere', 'GET', '/auth/me', 401, { token: selfA.accessToken });
  group = 'auth';

  // ── RBAC & users ─────────────────────────────────────────────────────
  group = 'rbac';
  const perms = await check('list permissions (paginated)', 'GET', '/permissions', 200, { token: A, assert: (r) => r.json?.meta?.total === data(r)?.length });
  const permList = data(perms) || [];
  const permId = (resource, action) => permList.find((p) => p.resource === resource && p.action === action)?.id;
  const productRead = { id: permId('product', 'read') };
  if (permList[0]) await check('get permission', 'GET', `/permissions/${permList[0].id}`, 200, { token: A });
  await check('permissions page 2', 'GET', '/permissions?page=2&limit=5', 200, { token: A, assert: (r) => data(r).length === 5 && r.json.meta.page === 2 });
  await check('permissions filtered by resource', 'GET', '/permissions?resource=order', 200, { token: A, assert: (r) => data(r).length > 0 && data(r).every((p) => p.resource === 'order') });
  await check('list roles', 'GET', '/roles', 200, { token: A });
  const role = await check('create role', 'POST', '/roles', 201, { token: A, body: { name: `auditor-${RUN}`, description: 'Audit role' } });
  const roleId = data(role)?.id;
  await check('duplicate role 409', 'POST', '/roles', 409, { token: A, body: { name: `auditor-${RUN}` } });
  await check('get role', 'GET', `/roles/${roleId}`, 200, { token: A });
  await check('update role', 'PATCH', `/roles/${roleId}`, 200, { token: A, body: { description: 'Updated' } });
  await check('assign permission to role', 'POST', `/roles/${roleId}/permissions`, [200, 201], { token: A, body: { permissionIds: [productRead.id] } });
  await check('replace role permissions (PUT)', 'PUT', `/roles/${roleId}/permissions`, 200, { token: A, body: { permissionIds: [productRead.id, permId('order', 'read')] }, assert: (r) => data(r).length === 2 });
  await check('remove permission from role', 'DELETE', `/roles/${roleId}/permissions/${permId('order', 'read')}`, 200, { token: A, assert: (r) => data(r).length === 1 });
  await check('remove unassigned permission 404', 'DELETE', `/roles/${roleId}/permissions/${permId('order', 'read')}`, 404, { token: A });
  const systemRoles = data(await call('GET', '/roles', { token: A })) || [];
  const adminRole = systemRoles.find((r) => r.name === 'admin');
  await check('built-in admin role is a system role', 'GET', `/roles/${adminRole?.id}`, 200, { token: A, assert: (r) => data(r)?.isSystem === true, note: 'built-in roles must be immutable' });
  await check('system role permissions immutable', 'PUT', `/roles/${adminRole?.id}/permissions`, 403, { token: A, body: { permissionIds: [] } });
  await check('list users', 'GET', '/users?page=1&limit=10', 200, { token: A });
  await check('get user', 'GET', `/users/${staffId}`, 200, { token: A });
  await check('update user name', 'PATCH', `/users/${staffId}`, 200, { token: A, body: { firstName: 'Samuel' } });
  await check('update user passwordHash rejected', 'PATCH', `/users/${staffId}`, [400, 403], { token: A, body: { passwordHash: 'x' } });
  await check('update user tenantId rejected', 'PATCH', `/users/${staffId}`, [400, 403], { token: A, body: { tenantId: tenantB.id } });
  await check('assign role to user', 'POST', `/users/${staffId}/roles`, [200, 201], { token: A, body: { roleIds: [roleId] } });
  await check('get user roles', 'GET', `/users/${staffId}/roles`, 200, { token: A });
  await check('staff gains product:read immediately', 'GET', '/products', 200, { token: S, note: 'permission cache not invalidated when roles change' });
  await check('remove role from user', 'DELETE', `/users/${staffId}/roles/${roleId}`, 200, { token: A });
  await check('staff loses product:read immediately', 'GET', '/products', 403, { token: S, note: 'permission cache not invalidated on role removal' });
  await check('remove unassigned role 404', 'DELETE', `/users/${staffId}/roles/${roleId}`, 404, { token: A });
  const me = await check('/auth/me includes roles + permissions', 'GET', '/auth/me', 200, { token: A, assert: (r) => data(r)?.roles?.some((x) => x.name === 'admin') && data(r)?.permissions?.includes('role:update') });
  // Tenant A has two admins (platform group adds one), so test the guard on tenant B, which has exactly one
  const bAdminRole = (data(await call('GET', '/roles', { token: B })) || []).find((r) => r.name === 'admin');
  await check('last admin keeps admin role (409)', 'DELETE', `/users/${data(bLogin).user.id}/roles/${bAdminRole?.id}`, 409, { token: B });
  await check('/auth/me for user without roles', 'GET', '/auth/me', 200, { token: S, assert: (r) => data(r)?.permissions?.length === 0 && data(r)?.roles?.length === 0 });
  await check('cannot delete self', 'DELETE', `/users/${data(me)?.id}`, [400, 403], { token: A });
  await check('staff cannot list users', 'GET', '/users', 403, { token: S });

  // ── Catalog ──────────────────────────────────────────────────────────
  group = 'catalog';
  const catP = await check('create category', 'POST', '/categories', 201, { token: A, body: { name: 'Apparel', slug: `apparel-${RUN}` } });
  const catC = await check('create child category', 'POST', '/categories', 201, { token: A, body: { name: 'Shirts', slug: `shirts-${RUN}`, parentId: data(catP).id } });
  await check('duplicate category slug 409', 'POST', '/categories', 409, { token: A, body: { name: 'Apparel', slug: `apparel-${RUN}` } });
  await check('list categories', 'GET', '/categories', 200, { token: A });
  await check('category tree', 'GET', '/categories/tree', 200, { token: A });
  await check('get category', 'GET', `/categories/${data(catC).id}`, 200, { token: A });
  await check('update category', 'PATCH', `/categories/${data(catC).id}`, 200, { token: A, body: { description: 'Tops' } });
  const attr = await check('create attribute', 'POST', '/attributes', 201, { token: A, body: { name: 'Color', code: `color_${RUN}`, dataType: 'OPTION' } });
  const attrId = data(attr).id;
  await check('list attributes', 'GET', '/attributes', 200, { token: A });
  await check('get attribute', 'GET', `/attributes/${attrId}`, 200, { token: A });
  await check('update attribute', 'PATCH', `/attributes/${attrId}`, 200, { token: A, body: { description: 'Colour' } });
  const val = await check('create attribute value', 'POST', `/attributes/${attrId}/values`, 201, { token: A, body: { value: 'red', displayName: 'Red' } });
  await check('list attribute values', 'GET', `/attributes/${attrId}/values`, 200, { token: A });
  await check('get attribute value', 'GET', `/attributes/${attrId}/values/${data(val).id}`, 200, { token: A });
  await check('update attribute value', 'PATCH', `/attributes/${attrId}/values/${data(val).id}`, 200, { token: A, body: { displayName: 'Crimson' } });
  const prod = await check('create product', 'POST', '/products', 201, { token: A, body: { name: `Audit Tee ${RUN}`, brand: 'Pulse', basePrice: '19.99', status: 'ACTIVE', categories: [data(catC).id], primaryCategoryId: data(catC).id } });
  const productId = data(prod).id;
  await check('list products', 'GET', '/products?limit=5', 200, { token: A });
  await check('search products', 'GET', `/products?search=${RUN}`, 200, { token: A, assert: (r) => data(r).length >= 1 });
  await check('filter by category', 'GET', `/products?categoryId=${data(catC).id}`, 200, { token: A, assert: (r) => data(r).length >= 1 });
  await check('get product', 'GET', `/products/${productId}`, 200, { token: A });
  await check('update product', 'PATCH', `/products/${productId}`, 200, { token: A, body: { description: 'Soft cotton' } });
  await check('set product categories', 'POST', `/products/${productId}/categories`, 200, { token: A, body: { categories: [data(catC).id, data(catP).id] } });
  await check('get product categories', 'GET', `/products/${productId}/categories`, 200, { token: A });
  const sku = `TEE-${RUN}`.toUpperCase();
  const vr = await check('create variant', 'POST', `/products/${productId}/variants`, 201, { token: A, body: { sku, price: '24.50', costPrice: '9.00', status: 'ACTIVE', attributes: [{ attributeDefinitionId: attrId, value: 'red' }] } });
  const variantId = data(vr).id;
  await check('duplicate SKU 409', 'POST', `/products/${productId}/variants`, 409, { token: A, body: { sku, price: '1.00' } });
  await check('list variants', 'GET', `/products/${productId}/variants`, 200, { token: A });
  await check('get variant', 'GET', `/products/${productId}/variants/${variantId}`, 200, { token: A });
  await check('update variant', 'PATCH', `/products/${productId}/variants/${variantId}`, 200, { token: A, body: { barcode: `BC${RUN}` } });
  await check('set variant attributes', 'PUT', `/products/${productId}/variants/${variantId}/attributes`, 200, { token: A, body: { attributes: [{ attributeDefinitionId: attrId, value: 'red' }] } });
  await check('get variant attributes', 'GET', `/products/${productId}/variants/${variantId}/attributes`, 200, { token: A });
  await check('filter by sku', 'GET', `/products?sku=${sku}`, 200, { token: A, assert: (r) => data(r).length === 1 });

  group = 'images';
  const img = await check('upload product image', 'POST', `/products/${productId}/images`, 201, { token: A, form: imageForm({ altText: 'Front', isPrimary: true }) });
  const imageId = data(img)?.id;
  await check('upload non-image rejected', 'POST', `/products/${productId}/images`, [400, 415], { token: A, form: (() => { const f = new FormData(); f.append('image', new Blob(['hello'], { type: 'text/plain' }), 'a.txt'); return f; })() });
  await check('list product images', 'GET', `/products/${productId}/images`, 200, { token: A });
  if (imageId) {
    await check('get product image', 'GET', `/products/${productId}/images/${imageId}`, 200, { token: A });
    await check('update image metadata', 'PATCH', `/products/${productId}/images/${imageId}`, 200, { token: A, body: { altText: 'Front view' } });
    await check('stream image bytes', 'GET', `/products/${productId}/images/${imageId}/file`, 200, { token: A });
    await check('stream image no auth 401', 'GET', `/products/${productId}/images/${imageId}/file`, 401);
    await check('tenant B cannot stream A image', 'GET', `/products/${productId}/images/${imageId}/file`, [403, 404], { token: B });
    const signed = await check('signed url', 'GET', `/products/${productId}/images/${imageId}/signed-url`, 200, { token: A });
    const sUrl = data(signed)?.signedUrl;
    if (sUrl) {
      const abs = sUrl.startsWith('http') ? sUrl : `${BASE}${sUrl}`;
      await check('fetch via signed url (no auth)', 'GET', abs, 200);
      await check('tampered signed url 403', 'GET', abs.replace(/signature=([0-9a-f])/, (m, c) => `signature=${c === 'a' ? 'b' : 'a'}`), 403);
    } else record('signed url returns url field', false, 'no url in response');
    const key = data(img)?.storageKey;
    if (key) await check('storage/file authenticated', 'GET', `/api/v1/storage/file?key=${encodeURIComponent(key)}`, 200, { token: A });
  }
  await check('upload variant image', 'POST', `/products/${productId}/variants/${variantId}/images`, 201, { token: A, form: imageForm() });
  await check('list variant images', 'GET', `/products/${productId}/variants/${variantId}/images`, 200, { token: A });

  // ── Warehouses & inventory ───────────────────────────────────────────
  group = 'inventory';
  const w1 = await check('create warehouse 1', 'POST', '/warehouses', 201, { token: A, body: { name: 'Main', code: `MAIN-${RUN}`, city: 'Hyderabad', isDefault: true } });
  const w2 = await check('create warehouse 2', 'POST', '/warehouses', 201, { token: A, body: { name: 'Overflow', code: `OVR-${RUN}` } });
  const W1 = data(w1).id; const W2 = data(w2).id;
  await check('duplicate warehouse code 409', 'POST', '/warehouses', 409, { token: A, body: { name: 'Dup', code: `MAIN-${RUN}` } });
  await check('list warehouses', 'GET', '/warehouses', 200, { token: A });
  await check('get warehouse', 'GET', `/warehouses/${W1}`, 200, { token: A });
  await check('update warehouse', 'PATCH', `/warehouses/${W2}`, 200, { token: A, body: { city: 'Pune' } });
  await check('adjust +50', 'POST', '/inventory/adjust', [200, 201], { token: A, body: { variantId, warehouseId: W1, quantityChanged: 50, reason: 'Initial stock' } });
  await check('adjust below zero rejected', 'POST', '/inventory/adjust', [400, 409, 422], { token: A, body: { variantId, warehouseId: W1, quantityChanged: -1000, reason: 'Oops' } });
  await check('transfer 10 W1→W2', 'POST', '/inventory/transfer', [200, 201], { token: A, body: { variantId, sourceWarehouseId: W1, destinationWarehouseId: W2, quantity: 10, reason: 'Rebalance' } });
  await check('transfer same warehouse rejected', 'POST', '/inventory/transfer', [400, 409, 422], { token: A, body: { variantId, sourceWarehouseId: W1, destinationWarehouseId: W1, quantity: 1 } });
  await check('list inventory', 'GET', '/inventory', 200, { token: A });
  const vinv = await check('variant inventory', 'GET', `/inventory/variants/${variantId}`, 200, { token: A });
  await check('movements', 'GET', `/inventory/movements?variantId=${variantId}`, 200, { token: A });
  await check('low stock', 'GET', '/inventory/low-stock?threshold=100', 200, { token: A });
  const stockOf = (res, wid) => {
    const d = data(res); const rows = d?.warehouses || d?.inventory || d?.items || (Array.isArray(d) ? d : []);
    const row = rows.find((r) => (r.warehouseId || r.warehouse?.id) === wid);
    return row ? Number(row.quantity ?? row.quantityOnHand ?? row.available ?? NaN) : NaN;
  };
  record('stock after adjust+transfer is 40/10', stockOf(vinv, W1) === 40 && stockOf(vinv, W2) === 10, `W1=${stockOf(vinv, W1)} W2=${stockOf(vinv, W2)}`);

  // ── Customers & addresses ────────────────────────────────────────────
  group = 'customers';
  const shipTo = { type: 'SHIPPING', line1: '1 Main St', city: 'Hyderabad', postalCode: '500001', country: 'IN' };
  const c1 = await check('create customer with address', 'POST', '/customers', 201, { token: A, body: { email: `Buyer-${RUN}@Audit.test`, firstName: 'Bea', lastName: 'Buyer', addresses: [shipTo] } });
  const customer = data(c1);
  record('customer email normalised', customer?.email === `buyer-${RUN}@audit.test`, `email=${customer?.email}`);
  record('first address is default', customer?.addresses?.[0]?.isDefault === true, JSON.stringify(customer?.addresses?.[0]));
  await check('duplicate customer email 409', 'POST', '/customers', 409, { token: A, body: { email: `buyer-${RUN}@audit.test`, firstName: 'X', lastName: 'Y' } });
  await check('invalid customer 400', 'POST', '/customers', 400, { token: A, body: { email: 'nope', firstName: 'X', lastName: 'Y' } });
  await check('list customers (search)', 'GET', `/customers?search=buyer-${RUN}`, 200, { token: A, assert: (r) => data(r).length === 1 });
  await check('get customer', 'GET', `/customers/${customer.id}`, 200, { token: A });
  await check('update customer', 'PATCH', `/customers/${customer.id}`, 200, { token: A, body: { phone: '+91 90000 00000' } });
  const billTo = await check('add billing address', 'POST', `/customers/${customer.id}/addresses`, 201, { token: A, body: { type: 'BILLING', line1: '9 Ledger Rd', city: 'Pune', country: 'IN' } });
  const ship2 = await check('add 2nd shipping address', 'POST', `/customers/${customer.id}/addresses`, 201, { token: A, body: { ...shipTo, line1: '2 Side St' } });
  await check('update address', 'PATCH', `/customers/${customer.id}/addresses/${data(ship2).id}`, 200, { token: A, body: { city: 'Chennai' } });
  await check('list addresses', 'GET', `/customers/${customer.id}/addresses`, 200, { token: A, assert: (r) => data(r).length === 3 });
  await check('delete address', 'DELETE', `/customers/${customer.id}/addresses/${data(ship2).id}`, 200, { token: A });
  await check('staff cannot list customers', 'GET', '/customers', 403, { token: S });
  await check('customers need auth', 'GET', '/customers', 401);
  await check('B cannot read A customer', 'GET', `/customers/${customer.id}`, 404, { token: B });
  await check('B cannot list A customer addresses', 'GET', `/customers/${customer.id}/addresses`, 404, { token: B });
  const gone = await check('create throwaway customer', 'POST', '/customers', 201, { token: A, body: { email: `gone-${RUN}@audit.test`, firstName: 'Gone', lastName: 'Soon' } });
  await check('delete customer', 'DELETE', `/customers/${data(gone).id}`, 200, { token: A });
  await check('deleted customer 404', 'GET', `/customers/${data(gone).id}`, 404, { token: A });

  // ── Orders ───────────────────────────────────────────────────────────
  group = 'orders';
  const o1 = await check('create order', 'POST', '/orders', 201, { token: A, body: { customerId: customer.id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 2 }], currency: 'USD' } });
  const order1 = data(o1);
  record('order snapshots default addresses', order1?.shippingAddress?.line1 === '1 Main St' && order1?.billingAddress?.addressId === data(billTo)?.id, JSON.stringify({ ship: order1?.shippingAddress?.line1, bill: order1?.billingAddress?.addressId }));
  await check('order with deleted customer rejected', 'POST', '/orders', 404, { token: A, body: { customerId: data(gone).id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 1 }] } });
  await check('order with wrong address type rejected', 'POST', '/orders', 400, { token: A, body: { customerId: customer.id, shippingAddressId: data(billTo).id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 1 }] } });
  await check('oversell rejected', 'POST', '/orders', [400, 409, 422], { token: A, body: { customerId: customer.id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 99999 }] } });
  await check('order with foreign customer rejected', 'POST', '/orders', [400, 404], { token: B, body: { customerId: customer.id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 1 }] } });
  await check('list orders', 'GET', '/orders', 200, { token: A });
  await check('get order', 'GET', `/orders/${order1.id}`, 200, { token: A });
  const o1Status = order1.status;
  const next = o1Status === 'DRAFT' ? 'PENDING' : 'CONFIRMED';
  await check(`status ${o1Status}→${next}`, 'PATCH', `/orders/${order1.id}/status`, 200, { token: A, body: { status: next } });
  if (next === 'PENDING') await check('status PENDING→CONFIRMED', 'PATCH', `/orders/${order1.id}/status`, 200, { token: A, body: { status: 'CONFIRMED' } });
  await check('invalid transition rejected', 'PATCH', `/orders/${order1.id}/status`, [400, 409, 422], { token: A, body: { status: 'DELIVERED' } });
  await check('order history', 'GET', `/orders/${order1.id}/history`, 200, { token: A });
  const o2 = await check('create order 2', 'POST', '/orders', 201, { token: A, body: { customerId: customer.id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 5 }] } });
  const before = stockOf(await call('GET', `/inventory/variants/${variantId}`, { token: A }), W1);
  await check('cancel order 2', 'POST', `/orders/${data(o2).id}/cancel`, 200, { token: A, body: { reason: 'Customer changed mind' } });
  const after = stockOf(await call('GET', `/inventory/variants/${variantId}`, { token: A }), W1);
  record('cancel restores stock (+5)', after - before === 5, `before=${before} after=${after}`);
  await check('cancel twice rejected', 'POST', `/orders/${data(o2).id}/cancel`, [400, 409, 422], { token: A, body: {} });

  // ── Payments ─────────────────────────────────────────────────────────
  group = 'payments';
  const pay = await check('create payment', 'POST', '/payments/create', 201, { token: A, body: { orderId: order1.id } });
  const paymentId = data(pay)?.id || data(pay)?.payment?.id;
  await check('duplicate pending payment rejected', 'POST', '/payments/create', [400, 409], { token: A, body: { orderId: order1.id } });
  await check('client amount not accepted', 'POST', '/payments/create', 400, { token: A, body: { orderId: order1.id, amount: '0.01' } });
  await check('get payment', 'GET', `/payments/${paymentId}`, 200, { token: A });
  await check('tenant B cannot read payment', 'GET', `/payments/${paymentId}`, 404, { token: B });
  const conf = await check('confirm payment', 'POST', '/payments/confirm', 200, { token: A, body: { paymentId } });
  const providerPaymentId = data(conf)?.providerPaymentId || data(conf)?.payment?.providerPaymentId;
  await check('partial refund', 'POST', `/payments/${paymentId}/refund`, [200, 201], { token: A, body: { amount: '1.00', reason: 'Damaged' } });
  await check('over-refund rejected', 'POST', `/payments/${paymentId}/refund`, [400, 409, 422], { token: A, body: { amount: '999999.00' } });
  const event = { eventId: `evt_${RUN}`, type: 'payment.succeeded', paymentId, providerPaymentId, amount: order1.total, currency: order1.currency || 'USD' };
  for (const k of Object.keys(event)) if (event[k] === undefined) delete event[k];
  const rawEvent = JSON.stringify(event);
  await check('webhook unsigned rejected', 'POST', '/payments/webhook', [400, 401], { raw: rawEvent });
  await check('webhook bad signature rejected', 'POST', '/payments/webhook', [400, 401], { raw: rawEvent, headers: { 'X-Webhook-Signature': 'deadbeef' } });
  const sig = crypto.createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET).update(rawEvent).digest('hex');
  await check('webhook signed accepted', 'POST', '/payments/webhook', [200, 202], { raw: rawEvent, headers: { 'X-Webhook-Signature': sig } });
  await check('webhook replay idempotent', 'POST', '/payments/webhook', [200, 202], { raw: rawEvent, headers: { 'X-Webhook-Signature': sig } });

  // ── Audit, notifications, jobs ───────────────────────────────────────
  group = 'audit';
  await check('audit logs', 'GET', '/audit-logs?limit=5', 200, { token: A, assert: (r) => data(r).length > 0 });
  const act = await check('activity logs', 'GET', '/activity-logs?limit=5', 200, { token: A });
  if (data(act)?.[0]) {
    await check('get activity log', 'GET', `/activity-logs/${data(act)[0].id}`, 200, { token: A });
    await check('tenant B cannot read A activity', 'GET', `/activity-logs/${data(act)[0].id}`, 404, { token: B });
  }
  await check('staff cannot read audit', 'GET', '/audit-logs', 403, { token: S });

  group = 'notifications';
  await check('enqueue notification job', 'POST', '/jobs/notifications', [200, 202], { token: A, body: { title: 'Audit', message: 'Hello from the audit' } });
  await new Promise((r) => setTimeout(r, 1500));
  const notes = await check('list notifications', 'GET', '/notifications', 200, { token: A });
  if (data(notes)?.[0]) await check('mark one read', 'PATCH', `/notifications/${data(notes)[0].id}/read`, 200, { token: A });
  else record('notification delivered by worker', false, 'no notification visible after job (worker not running?)');
  await check('mark all read', 'POST', '/notifications/read-all', 200, { token: A });
  await check('get preferences', 'GET', '/notification-preferences', 200, { token: A });
  await check('update preferences', 'PATCH', '/notification-preferences', 200, { token: A, body: { EMAIL: false } });

  group = 'jobs';
  await check('jobs status', 'GET', '/jobs/status', 200, { token: A });
  await check('enqueue cleanup', 'POST', '/jobs/cleanup', [200, 202], { token: A });
  await check('enqueue report', 'POST', '/jobs/reports', 202, { token: A, body: { reportType: 'orders' } });
  await check('enqueue analytics', 'POST', '/jobs/analytics', [200, 202], { token: A, body: { metric: 'revenue' } });
  await check('staff (no perms) cannot trigger cleanup', 'POST', '/jobs/cleanup', 403, { token: S, note: 'jobs routes only check authentication, not permissions' });
  await check('staff (no perms) cannot read job status', 'GET', '/jobs/status', 403, { token: S, note: 'jobs routes only check authentication, not permissions' });

  // ── Dashboard & analytics ────────────────────────────────────────────
  group = 'analytics';
  await check('dashboard overview', 'GET', '/dashboard/overview', 200, { token: A });
  for (const ep of ['overview', 'sales', 'orders', 'inventory', 'customers', 'revenue']) {
    await check(`analytics ${ep}`, 'GET', `/analytics/${ep}`, 200, { token: A });
  }
  const second = await call('GET', '/analytics/overview', { token: A });
  record('analytics cache HIT on repeat', second.headers.get('x-cache') === 'HIT', `x-cache=${second.headers.get('x-cache')}`);
  await check('analytics bad date range', 'GET', '/analytics/sales?from=2026-12-01&to=2026-01-01', 400, { token: A });
  await check('staff cannot read analytics', 'GET', '/analytics/overview', 403, { token: S });

  // ── Tenant workspace (Phase 30) ──────────────────────────────────────
  group = 'workspace';
  await check('get workspace', 'GET', '/workspace', 200, { token: A, assert: (r) => data(r)?.id === tenantA.id });
  await check('auth/me has tenant', 'GET', '/auth/me', 200, { token: A, assert: (r) => data(r)?.tenant?.id === tenantA.id });
  await check('rename workspace', 'PATCH', '/workspace', 200, { token: A, body: { name: `Audit A ${RUN} renamed` } });
  await check('update settings', 'PATCH', '/workspace/settings', 200, { token: A, body: { currency: 'inr', timezone: 'Asia/Kolkata' }, assert: (r) => data(r)?.currency === 'INR' });
  await check('invalid timezone 400', 'PATCH', '/workspace/settings', 400, { token: A, body: { timezone: 'Mars/Olympus' } });
  const dom = await check('add domain', 'POST', '/workspace/domains', 201, { token: A, body: { domain: `shop-${RUN}.audit.test` }, assert: (r) => data(r)?.primary === true });
  await check('domain taken by B 409', 'POST', '/workspace/domains', 409, { token: B, body: { domain: `shop-${RUN}.audit.test` } });
  await check('malformed domain 400', 'POST', '/workspace/domains', 400, { token: A, body: { domain: 'https://x.audit.test/a' } });
  await check('list domains', 'GET', '/workspace/domains', 200, { token: A, assert: (r) => data(r).length === 1 });
  await check('B cannot touch A domain', 'DELETE', `/workspace/domains/${data(dom)?.id}`, 404, { token: B });
  await check('staff cannot update workspace', 'PATCH', '/workspace', 403, { token: S, body: { name: 'Pwned' } });
  await check('platform token refused on workspace', 'GET', '/workspace', 403, { token: P });

  // ── Read-only support sessions (Phase 30, F33) ───────────────────────
  group = 'support';
  await check('support needs a reason', 'POST', `/platform/tenants/${tenantA.id}/support-sessions`, 400, { token: P, body: {} });
  await check('tenant token cannot start support', 'POST', `/platform/tenants/${tenantA.id}/support-sessions`, 403, { token: A, body: { reason: 'audit check' } });
  const sup = await check('start support session', 'POST', `/platform/tenants/${tenantA.id}/support-sessions`, 201, { token: P, body: { reason: `audit run ${RUN}` }, assert: (r) => data(r)?.readOnly === true });
  const SUP = data(sup)?.accessToken;
  await check('support reads workspace', 'GET', '/workspace', 200, { token: SUP, assert: (r) => data(r)?.id === tenantA.id });
  await check('support reads customers', 'GET', '/customers', 200, { token: SUP });
  await check('support /auth/me', 'GET', '/auth/me', 200, { token: SUP, assert: (r) => data(r)?.scope === 'support' && data(r)?.support?.readOnly === true });
  await check('support write refused', 'POST', '/customers', 403, { token: SUP, body: { email: `sup-${RUN}@audit.test`, firstName: 'S', lastName: 'U' } });
  await check('support settings write refused', 'PATCH', '/workspace/settings', 403, { token: SUP, body: { currency: 'USD' } });
  await check('support kept out of own-account endpoints', 'GET', '/auth/sessions', 403, { token: SUP });
  await check('support cannot read B customer', 'GET', `/customers/${data(await call('POST', '/customers', { token: B, body: { email: `bsup-${RUN}@audit.test`, firstName: 'B', lastName: 'Sup' } }))?.id}`, 404, { token: SUP });
  await check('end support session', 'DELETE', `/platform/support-sessions/${data(sup)?.sessionId}`, 200, { token: P });
  await check('ended support token rejected', 'GET', '/workspace', 401, { token: SUP });

  // ── Reports (Phase 31) — needs the worker (node src/worker.js) running ──
  group = 'reports';
  const rep = await check('request orders report', 'POST', '/reports', 202, { token: A, body: { type: 'ORDERS' } });
  const reportId = data(rep)?.id;
  let report = data(rep);
  for (let i = 0; i < 30 && !['COMPLETED', 'FAILED'].includes(report?.status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    report = data(await call('GET', `/reports/${reportId}`, { token: A }));
  }
  record('worker completes report', report?.status === 'COMPLETED' && report?.rowCount >= 1, `status=${report?.status} rows=${report?.rowCount} (is the worker running?)`);
  const link = await check('report download link', 'GET', `/reports/${reportId}/download`, 200, { token: A });
  const csvUrl = data(link)?.url;
  if (csvUrl) {
    const csv = await fetch(`${BASE}${csvUrl}`);
    const text = await csv.text();
    record('signed CSV download', csv.status === 200 && csv.headers.get('content-type')?.startsWith('text/csv') && text.includes('orderId,createdAt,status'), `status=${csv.status} type=${csv.headers.get('content-type')}`);
  } else record('signed CSV download', false, 'no url');
  await check('invalid report type 400', 'POST', '/reports', 400, { token: A, body: { type: 'SALES' } });
  await check('list reports', 'GET', '/reports', 200, { token: A });
  await check('staff cannot request reports', 'POST', '/reports', 403, { token: S, body: { type: 'ORDERS' } });
  await check('B cannot read A report', 'GET', `/reports/${reportId}`, 404, { token: B });
  await check('B cannot download A report', 'GET', `/reports/${reportId}/download`, 404, { token: B });

  // ── Notification templates (Phase 31) ────────────────────────────────
  group = 'templates';
  const tpl = await check('create template', 'POST', '/notification-templates', 201, { token: A, body: { name: 'order.created', channel: 'IN_APP', subject: 'Order {{orderId}}', body: 'Total {{total}} {{currency}}', variables: ['orderId', 'total', 'currency'] } });
  const tplId = data(tpl)?.id;
  await check('undeclared placeholder 400', 'POST', '/notification-templates', 400, { token: A, body: { name: 'x.y', channel: 'SMS', body: 'Hi {{who}}' } });
  await check('duplicate template 409', 'POST', '/notification-templates', 409, { token: A, body: { name: 'order.created', channel: 'IN_APP', subject: 'S', body: 'B' } });
  await check('list templates', 'GET', '/notification-templates', 200, { token: A, assert: (r) => data(r).length === 1 });
  await check('update template', 'PATCH', `/notification-templates/${tplId}`, 200, { token: A, body: { subject: 'New order {{orderId}}' } });
  await check('preview template', 'POST', `/notification-templates/${tplId}/preview`, 200, { token: A, body: { variables: { orderId: 'X1', total: '9.99' } }, assert: (r) => data(r)?.subject === 'New order X1' && data(r)?.missingVariables?.includes('currency') });
  await check('B cannot read A template', 'GET', `/notification-templates/${tplId}`, 404, { token: B });
  await check('staff cannot create template', 'POST', '/notification-templates', 403, { token: S, body: { name: 's.t', channel: 'SMS', body: 'x' } });
  await check('delete template', 'DELETE', `/notification-templates/${tplId}`, 200, { token: A });

  // ── Tenant isolation ─────────────────────────────────────────────────
  group = 'isolation';
  await check('B cannot read A product', 'GET', `/products/${productId}`, 404, { token: B });
  await check('B cannot update A product', 'PATCH', `/products/${productId}`, 404, { token: B, body: { name: 'Pwned' } });
  await check('B cannot read A order', 'GET', `/orders/${order1.id}`, 404, { token: B });
  await check('B cannot read A warehouse', 'GET', `/warehouses/${W1}`, 404, { token: B });
  await check('B cannot read A user', 'GET', `/users/${staffId}`, 404, { token: B });
  await check('B cannot adjust A stock', 'POST', '/inventory/adjust', [400, 404], { token: B, body: { variantId, warehouseId: W1, quantityChanged: 5 } });
  await check('B product list excludes A', 'GET', `/products?search=${RUN}`, 200, { token: B, assert: (r) => data(r).length === 0 });
  await check('B cannot assign A role', 'POST', `/users/${data(bLogin).user.id}/roles`, [400, 404], { token: B, body: { roleIds: [roleId] } });

  // ── Realtime ─────────────────────────────────────────────────────────
  group = 'realtime';
  await socketCheck('socket connects with tenant token', A, true);
  await socketCheck('socket rejects missing token', null, false);
  await socketCheck('socket rejects garbage token', 'abc.def.ghi', false);

  // ── OpenAPI coverage ─────────────────────────────────────────────────
  group = 'openapi';
  const paths = Object.keys(spec.json?.paths || {});
  for (const p of ['/api/v1/platform/tenants', '/api/v1/auth/login', '/api/v1/orders', '/api/v1/storage/signed']) {
    record(`spec documents ${p}`, paths.includes(p), 'missing from OpenAPI');
  }

  // ── Cleanup & delete paths ───────────────────────────────────────────
  group = 'cleanup';
  if (imageId) await check('delete product image', 'DELETE', `/products/${productId}/images/${imageId}`, [200, 204], { token: A });
  await check('delete attribute value', 'DELETE', `/attributes/${attrId}/values/${data(val).id}`, [200, 204, 409], { token: A });
  await check('delete role', 'DELETE', `/roles/${roleId}`, [200, 204, 409], { token: A });
  await check('delete empty warehouse blocked or ok', 'DELETE', `/warehouses/${W2}`, [200, 204, 409], { token: A });
  await check('delete category in use blocked', 'DELETE', `/categories/${data(catC).id}`, [400, 409], { token: A });
  await check('delete product with variants blocked', 'DELETE', `/products/${productId}`, [400, 409], { token: A });
  await check('delete staff user', 'DELETE', `/users/${staffId}`, [200, 204], { token: A });
  await check('deleted user token rejected', 'GET', '/auth/me', 401, { token: S });
  await check('logout', 'POST', '/auth/logout', 200, { token: A, body: { refreshToken: aRelogin.refreshToken } });
  await check('refresh after logout rejected', 'POST', '/auth/refresh', 401, { body: { refreshToken: aRelogin.refreshToken } });
  await check('access token rejected after logout', 'GET', '/auth/me', 401, { token: A });

}

main()
  .catch((err) => { results.push({ group, name: 'audit aborted', method: '-', path: '-', expected: '-', actual: 'error', ok: false, note: err.stack }); })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    const byGroup = {};
    for (const r of results) { byGroup[r.group] ??= { pass: 0, fail: 0 }; byGroup[r.group][r.ok ? 'pass' : 'fail'] += 1; }
    console.table(byGroup);
    console.log(`\nTOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}\n`);
    for (const f of failed) console.log(`FAIL [${f.group}] ${f.name} — ${f.method} ${f.path} expected ${f.expected} got ${f.actual}${f.code ? ` (${f.code})` : ''}${f.note ? ` :: ${String(f.note).split('\n')[0]}` : ''}`);
    const outIdx = process.argv.indexOf('--out');
    if (outIdx > -1) writeFileSync(process.argv[outIdx + 1], JSON.stringify({ run: RUN, base: BASE, results }, null, 2));
    process.exit(failed.length ? 1 : 0);
  });
