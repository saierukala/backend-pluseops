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
 * Needs: running API (raise RATE_LIMIT_MAX / AUTH_RATE_LIMIT_MAX for the run),
 * seeded platform admin (npm run db:seed), DATABASE_URL in .env (used only to
 * insert a Customer row, because there is no Customer API yet).
 *
 * Creates two tenants with slug prefix `audit-` per run. There is no tenant
 * delete on the platform API, so they remain in the database afterwards.
 */
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { io as ioClient } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { env } from '../src/config/env.js';

const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const PLATFORM_EMAIL = process.env.PLATFORM_ADMIN_EMAIL || 'sairram@gmail.com';
const PLATFORM_PASSWORD = process.env.PLATFORM_ADMIN_PASSWORD || 'Sairram@123';
const RUN = Date.now().toString(36);
const PASSWORD = 'Audit#Pass123';

const prisma = new PrismaClient();
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
  A = data(rf)?.accessToken || A;
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
  await check('change password endpoint exists', 'POST', '/auth/change-password', [200, 400, 401], { token: S, body: { currentPassword: PASSWORD, newPassword: 'Audit#Pass456' }, note: 'no authenticated change-password endpoint' });

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

  // ── Customers (no API) & orders ──────────────────────────────────────
  group = 'orders';
  await check('customers API exists', 'GET', '/customers', 200, { token: A, note: 'no Customer API — orders need a customerId that cannot be created via REST' });
  const customer = await prisma.customer.create({ data: { tenantId: tenantA.id, email: `buyer-${RUN}@audit.test`, firstName: 'Bea', lastName: 'Buyer' } });
  const o1 = await check('create order', 'POST', '/orders', 201, { token: A, body: { customerId: customer.id, items: [{ productVariantId: variantId, warehouseId: W1, quantity: 2 }], currency: 'USD' } });
  const order1 = data(o1);
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
  await check('enqueue report', 'POST', '/jobs/reports', [200, 202], { token: A, body: { reportType: 'sales' } });
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
  await check('logout', 'POST', '/auth/logout', 200, { token: A, body: { refreshToken: data(rf)?.refreshToken } });
  await check('refresh after logout rejected', 'POST', '/auth/refresh', 401, { body: { refreshToken: data(rf)?.refreshToken } });

}

main()
  .catch((err) => { results.push({ group, name: 'audit aborted', method: '-', path: '-', expected: '-', actual: 'error', ok: false, note: err.stack }); })
  .finally(async () => {
    await prisma.$disconnect();
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
