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

async function createTestTenant(slug) {
  return prisma.tenant.create({
    data: { name: `Test Tenant ${slug}`, slug, status: 'ACTIVE' },
  });
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

async function setupTenantWithPermissions(tenantId) {
  const SYSTEM_PERMISSIONS = [
    { resource: 'category', action: 'create', name: 'category:create' },
    { resource: 'category', action: 'read', name: 'category:read' },
    { resource: 'category', action: 'update', name: 'category:update' },
    { resource: 'category', action: 'delete', name: 'category:delete' },
    { resource: 'product', action: 'create', name: 'product:create' },
    { resource: 'product', action: 'read', name: 'product:read' },
    { resource: 'product', action: 'update', name: 'product:update' },
    { resource: 'product', action: 'delete', name: 'product:delete' },
    { resource: 'attribute', action: 'create', name: 'attribute:create' },
    { resource: 'attribute', action: 'read', name: 'attribute:read' },
    { resource: 'attribute', action: 'update', name: 'attribute:update' },
    { resource: 'attribute', action: 'delete', name: 'attribute:delete' },
  ];

  const permissions = {};
  for (const perm of SYSTEM_PERMISSIONS) {
    const p = await prisma.permission.upsert({
      where: { tenantId_resource_action: { tenantId, resource: perm.resource, action: perm.action } },
      update: {},
      create: { tenantId, name: perm.name, resource: perm.resource, action: perm.action },
    });
    permissions[perm.name] = p.id;
  }

  const role = await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: 'admin' } },
    update: {},
    create: { tenantId, name: 'admin', description: 'Admin role', isSystem: true },
  });

  for (const permId of Object.values(permissions)) {
    await prisma.rolePermission.upsert({
      where: { tenantId_roleId_permissionId: { tenantId, roleId: role.id, permissionId: permId } },
      update: {},
      create: { tenantId, roleId: role.id, permissionId: permId },
    });
  }

  return { roleId: role.id, permissions };
}

