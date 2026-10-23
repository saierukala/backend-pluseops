/**
 * Canonical tenant permission catalog and system roles.
 *
 * Single source for every place that provisions a tenant (prisma/seed.js and the
 * platform tenant-creation flow). Every `authorize('<resource>:<action>')` used in
 * a route must appear here, otherwise no tenant role can ever be granted access
 * (enforced by tests/unit/system-permissions.test.js).
 */
const CRUD = ['create', 'read', 'update', 'delete'];

function perms(resource, actions) {
  return actions.map((action) => ({ resource, action, name: `${resource}:${action}` }));
}

export const SYSTEM_PERMISSIONS = [
  ...perms('tenant', ['read', 'update']),
  ...perms('user', CRUD),
  ...perms('role', CRUD),
  ...perms('permission', ['read']),
  ...perms('product', CRUD),
  ...perms('category', CRUD),
  ...perms('attribute', CRUD),
  ...perms('order', ['create', 'read', 'update', 'cancel']),
  ...perms('customer', CRUD),
  ...perms('warehouse', CRUD),
  ...perms('inventory', ['read', 'update']),
  ...perms('payment', ['create', 'read', 'confirm', 'refund']),
  ...perms('audit', ['read']),
  ...perms('activity', ['read']),
  ...perms('notification', ['read', 'update']),
  ...perms('dashboard', ['read']),
  ...perms('analytics', ['read']),
  ...perms('jobs', ['read', 'manage']),
];

// Global platform permissions (no tenantId), granted to platform roles only.
export const PLATFORM_PERMISSIONS = [
  ...perms('platform:tenant', ['create', 'read', 'update', 'suspend', 'delete', 'access']),
  ...perms('platform:billing', ['read', 'update']),
];

export const SYSTEM_ROLES = [
  { name: 'admin', description: 'Full administrative access' },
  { name: 'manager', description: 'Management access to most resources' },
  { name: 'member', description: 'Standard member access' },
];

export const MANAGER_EXCLUDED_PERMISSIONS = ['user:delete', 'role:delete', 'permission:read', 'tenant:update'];
