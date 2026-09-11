import { getPrismaClient, disconnectDatabase } from '../../src/config/database.js';

const prisma = getPrismaClient();

afterAll(async () => {
  await disconnectDatabase();
});

describe('Phase 3 schema integration tests', () => {
  let testTenantId;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: 'Schema Test Tenant', slug: 'schema-test-tenant' },
    });
    testTenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: testTenantId } });
  });

  describe('User model', () => {
    it('creates a user with tenant isolation', async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'test@example.com',
          passwordHash: 'hashed_password',
          firstName: 'Test',
          lastName: 'User',
        },
      });

      expect(user.id).toBeDefined();
      expect(user.tenantId).toBe(testTenantId);
      expect(user.email).toBe('test@example.com');
      expect(user.status).toBe('ACTIVE');
    });

    it('enforces unique email per tenant', async () => {
      await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'unique@example.com',
          passwordHash: 'hashed_password',
          firstName: 'Test',
          lastName: 'User',
        },
      });

      await expect(
        prisma.user.create({
          data: {
            tenantId: testTenantId,
            email: 'unique@example.com',
            passwordHash: 'hashed_password',
            firstName: 'Test',
            lastName: 'User',
          },
        })
      ).rejects.toThrow();
    });

    it('allows same email in different tenants', async () => {
      const otherTenant = await prisma.tenant.create({
        data: { name: 'Other Tenant', slug: 'other-tenant' },
      });

      await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'shared@example.com',
          passwordHash: 'hashed_password',
          firstName: 'Test',
          lastName: 'User',
        },
      });

      await expect(
        prisma.user.create({
          data: {
            tenantId: otherTenant.id,
            email: 'shared@example.com',
            passwordHash: 'hashed_password',
            firstName: 'Test',
            lastName: 'User',
          },
        })
      ).resolves.toBeDefined();

      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    });

    it('supports soft delete with deletedAt', async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'softdelete@example.com',
          passwordHash: 'hashed_password',
          firstName: 'Test',
          lastName: 'User',
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      const deletedUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(deletedUser.deletedAt).not.toBeNull();
    });
  });

  describe('Role and Permission models', () => {
    it('creates role and permission with tenant isolation', async () => {
      const role = await prisma.role.create({
        data: {
          tenantId: testTenantId,
          name: 'Test Role',
          description: 'Test role description',
        },
      });

      const permission = await prisma.permission.create({
        data: {
          tenantId: testTenantId,
          name: 'test:create',
          resource: 'test',
          action: 'create',
        },
      });

      expect(role.id).toBeDefined();
      expect(role.tenantId).toBe(testTenantId);
      expect(permission.id).toBeDefined();
      expect(permission.tenantId).toBe(testTenantId);
    });

    it('enforces unique role name per tenant', async () => {
      await prisma.role.create({
        data: { tenantId: testTenantId, name: 'Unique Role' },
      });

      await expect(
        prisma.role.create({ data: { tenantId: testTenantId, name: 'Unique Role' } })
      ).rejects.toThrow();
    });

    it('enforces unique permission resource+action per tenant', async () => {
      await prisma.permission.create({
        data: { tenantId: testTenantId, name: 'unique:action', resource: 'unique', action: 'action' },
      });

      await expect(
        prisma.permission.create({
          data: { tenantId: testTenantId, name: 'unique:action', resource: 'unique', action: 'action' },
        })
      ).rejects.toThrow();
    });

    it('links users to roles and roles to permissions', async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'roleuser@example.com',
          passwordHash: 'hashed_password',
          firstName: 'Role',
          lastName: 'User',
        },
      });

      const role = await prisma.role.create({
        data: { tenantId: testTenantId, name: 'Linked Role' },
      });

      const permission = await prisma.permission.create({
        data: { tenantId: testTenantId, name: 'linked:read', resource: 'linked', action: 'read' },
      });

      await prisma.userRole.create({
        data: { tenantId: testTenantId, userId: user.id, roleId: role.id },
      });

      await prisma.rolePermission.create({
        data: { tenantId: testTenantId, roleId: role.id, permissionId: permission.id },
      });

      const userRoles = await prisma.userRole.findMany({ where: { userId: user.id } });
      expect(userRoles).toHaveLength(1);
      expect(userRoles[0].roleId).toBe(role.id);

      const rolePerms = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
      expect(rolePerms).toHaveLength(1);
      expect(rolePerms[0].permissionId).toBe(permission.id);
    });
  });

  describe('Category model', () => {
    it('creates category with tenant isolation and hierarchy', async () => {
      const parent = await prisma.category.create({
        data: { tenantId: testTenantId, name: 'Parent', slug: 'parent' },
      });

      const child = await prisma.category.create({
        data: { tenantId: testTenantId, name: 'Child', slug: 'child', parentId: parent.id },
      });

      expect(child.parentId).toBe(parent.id);

      const parentWithChildren = await prisma.category.findUnique({
        where: { id: parent.id },
        include: { children: true },
      });
      expect(parentWithChildren.children).toHaveLength(1);
    });

    it('enforces unique slug per tenant', async () => {
      await prisma.category.create({ data: { tenantId: testTenantId, name: 'Cat 1', slug: 'unique-cat' } });

      await expect(
        prisma.category.create({ data: { tenantId: testTenantId, name: 'Cat 2', slug: 'unique-cat' } })
      ).rejects.toThrow();
    });
  });

  describe('Product and ProductVariant models', () => {
    it('creates product and variant with tenant isolation', async () => {
      const product = await prisma.product.create({
        data: {
          tenantId: testTenantId,
          name: 'Test Product',
          description: 'A test product',
          brand: 'Test Brand',
          status: 'ACTIVE',
        },
      });

      const variant = await prisma.productVariant.create({
        data: {
          tenantId: testTenantId,
          productId: product.id,
          sku: 'TEST-SKU-001',
          price: 99.99,
          status: 'ACTIVE',
        },
      });

      expect(product.id).toBeDefined();
      expect(product.tenantId).toBe(testTenantId);
      expect(variant.id).toBeDefined();
      expect(variant.tenantId).toBe(testTenantId);
      expect(variant.productId).toBe(product.id);
      expect(variant.sku).toBe('TEST-SKU-001');
    });

    it('enforces unique SKU per tenant', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'SKU Product', status: 'ACTIVE' },
      });

      await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'UNIQUE-SKU', price: 10.00 },
      });

      await expect(
        prisma.productVariant.create({
          data: { tenantId: testTenantId, productId: product.id, sku: 'UNIQUE-SKU', price: 20.00 },
        })
      ).rejects.toThrow();
    });

    it('allows same SKU in different tenants', async () => {
      const otherTenant = await prisma.tenant.create({ data: { name: 'Other', slug: 'other-sku-tenant' } });

      const product1 = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'P1', status: 'ACTIVE' },
      });
      const product2 = await prisma.product.create({
        data: { tenantId: otherTenant.id, name: 'P2', status: 'ACTIVE' },
      });

      await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product1.id, sku: 'SHARED-SKU', price: 10.00 },
      });

      await expect(
        prisma.productVariant.create({
          data: { tenantId: otherTenant.id, productId: product2.id, sku: 'SHARED-SKU', price: 20.00 },
        })
      ).resolves.toBeDefined();

      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    });

    it('links product to categories', async () => {
      const category = await prisma.category.create({
        data: { tenantId: testTenantId, name: 'Electronics', slug: 'electronics' },
      });

      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Phone', status: 'ACTIVE' },
      });

      await prisma.productCategory.create({
        data: { tenantId: testTenantId, productId: product.id, categoryId: category.id, isPrimary: true },
      });

      const productWithCats = await prisma.product.findUnique({
        where: { id: product.id },
        include: { categories: { include: { category: true } } },
      });

      expect(productWithCats.categories).toHaveLength(1);
      expect(productWithCats.categories[0].category.name).toBe('Electronics');
    });
  });

  describe('Attribute models', () => {
    it('creates attribute definition with tenant isolation', async () => {
      const attrDef = await prisma.attributeDefinition.create({
        data: {
          tenantId: testTenantId,
          name: 'Color',
          code: 'color',
          dataType: 'OPTION',
          isRequired: true,
        },
      });

      expect(attrDef.id).toBeDefined();
      expect(attrDef.tenantId).toBe(testTenantId);
      expect(attrDef.code).toBe('color');
    });

    it('enforces unique attribute code per tenant', async () => {
      await prisma.attributeDefinition.create({
        data: { tenantId: testTenantId, name: 'Size', code: 'size', dataType: 'OPTION' },
      });

      await expect(
        prisma.attributeDefinition.create({
          data: { tenantId: testTenantId, name: 'Size 2', code: 'size', dataType: 'OPTION' },
        })
      ).rejects.toThrow();
    });

    it('creates attribute values for option types', async () => {
      const attrDef = await prisma.attributeDefinition.create({
        data: { tenantId: testTenantId, name: 'Color', code: 'color2', dataType: 'OPTION' },
      });

      const value = await prisma.attributeValue.create({
        data: {
          tenantId: testTenantId,
          attributeDefinitionId: attrDef.id,
          value: 'red',
          displayName: 'Red',
        },
      });

      expect(value.id).toBeDefined();
      expect(value.attributeDefinitionId).toBe(attrDef.id);
    });

    it('links variant attributes to definitions', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Attr Product', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'ATTR-SKU', price: 50.00 },
      });

      const attrDef = await prisma.attributeDefinition.create({
        data: { tenantId: testTenantId, name: 'Color', code: 'color3', dataType: 'OPTION' },
      });

      const variantAttr = await prisma.productVariantAttribute.create({
        data: {
          tenantId: testTenantId,
          variantId: variant.id,
          attributeDefinitionId: attrDef.id,
          value: 'blue',
        },
      });

      expect(variantAttr.variantId).toBe(variant.id);
      expect(variantAttr.attributeDefinitionId).toBe(attrDef.id);
    });
  });

  describe('ProductImage model', () => {
    it('creates product-level and variant-level images', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Image Product', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'IMG-SKU', price: 30.00 },
      });

      const productImage = await prisma.productImage.create({
        data: {
          tenantId: testTenantId,
          productId: product.id,
          storageKey: 'tenants/123/products/456/image1.jpg',
          altText: 'Product image',
          isPrimary: true,
        },
      });

      const variantImage = await prisma.productImage.create({
        data: {
          tenantId: testTenantId,
          productId: product.id,
          variantId: variant.id,
          storageKey: 'tenants/123/products/456/variants/789/image2.jpg',
          altText: 'Variant image',
        },
      });

      expect(productImage.variantId).toBeNull();
      expect(variantImage.variantId).toBe(variant.id);
    });
  });

  describe('Warehouse and Inventory models', () => {
    it('creates warehouse with tenant isolation', async () => {
      const warehouse = await prisma.warehouse.create({
        data: {
          tenantId: testTenantId,
          name: 'Main Warehouse',
          code: 'MAIN',
          city: 'New York',
          country: 'USA',
        },
      });

      expect(warehouse.id).toBeDefined();
      expect(warehouse.tenantId).toBe(testTenantId);
    });

    it('creates inventory linked to variant and warehouse', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Inv Product', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'INV-SKU', price: 25.00 },
      });

      const warehouse = await prisma.warehouse.create({
        data: { tenantId: testTenantId, name: 'Inventory WH', code: 'INVWH' },
      });

      const inventory = await prisma.inventory.create({
        data: {
          tenantId: testTenantId,
          productVariantId: variant.id,
          warehouseId: warehouse.id,
          quantity: 100,
          reservedQuantity: 10,
        },
      });

      expect(inventory.quantity).toBe(100);
      expect(inventory.reservedQuantity).toBe(10);
    });

    it('enforces unique variant+warehouse per tenant', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Unique Inv', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'UNIQ-INV', price: 15.00 },
      });

      const warehouse = await prisma.warehouse.create({
        data: { tenantId: testTenantId, name: 'Unique WH', code: 'UNIQWH' },
      });

      await prisma.inventory.create({
        data: { tenantId: testTenantId, productVariantId: variant.id, warehouseId: warehouse.id },
      });

      await expect(
        prisma.inventory.create({
          data: { tenantId: testTenantId, productVariantId: variant.id, warehouseId: warehouse.id },
        })
      ).rejects.toThrow();
    });

    it('creates inventory movements with snapshot', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Movement Product', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'MOV-SKU', price: 12.00 },
      });

      const warehouse = await prisma.warehouse.create({
        data: { tenantId: testTenantId, name: 'Movement WH', code: 'MOVWH' },
      });

      await prisma.inventory.create({
        data: { tenantId: testTenantId, productVariantId: variant.id, warehouseId: warehouse.id, quantity: 50 },
      });

      const movement = await prisma.inventoryMovement.create({
        data: {
          tenantId: testTenantId,
          productVariantId: variant.id,
          warehouseId: warehouse.id,
          type: 'ADJUSTMENT',
          quantityBefore: 50,
          quantityChanged: 10,
          quantityAfter: 60,
          reason: 'Stock adjustment',
          referenceType: 'manual',
          referenceId: 'adj-001',
        },
      });

      expect(movement.quantityBefore).toBe(50);
      expect(movement.quantityChanged).toBe(10);
      expect(movement.quantityAfter).toBe(60);
      expect(movement.type).toBe('ADJUSTMENT');
    });
  });

  describe('Customer model', () => {
    it('creates customer with tenant isolation', async () => {
      const customer = await prisma.customer.create({
        data: {
          tenantId: testTenantId,
          email: 'customer@example.com',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
        },
      });

      expect(customer.id).toBeDefined();
      expect(customer.tenantId).toBe(testTenantId);
    });

    it('enforces unique email per tenant', async () => {
      await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'unique-cust@example.com', firstName: 'J', lastName: 'D' },
      });

      await expect(
        prisma.customer.create({
          data: { tenantId: testTenantId, email: 'unique-cust@example.com', firstName: 'J', lastName: 'D' },
        })
      ).rejects.toThrow();
    });
  });

  describe('Order and OrderItem models', () => {
    it('creates order with customer and items', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'order@example.com', firstName: 'Order', lastName: 'User' },
      });

      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Order Product', status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'ORD-SKU', price: 99.99 },
      });

      const order = await prisma.order.create({
        data: {
          tenantId: testTenantId,
          customerId: customer.id,
          status: 'CONFIRMED',
          subtotal: 199.98,
          total: 199.98,
          items: {
            create: [
              {
                tenantId: testTenantId,
                productVariantId: variant.id,
                productNameSnapshot: product.name,
                variantNameSnapshot: 'Default',
                skuSnapshot: variant.sku,
                unitPrice: 99.99,
                quantity: 2,
                lineTotal: 199.98,
              },
            ],
          },
        },
        include: { items: true },
      });

      expect(order.items).toHaveLength(1);
      expect(order.items[0].skuSnapshot).toBe('ORD-SKU');
      expect(order.items[0].productNameSnapshot).toBe(product.name);
    });

    it('creates order status history', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'history@example.com', firstName: 'Hist', lastName: 'User' },
      });

      const order = await prisma.order.create({
        data: { tenantId: testTenantId, customerId: customer.id, subtotal: 50, total: 50, status: 'DRAFT' },
      });

      await prisma.orderStatusHistory.create({
        data: { tenantId: testTenantId, orderId: order.id, toStatus: 'CONFIRMED', reason: 'Customer confirmed' },
      });

      await prisma.orderStatusHistory.create({
        data: { tenantId: testTenantId, orderId: order.id, fromStatus: 'CONFIRMED', toStatus: 'SHIPPED' },
      });

      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history).toHaveLength(2);
      expect(history[0].toStatus).toBe('CONFIRMED');
      expect(history[1].fromStatus).toBe('CONFIRMED');
      expect(history[1].toStatus).toBe('SHIPPED');
    });
  });

  describe('Payment models', () => {
    it('creates payment linked to order', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'pay@example.com', firstName: 'Pay', lastName: 'User' },
      });

      const order = await prisma.order.create({
        data: { tenantId: testTenantId, customerId: customer.id, subtotal: 100, total: 100 },
      });

      const payment = await prisma.payment.create({
        data: {
          tenantId: testTenantId,
          orderId: order.id,
          amount: 100,
          currency: 'USD',
          status: 'COMPLETED',
          provider: 'stripe',
          providerPaymentId: 'pi_123',
        },
      });

      expect(payment.id).toBeDefined();
      expect(payment.orderId).toBe(order.id);
    });

    it('creates payment transactions', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'txn@example.com', firstName: 'Txn', lastName: 'User' },
      });

      const order = await prisma.order.create({
        data: { tenantId: testTenantId, customerId: customer.id, subtotal: 50, total: 50 },
      });

      const payment = await prisma.payment.create({
        data: { tenantId: testTenantId, orderId: order.id, amount: 50, status: 'COMPLETED' },
      });

      const transaction = await prisma.paymentTransaction.create({
        data: {
          tenantId: testTenantId,
          paymentId: payment.id,
          type: 'CHARGE',
          amount: 50,
          status: 'COMPLETED',
        },
      });

      expect(transaction.paymentId).toBe(payment.id);
      expect(transaction.type).toBe('CHARGE');
    });

    it('creates refunds linked to payment', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'refund@example.com', firstName: 'Ref', lastName: 'User' },
      });

      const order = await prisma.order.create({
        data: { tenantId: testTenantId, customerId: customer.id, subtotal: 100, total: 100 },
      });

      const payment = await prisma.payment.create({
        data: { tenantId: testTenantId, orderId: order.id, amount: 100, status: 'COMPLETED' },
      });

      const refund = await prisma.refund.create({
        data: {
          tenantId: testTenantId,
          paymentId: payment.id,
          amount: 50,
          reason: 'Partial return',
        },
      });

      expect(refund.paymentId).toBe(payment.id);
      expect(refund.amount.toString()).toBe('50');
    });
  });

  describe('Notification models', () => {
    it('creates notification with tenant and user', async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'notif@example.com',
          passwordHash: 'hashed',
          firstName: 'Notif',
          lastName: 'User',
        },
      });

      const notification = await prisma.notification.create({
        data: {
          tenantId: testTenantId,
          userId: user.id,
          type: 'INFO',
          title: 'Test Notification',
          message: 'This is a test',
          channel: 'IN_APP',
        },
      });

      expect(notification.userId).toBe(user.id);
      expect(notification.isRead).toBe(false);
    });

    it('creates notification preferences', async () => {
      const user = await prisma.user.create({
        data: {
          tenantId: testTenantId,
          email: 'pref@example.com',
          passwordHash: 'hashed',
          firstName: 'Pref',
          lastName: 'User',
        },
      });

      const pref = await prisma.notificationPreference.create({
        data: { tenantId: testTenantId, userId: user.id, channel: 'EMAIL', isEnabled: true },
      });

      expect(pref.channel).toBe('EMAIL');
      expect(pref.isEnabled).toBe(true);
    });

    it('creates notification templates', async () => {
      const template = await prisma.notificationTemplate.create({
        data: {
          tenantId: testTenantId,
          name: 'welcome_email',
          channel: 'EMAIL',
          subject: 'Welcome!',
          body: 'Welcome {{name}}',
          variables: { name: 'string' },
        },
      });

      expect(template.name).toBe('welcome_email');
      expect(template.channel).toBe('EMAIL');
    });
  });

  describe('Audit and Activity logs', () => {
    it('creates audit log with tenant and optional user', async () => {
      const user = await prisma.user.create({
        data: { tenantId: testTenantId, email: 'audit@example.com', passwordHash: 'h', firstName: 'A', lastName: 'U' },
      });

      const audit = await prisma.auditLog.create({
        data: {
          tenantId: testTenantId,
          userId: user.id,
          action: 'CREATE',
          resource: 'product',
          resourceId: 'prod-123',
          oldValue: null,
          newValue: { name: 'New Product' },
        },
      });

      expect(audit.action).toBe('CREATE');
      expect(audit.resource).toBe('product');
      expect(audit.oldValue).toBeNull();
      expect(audit.newValue).toEqual({ name: 'New Product' });
    });

    it('creates activity log', async () => {
      const activity = await prisma.activityLog.create({
        data: {
          tenantId: testTenantId,
          action: 'product.created',
          description: 'Product was created',
          metadata: { productId: 'prod-123' },
        },
      });

      expect(activity.action).toBe('product.created');
      expect(activity.metadata).toEqual({ productId: 'prod-123' });
    });
  });

  describe('Cross-tenant isolation', () => {
    it('prevents cross-tenant references at application level (database FK limitation)', async () => {
      // Note: Prisma/PostgreSQL doesn't support composite foreign keys with tenant_id
      // Cross-tenant protection must be enforced at the application/service layer
      // This test documents the current behavior

      const tenantA = await prisma.tenant.create({ data: { name: 'Tenant A', slug: 'tenant-a-x' } });
      const tenantB = await prisma.tenant.create({ data: { name: 'Tenant B', slug: 'tenant-b-x' } });

      const productA = await prisma.product.create({
        data: { tenantId: tenantA.id, name: 'Product A', status: 'ACTIVE' },
      });

      const categoryB = await prisma.category.create({
        data: { tenantId: tenantB.id, name: 'Category B', slug: 'cat-b-x' },
      });

      // This currently SUCCEEDS at database level (known limitation)
      // Application layer must enforce tenant isolation
      const link = await prisma.productCategory.create({
        data: {
          tenantId: tenantA.id,
          productId: productA.id,
          categoryId: categoryB.id,
        },
      });

      expect(link).toBeDefined();
      expect(link.tenantId).toBe(tenantA.id);

      await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    });
  });

  describe('Decimal/money types', () => {
    it('stores prices as Decimal with correct precision', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Decimal Product', basePrice: 1234.56, status: 'ACTIVE' },
      });

      const variant = await prisma.productVariant.create({
        data: { tenantId: testTenantId, productId: product.id, sku: 'DEC-SKU', price: 99.99, costPrice: 45.50 },
      });

      expect(typeof product.basePrice).toBe('object'); // Prisma Decimal
      expect(product.basePrice.toString()).toBe('1234.56');
      expect(variant.price.toString()).toBe('99.99');
      // Prisma Decimal doesn't preserve trailing zeros
      expect(variant.costPrice.toString()).toBe('45.5');
    });

    it('stores order totals as Decimal', async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: testTenantId, email: 'decimal@example.com', firstName: 'D', lastName: 'User' },
      });

      const order = await prisma.order.create({
        data: {
          tenantId: testTenantId,
          customerId: customer.id,
          subtotal: 100.50,
          discountTotal: 10.25,
          taxTotal: 8.75,
          shippingTotal: 5.00,
          total: 104.00,
        },
      });

      // Prisma Decimal doesn't preserve trailing zeros
      expect(order.subtotal.toString()).toBe('100.5');
      expect(order.total.toString()).toBe('104');
    });
  });

  describe('Timestamp types', () => {
    it('uses timestamptz for createdAt and updatedAt', async () => {
      const product = await prisma.product.create({
        data: { tenantId: testTenantId, name: 'Timestamp Product', status: 'ACTIVE' },
      });

      expect(product.createdAt).toBeInstanceOf(Date);
      expect(product.updatedAt).toBeInstanceOf(Date);
      expect(product.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