describe('Phase 07 - Product Management', () => {
  let tenantAId;
  let tenantBId;
  let userAId;
  let userBId;
  let tokenA;
  let tokenB;
  let adminRoleAId;

  beforeAll(async () => {
    const tenantA = await createTestTenant('tenant-a-phase7');
    tenantAId = tenantA.id;

    const tenantB = await createTestTenant('tenant-b-phase7');
    tenantBId = tenantB.id;

    const userA = await createTestUser(tenantAId, 'usera@tenant-a.com');
    userAId = userA.id;

    const userB = await createTestUser(tenantBId, 'userb@tenant-b.com');
    userBId = userB.id;

    const { roleId } = await setupTenantWithPermissions(tenantAId);
    adminRoleAId = roleId;

    const { roleId: roleIdB } = await setupTenantWithPermissions(tenantBId);

    await prisma.userRole.create({
      data: { tenantId: tenantAId, userId: userAId, roleId: adminRoleAId },
    });

    await prisma.userRole.create({
      data: { tenantId: tenantBId, userId: userBId, roleId: roleIdB },
    });

    tokenA = await loginAndGetToken(app, 'usera@tenant-a.com', 'SecurePass123!', tenantAId);
    tokenB = await loginAndGetToken(app, 'userb@tenant-b.com', 'SecurePass123!', tenantBId);
  });

  afterAll(async () => {
    await prisma.productImage.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.productVariantAttribute.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.productVariant.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.productCategory.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.product.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.category.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.attributeValue.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.attributeDefinition.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.userRole.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.rolePermission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.role.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.permission.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    await disconnectDatabase();
  });

  describe('Categories CRUD', () => {
    let categoryId;

    it('POST /api/v1/categories - creates a category', async () => {
      const response = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Electronics', slug: 'electronics', description: 'Electronic devices' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('Electronics');
      expect(response.body.data.slug).toBe('electronics');
      expect(response.body.data.tenantId).toBe(tenantAId);
      categoryId = response.body.data.id;
    });

    it('POST /api/v1/categories - rejects duplicate slug in same tenant', async () => {
      const response = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Electronics 2', slug: 'electronics' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CATEGORY_SLUG_EXISTS');
    });

    it('POST /api/v1/categories - allows same slug in different tenant', async () => {
      const response = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Electronics', slug: 'electronics' });

      expect(response.status).toBe(201);
      expect(response.body.data.tenantId).toBe(tenantBId);
    });

    it('GET /api/v1/categories - lists categories with pagination', async () => {
      const response = await request(app)
        .get('/api/v1/categories?page=1&limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta).toBeDefined();
    });

    it('GET /api/v1/categories/:id - retrieves a category', async () => {
      const response = await request(app)
        .get(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(categoryId);
      expect(response.body.data.name).toBe('Electronics');
    });

    it('PATCH /api/v1/categories/:id - updates a category', async () => {
      const response = await request(app)
        .patch(`/api/v1/categories/${categoryId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ description: 'Updated description' });

      expect(response.status).toBe(200);
      expect(response.body.data.description).toBe('Updated description');
    });

    it('DELETE /api/v1/categories/:id - deletes a category', async () => {
      const createResponse = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'To Delete', slug: 'to-delete' });

      const response = await request(app)
        .delete(`/api/v1/categories/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Category hierarchy', () => {
    let parentId;
    let childId;

    it('creates parent and child categories', async () => {
      const parent = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Parent', slug: 'parent' });
      parentId = parent.body.data.id;

      const child = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Child', slug: 'child', parentId });
      childId = child.body.data.id;

      expect(child.body.data.parentId).toBe(parentId);
    });

    it('rejects cycle in hierarchy', async () => {
      const response = await request(app)
        .patch(`/api/v1/categories/${parentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ parentId: childId });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CATEGORY_CYCLE_DETECTED');
    });

    it('prevents deleting category with children', async () => {
      const response = await request(app)
        .delete(`/api/v1/categories/${parentId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CATEGORY_HAS_CHILDREN');
    });
  });

  describe('Products CRUD', () => {
    let productId;
    let categoryId;

    beforeAll(async () => {
      const cat = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Test Category', slug: 'test-category' });
      categoryId = cat.body.data.id;
    });

    it('POST /api/v1/products - creates a product', async () => {
      const response = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Test Product',
          description: 'A test product',
          brand: 'Test Brand',
          status: 'ACTIVE',
          basePrice: '99.99',
          categories: [categoryId],
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('Test Product');
      expect(response.body.data.tenantId).toBe(tenantAId);
      expect(response.body.data.categories).toHaveLength(1);
      productId = response.body.data.id;
    });

    it('POST /api/v1/products - rejects invalid category', async () => {
      const response = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          name: 'Bad Product',
          categories: ['00000000-0000-0000-0000-000000000000'],
        });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('CATEGORY_NOT_FOUND');
    });

    it('GET /api/v1/products - lists products with pagination', async () => {
      const response = await request(app)
        .get('/api/v1/products?page=1&limit=10')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta).toBeDefined();
    });

    it('GET /api/v1/products - supports search', async () => {
      const response = await request(app)
        .get('/api/v1/products?search=Test')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].name).toContain('Test');
    });

    it('GET /api/v1/products - filters by status', async () => {
      const response = await request(app)
        .get('/api/v1/products?status=ACTIVE')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.every(p => p.status === 'ACTIVE')).toBe(true);
    });

    it('GET /api/v1/products - filters by category', async () => {
      const response = await request(app)
        .get(`/api/v1/products?categoryId=${categoryId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/products/:id - retrieves a product', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(productId);
      expect(response.body.data.name).toBe('Test Product');
    });

    it('PATCH /api/v1/products/:id - updates a product', async () => {
      const response = await request(app)
        .patch(`/api/v1/products/${productId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ description: 'Updated product description' });

      expect(response.status).toBe(200);
      expect(response.body.data.description).toBe('Updated product description');
    });

    it('DELETE /api/v1/products/:id - deletes a product', async () => {
      const createResponse = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'To Delete', status: 'DRAFT' });

      const response = await request(app)
        .delete(`/api/v1/products/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Product Categories', () => {
    let productId;
    let categoryId1;
    let categoryId2;

    beforeAll(async () => {
      const cat1 = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Cat 1', slug: 'cat-1' });
      categoryId1 = cat1.body.data.id;

      const cat2 = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Cat 2', slug: 'cat-2' });
      categoryId2 = cat2.body.data.id;

      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Category Test Product', status: 'ACTIVE' });
      productId = product.body.data.id;
    });

    it('POST /api/v1/products/:productId/categories - sets product categories', async () => {
      const response = await request(app)
        .post(`/api/v1/products/${productId}/categories`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ categories: [categoryId1, categoryId2], primaryCategoryId: categoryId1 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      const primary = response.body.data.find(c => c.isPrimary);
      expect(primary.categoryId).toBe(categoryId1);
    });

    it('GET /api/v1/products/:productId/categories - gets product categories', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/categories`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(2);
    });
  });

  describe('Variants CRUD', () => {
    let productId;
    let variantId;

    beforeAll(async () => {
      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Variant Product', status: 'ACTIVE' });
      productId = product.body.data.id;
    });

    it('POST /api/v1/products/:productId/variants - creates a variant', async () => {
      const response = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          sku: 'TEST-SKU-001',
          price: '29.99',
          costPrice: '15.00',
          status: 'ACTIVE',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.sku).toBe('TEST-SKU-001');
      expect(response.body.data.price.toString()).toBe('29.99');
      expect(response.body.data.tenantId).toBe(tenantAId);
      variantId = response.body.data.id;
    });

    it('POST /api/v1/products/:productId/variants - enforces unique SKU per tenant', async () => {
      const response = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          sku: 'TEST-SKU-001',
          price: '39.99',
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SKU_EXISTS');
    });

    it('POST /api/v1/products/:productId/variants - allows same SKU in different tenant', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const response = await request(app)
        .post(`/api/v1/products/${productB.body.data.id}/variants`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({
          sku: 'TEST-SKU-001',
          price: '49.99',
        });

      expect(response.status).toBe(201);
    });

    it('POST /api/v1/products/:productId/variants - enforces unique barcode per tenant', async () => {
      await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          sku: 'TEST-SKU-002',
          barcode: '1234567890123',
          price: '19.99',
        });

      const response = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          sku: 'TEST-SKU-003',
          barcode: '1234567890123',
          price: '29.99',
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('BARCODE_EXISTS');
    });

    it('GET /api/v1/products/:productId/variants - lists variants', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('GET /api/v1/products/:productId/variants/:variantId - retrieves a variant', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(variantId);
      expect(response.body.data.sku).toBe('TEST-SKU-001');
    });

    it('PATCH /api/v1/products/:productId/variants/:variantId - updates a variant', async () => {
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ price: '34.99' });

      expect(response.status).toBe(200);
      expect(response.body.data.price.toString()).toBe('34.99');
    });

    it('DELETE /api/v1/products/:productId/variants/:variantId - deletes a variant', async () => {
      const createResponse = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'TO-DELETE', price: '10.00' });

      const response = await request(app)
        .delete(`/api/v1/products/${productId}/variants/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Attributes CRUD', () => {
    let attributeId;

    it('POST /api/v1/attributes - creates a TEXT attribute', async () => {
      const response = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Color', code: 'color', dataType: 'TEXT' });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.name).toBe('Color');
      expect(response.body.data.code).toBe('color');
      expect(response.body.data.dataType).toBe('TEXT');
      expect(response.body.data.tenantId).toBe(tenantAId);
      attributeId = response.body.data.id;
    });

    it('POST /api/v1/attributes - creates a NUMBER attribute', async () => {
      const response = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Weight', code: 'weight', dataType: 'NUMBER' });

      expect(response.status).toBe(201);
      expect(response.body.data.dataType).toBe('NUMBER');
    });

    it('POST /api/v1/attributes - creates a BOOLEAN attribute', async () => {
      const response = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Waterproof', code: 'waterproof', dataType: 'BOOLEAN' });

      expect(response.status).toBe(201);
      expect(response.body.data.dataType).toBe('BOOLEAN');
    });

    it('POST /api/v1/attributes - creates an OPTION attribute', async () => {
      const response = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Size', code: 'size', dataType: 'OPTION' });

      expect(response.status).toBe(201);
      expect(response.body.data.dataType).toBe('OPTION');
    });

    it('POST /api/v1/attributes - rejects duplicate code in same tenant', async () => {
      const response = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Color 2', code: 'color', dataType: 'TEXT' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ATTRIBUTE_CODE_EXISTS');
    });

    it('GET /api/v1/attributes - lists attributes', async () => {
      const response = await request(app)
        .get('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('PATCH /api/v1/attributes/:id - updates an attribute', async () => {
      const response = await request(app)
        .patch(`/api/v1/attributes/${attributeId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ description: 'Updated' });

      expect(response.status).toBe(200);
    });

    it('DELETE /api/v1/attributes/:id - deletes an attribute not in use', async () => {
      const createResponse = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'To Delete', code: 'to-delete', dataType: 'TEXT' });

      const response = await request(app)
        .delete(`/api/v1/attributes/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Attribute Values', () => {
    let attributeId;
    let valueId;

    beforeAll(async () => {
      const attr = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Size', code: 'size-test', dataType: 'OPTION' });
      attributeId = attr.body.data.id;
    });

    it('POST /api/v1/attributes/:attributeId/values - creates attribute value', async () => {
      const response = await request(app)
        .post(`/api/v1/attributes/${attributeId}/values`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ value: 'small', displayName: 'Small', sortOrder: 1 });

      expect(response.status).toBe(201);
      expect(response.body.data.value).toBe('small');
      expect(response.body.data.displayName).toBe('Small');
      valueId = response.body.data.id;
    });

    it('GET /api/v1/attributes/:attributeId/values - lists values', async () => {
      const response = await request(app)
        .get(`/api/v1/attributes/${attributeId}/values`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('PATCH /api/v1/attributes/:attributeId/values/:valueId - updates value', async () => {
      const response = await request(app)
        .patch(`/api/v1/attributes/${attributeId}/values/${valueId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ displayName: 'Small Size' });

      expect(response.status).toBe(200);
      expect(response.body.data.displayName).toBe('Small Size');
    });

    it('DELETE /api/v1/attributes/:attributeId/values/:valueId - deletes value', async () => {
      const createResponse = await request(app)
        .post(`/api/v1/attributes/${attributeId}/values`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ value: 'to-delete', displayName: 'To Delete' });

      const response = await request(app)
        .delete(`/api/v1/attributes/${attributeId}/values/${createResponse.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Variant Attributes Assignment', () => {
    let productId;
    let variantId;
    let colorAttrId;
    let sizeAttrId;

    beforeAll(async () => {
      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Attr Test Product', status: 'ACTIVE' });
      productId = product.body.data.id;

      const variant = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'ATTR-VAR-001', price: '19.99' });
      variantId = variant.body.data.id;

      const color = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Color', code: 'color-attr', dataType: 'OPTION' });
      colorAttrId = color.body.data.id;

      const size = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Size', code: 'size-attr', dataType: 'OPTION' });
      sizeAttrId = size.body.data.id;

      await request(app)
        .post(`/api/v1/attributes/${colorAttrId}/values`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ value: 'red', displayName: 'Red' });

      await request(app)
        .post(`/api/v1/attributes/${sizeAttrId}/values`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ value: 'm', displayName: 'Medium' });
    });

    it('PUT /api/v1/products/:productId/variants/:variantId/attributes - assigns attributes', async () => {
      const response = await request(app)
        .put(`/api/v1/products/${productId}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          attributes: [
            { attributeDefinitionId: colorAttrId, value: 'red' },
            { attributeDefinitionId: sizeAttrId, value: 'm' },
          ],
        });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('GET /api/v1/products/:productId/variants/:variantId/attributes - retrieves attributes', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('rejects attribute from different tenant', async () => {
      const attrB = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Color B', code: 'color-b', dataType: 'OPTION' });

      const response = await request(app)
        .put(`/api/v1/products/${productId}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          attributes: [{ attributeDefinitionId: attrB.body.data.id, value: 'blue' }],
        });

      expect([400, 404]).toContain(response.status);
    });

    it('rejects invalid product/variant combination', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const response = await request(app)
        .put(`/api/v1/products/${productB.body.data.id}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          attributes: [{ attributeDefinitionId: colorAttrId, value: 'red' }],
        });

      expect(response.status).toBe(404);
    });

    it('validates attribute value types', async () => {
      const numberAttr = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Weight', code: 'weight-attr', dataType: 'NUMBER' });

      const response = await request(app)
        .put(`/api/v1/products/${productId}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          attributes: [{ attributeDefinitionId: numberAttr.body.data.id, value: 'not-a-number' }],
        });

      expect(response.status).toBe(400);
    });
  });

  describe('Product Images', () => {
    let productId;
    let imageId;
    let storageKey;

    beforeAll(async () => {
      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Image Product', status: 'ACTIVE' });
      productId = product.body.data.id;
    });

    it('POST /api/v1/products/:productId/images - uploads product image', async () => {
      const response = await request(app)
        .post(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake-image-data'), 'test.jpg')
        .field('altText', 'Test image')
        .field('isPrimary', 'true');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.storageKey).toContain(`tenants/${tenantAId}/products/${productId}/`);
      expect(response.body.data.isPrimary).toBe(true);
      imageId = response.body.data.id;
      storageKey = response.body.data.storageKey;
    });

    it('GET /api/v1/products/:productId/images - lists product images', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/products/:productId/images/:imageId - retrieves a product image', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(response.status).toBe(200);
      expect(response.body.data.id).toBe(imageId);
      expect(response.body.data.storageKey).toBe(storageKey);
    });

    it('PATCH /api/v1/products/:productId/images/:imageId - updates image metadata', async () => {
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ altText: 'Updated alt', sortOrder: 5 });
      expect(response.status).toBe(200);
      expect(response.body.data.altText).toBe('Updated alt');
      expect(response.body.data.sortOrder).toBe(5);
      expect(response.body.data.storageKey).toBe(storageKey);
      expect(response.body.data.tenantId).toBe(tenantAId);
    });

    it('PATCH cannot modify tenant ownership or storageKey', async () => {
      const before = await request(app)
        .get(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      const originalKey = before.body.data.storageKey;
      const originalTenant = before.body.data.tenantId;
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ altText: 'Hacked', storageKey: 'tenants/evil/products/hack', tenantId: 'evil-tenant-id' });
      expect(response.status).toBe(200);
      expect(response.body.data.storageKey).toBe(originalKey);
      expect(response.body.data.tenantId).toBe(originalTenant);
      expect(response.body.data.storageKey).not.toContain('evil');
      expect(response.body.data.storageKey).toContain(`tenants/${tenantAId}/products/${productId}/`);
    });

    it('PATCH /api/v1/products/:productId/images/:imageId - requires authentication', async () => {
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/images/${imageId}`)
        .send({ altText: 'No auth' });
      expect(response.status).toBe(401);
    });

    it('PATCH /api/v1/products/:productId/images/:imageId - unauthorized user receives 403', async () => {
      const viewerEmail = `viewer-patch-${Date.now()}@tenant-a.com`;
      await createTestUser(tenantAId, viewerEmail);
      const viewerToken = await loginAndGetToken(app, viewerEmail, 'SecurePass123!', tenantAId);
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ altText: 'Viewer attempt' });
      expect(response.status).toBe(403);
    });

    it('DELETE /api/v1/products/:productId/images/:imageId - requires authentication', async () => {
      const upload = await request(app)
        .post(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('to-delete-auth'), 'auth.jpg');
      const delId = upload.body.data.id;
      const response = await request(app)
        .delete(`/api/v1/products/${productId}/images/${delId}`);
      expect(response.status).toBe(401);
      // cleanup
      await request(app).delete(`/api/v1/products/${productId}/images/${delId}`).set('Authorization', `Bearer ${tokenA}`);
    });

    it('DELETE /api/v1/products/:productId/images/:imageId - unauthorized user receives 403', async () => {
      const upload = await request(app)
        .post(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('to-delete-forbidden'), 'forbidden.jpg');
      const delId = upload.body.data.id;
      const viewerEmail = `viewer-del-${Date.now()}@tenant-a.com`;
      await createTestUser(tenantAId, viewerEmail);
      const viewerToken = await loginAndGetToken(app, viewerEmail, 'SecurePass123!', tenantAId);
      const response = await request(app)
        .delete(`/api/v1/products/${productId}/images/${delId}`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(response.status).toBe(403);
      await request(app).delete(`/api/v1/products/${productId}/images/${delId}`).set('Authorization', `Bearer ${tokenA}`);
    });

    it('Cross-tenant PATCH returns 404', async () => {
      const response = await request(app)
        .patch(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ altText: 'Cross tenant' });
      expect(response.status).toBe(404);
    });

    it('Cross-tenant DELETE returns 404', async () => {
      const response = await request(app)
        .delete(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(response.status).toBe(404);
      // verify still exists for owner
      const still = await request(app)
        .get(`/api/v1/products/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(still.status).toBe(200);
    });

    it('DELETE /api/v1/products/:productId/images/:imageId - deletes database record and storage object', async () => {
      const upload = await request(app)
        .post(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('delete-me'), 'deleteme.jpg')
        .field('altText', 'To delete');
      const delId = upload.body.data.id;
      const delKey = upload.body.data.storageKey;
      expect(delKey).toContain(`tenants/${tenantAId}/products/${productId}/`);

      const delResponse = await request(app)
        .delete(`/api/v1/products/${productId}/images/${delId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(delResponse.status).toBe(200);

      const getResponse = await request(app)
        .get(`/api/v1/products/${productId}/images/${delId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(getResponse.status).toBe(404);

      // verify storage file removed
      const { StorageService } = await import('../../src/common/storage/storage.service.js');
      const storage = new StorageService();
      const exists = await storage.fileExists(delKey);
      expect(exists).toBe(false);

      // verify tenant-scoped key not escaped
      expect(delKey).not.toContain('..');
      expect(delKey).toContain(`tenants/${tenantAId}/`);
    });

    it('PATCH with wrong productId returns 404 (product ownership check)', async () => {
      const otherProduct = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Other Product', status: 'ACTIVE' });
      const response = await request(app)
        .patch(`/api/v1/products/${otherProduct.body.data.id}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ altText: 'Wrong product' });
      expect(response.status).toBe(404);
    });

    it('DELETE with wrong productId returns 404', async () => {
      const otherProduct = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Other Product2', status: 'ACTIVE' });
      const response = await request(app)
        .delete(`/api/v1/products/${otherProduct.body.data.id}/images/${imageId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(response.status).toBe(404);
    });

    it('Server-generated storage keys remain tenant scoped', async () => {
      const resp = await request(app)
        .post(`/api/v1/products/${productId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('tenant-scope'), 'scoped.jpg');
      expect(resp.body.data.storageKey).toBe(`tenants/${tenantAId}/products/${productId}/scoped.jpg`);
      await request(app).delete(`/api/v1/products/${productId}/images/${resp.body.data.id}`).set('Authorization', `Bearer ${tokenA}`);
    });
  });

  describe('Variant Images', () => {
    let productId;
    let variantId;

    beforeAll(async () => {
      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Variant Image Product', status: 'ACTIVE' });
      productId = product.body.data.id;

      const variant = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'VAR-IMG-001', price: '25.00' });
      variantId = variant.body.data.id;
    });

    it('POST /api/v1/products/:productId/variants/:variantId/images - uploads variant image', async () => {
      const response = await request(app)
        .post(`/api/v1/products/${productId}/variants/${variantId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake-variant-image'), 'variant.jpg')
        .field('altText', 'Variant image')
        .field('isPrimary', 'true');

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.storageKey).toContain(`tenants/${tenantAId}/products/${productId}/variants/${variantId}/`);
      expect(response.body.data.variantId).toBe(variantId);
    });

    it('GET /api/v1/products/:productId/variants/:variantId/images - lists variant images', async () => {
      const response = await request(app)
        .get(`/api/v1/products/${productId}/variants/${variantId}/images`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('rejects variant not belonging to product', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const variantB = await request(app)
        .post(`/api/v1/products/${productB.body.data.id}/variants`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ sku: `VAR-B-${Date.now()}`, price: '10.00' });

      const response = await request(app)
        .post(`/api/v1/products/${productId}/variants/${variantB.body.data.id}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake'), 'test.jpg');

      expect(response.status).toBe(404);
    });
  });

  describe('Product Filtering', () => {
    let productId;
    let variantId;
    let colorAttrId;
    let sizeAttrId;

    beforeAll(async () => {
      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Filter Product', status: 'ACTIVE', basePrice: '100.00' });
      productId = product.body.data.id;

      const variant = await request(app)
        .post(`/api/v1/products/${productId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'FILTER-SKU-001', price: '99.99', barcode: '9876543210987', status: 'ACTIVE' });
      variantId = variant.body.data.id;

      const color = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Color', code: 'filter-color', dataType: 'OPTION' });
      colorAttrId = color.body.data.id;

      const size = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Size', code: 'filter-size', dataType: 'OPTION' });
      sizeAttrId = size.body.data.id;

      await request(app)
        .put(`/api/v1/products/${productId}/variants/${variantId}/attributes`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          attributes: [
            { attributeDefinitionId: colorAttrId, value: 'black' },
            { attributeDefinitionId: sizeAttrId, value: 'large' },
          ],
        });
    });

    it('GET /api/v1/products?attribute[color]=black - filters by attribute', async () => {
      const response = await request(app)
        .get(`/api/v1/products?attribute[filter-color]=black`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/products?sku=FILTER-SKU-001 - filters by SKU', async () => {
      const response = await request(app)
        .get(`/api/v1/products?sku=FILTER-SKU-001`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].variants[0].sku).toBe('FILTER-SKU-001');
    });

    it('GET /api/v1/products?barcode=9876543210987 - filters by barcode', async () => {
      const response = await request(app)
        .get(`/api/v1/products?barcode=9876543210987`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/v1/products?minPrice=50&maxPrice=150 - filters by price range', async () => {
      const response = await request(app)
        .get('/api/v1/products?minPrice=50&maxPrice=150')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(200);
    });
  });

  describe('Cross-tenant isolation', () => {
    let productAId;
    let categoryAId;

    beforeAll(async () => {
      const cat = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Cat A', slug: 'cat-a' });
      categoryAId = cat.body.data.id;

      const product = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Product A', status: 'ACTIVE', categories: [categoryAId] });
      productAId = product.body.data.id;

      await request(app)
        .post(`/api/v1/products/${productAId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'PROD-A-VAR', price: '50.00' });

      await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Attr A', code: 'attr-a', dataType: 'TEXT' });

      await request(app)
        .post(`/api/v1/products/${productAId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake'), 'test.jpg');
    });

    it('Tenant A cannot access Tenant B category', async () => {
      const catB = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Cat B', slug: 'cat-b' });

      const response = await request(app)
        .get(`/api/v1/categories/${catB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot modify Tenant B category', async () => {
      const catB = await request(app)
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Cat B2', slug: 'cat-b2' });

      const response = await request(app)
        .patch(`/api/v1/categories/${catB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Attack' });

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot access Tenant B product', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const response = await request(app)
        .get(`/api/v1/products/${productB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot access Tenant B variant', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const variantB = await request(app)
        .post(`/api/v1/products/${productB.body.data.id}/variants`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ sku: `VAR-B-CROSS-${Date.now()}`, price: '10.00' });

      const response = await request(app)
        .get(`/api/v1/products/${productB.body.data.id}/variants/${variantB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot access Tenant B attribute', async () => {
      const attrB = await request(app)
        .post('/api/v1/attributes')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Attr B', code: 'attr-b', dataType: 'TEXT' });

      const response = await request(app)
        .get(`/api/v1/attributes/${attrB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot access Tenant B product image', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      const imageB = await request(app)
        .post(`/api/v1/products/${productB.body.data.id}/images`)
        .set('Authorization', `Bearer ${tokenB}`)
        .attach('image', Buffer.from('fake'), 'test.jpg');

      const response = await request(app)
        .get(`/api/v1/products/${productB.body.data.id}/images/${imageB.body.data.id}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
    });

    it('Tenant A cannot use Tenant B SKU in their product', async () => {
      const productB = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Product B', status: 'ACTIVE' });

      await request(app)
        .post(`/api/v1/products/${productB.body.data.id}/variants`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ sku: 'SHARED-SKU', price: '10.00' });

      const response = await request(app)
        .post(`/api/v1/products/${productAId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'SHARED-SKU', price: '20.00' });

      expect(response.status).toBe(201);
    });

    it('Manipulated tenantId in JWT cannot escalate privileges', async () => {
      const manipulatedToken = jwt.sign(
        { sub: userBId, tenantId: tenantAId, sessionId: 'fake', email: 'userb@tenant-b.com' },
        'test-access-secret-min-32-chars-long-for-testing',
        { expiresIn: '15m', issuer: 'pulseops', audience: 'pulseops-api' }
      );

      const response = await request(app)
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${manipulatedToken}`);

      expect(response.status).toBe(401);
      expect(['USER_NOT_FOUND', 'INVALID_TOKEN']).toContain(response.body.error.code);
    });
  });

  describe('Storage key isolation', () => {
    let productAId;

    beforeAll(async () => {
      const productA = await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Storage A', status: 'ACTIVE' });
      productAId = productA.body.data.id;

      await request(app)
        .post('/api/v1/products')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Storage B', status: 'ACTIVE' });
    });

    it('Product image storage key is tenant-scoped', async () => {
      const responseA = await request(app)
        .post(`/api/v1/products/${productAId}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake'), 'test.jpg');

      expect(responseA.body.data.storageKey).toContain(`tenants/${tenantAId}/`);
      expect(responseA.body.data.storageKey).not.toContain(tenantBId);
    });

    it('Variant image storage key is tenant and variant scoped', async () => {
      const variantA = await request(app)
        .post(`/api/v1/products/${productAId}/variants`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ sku: 'STORAGE-VAR-A', price: '10.00' });

      const responseA = await request(app)
        .post(`/api/v1/products/${productAId}/variants/${variantA.body.data.id}/images`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('image', Buffer.from('fake'), 'variant.jpg');

      expect(responseA.body.data.storageKey).toContain(`tenants/${tenantAId}/`);
      expect(responseA.body.data.storageKey).toContain(`variants/${variantA.body.data.id}/`);
    });
  });
});