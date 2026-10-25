import { getPrismaClient } from '../../config/database.js';

const ADDRESS_ORDER = [{ type: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }];

// Storefront shoppers have a password hash; staff-facing reads must never return it.
const PRIVATE_FIELDS = { passwordHash: true };

export class CustomerRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId, tx = this.prisma) {
    return tx.customer.create({
      data: {
        tenantId,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? null,
        metadata: data.metadata ?? {},
        customerType: data.customerType ?? 'CONSUMER',
        companyName: data.companyName ?? null,
        gstin: data.gstin ?? null,
        pan: data.pan ?? (data.gstin ? data.gstin.slice(2, 12) : null),
        stateCode: data.stateCode ?? (data.gstin ? data.gstin.slice(0, 2) : null),
      },
    });
  }

  async findById(id, tenantId, tx = this.prisma) {
    return tx.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      omit: PRIVATE_FIELDS,
      include: { addresses: { orderBy: ADDRESS_ORDER } },
    });
  }

  // Active customers only: since Phase 34 a soft-deleted customer's email is free to reuse.
  async findByEmail(email, tenantId) {
    return this.prisma.customer.findFirst({ where: { email, tenantId, deletedAt: null } });
  }

  async list(tenantId, options = {}) {
    const { page = 1, limit = 20, search, sortBy = 'createdAt', sortOrder = 'desc' } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId, deletedAt: null };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({ where, omit: PRIVATE_FIELDS, orderBy: [{ [sortBy]: sortOrder }, { id: 'asc' }], skip, take }),
      this.prisma.customer.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async update(id, data, tx = this.prisma) {
    return tx.customer.update({
      where: { id },
      data: {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        metadata: data.metadata,
        customerType: data.customerType,
        companyName: data.companyName,
        gstin: data.gstin,
        pan: data.pan,
        stateCode: data.stateCode,
      },
    });
  }

  async softDelete(id, tx = this.prisma) {
    return tx.customer.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listOrders(customerId, tenantId, options = {}) {
    const { page = 1, limit = 20, status } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = { tenantId, customerId };
    if (status) where.status = status;
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          items: {
            select: { id: true, productVariantId: true, productNameSnapshot: true, variantNameSnapshot: true, skuSnapshot: true, unitPrice: true, quantity: true, lineTotal: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async listAddresses(customerId, tenantId, type) {
    const where = { tenantId, customerId };
    if (type) where.type = type;
    return this.prisma.customerAddress.findMany({ where, orderBy: ADDRESS_ORDER });
  }

  async findAddress(addressId, customerId, tenantId, tx = this.prisma) {
    return tx.customerAddress.findFirst({ where: { id: addressId, customerId, tenantId } });
  }

  async findDefaultAddress(customerId, tenantId, type, tx = this.prisma) {
    return tx.customerAddress.findFirst({ where: { tenantId, customerId, type, isDefault: true } });
  }

  async createAddress(data, customerId, tenantId, tx = this.prisma) {
    return tx.customerAddress.create({ data: { ...addressData(data), type: data.type, tenantId, customerId, isDefault: data.isDefault ?? false } });
  }

  async updateAddress(addressId, data, tx = this.prisma) {
    return tx.customerAddress.update({ where: { id: addressId }, data: { ...addressData(data), type: data.type, isDefault: data.isDefault } });
  }

  async deleteAddress(addressId, tx = this.prisma) {
    return tx.customerAddress.delete({ where: { id: addressId } });
  }

  async clearDefault(customerId, tenantId, type, tx = this.prisma) {
    return tx.customerAddress.updateMany({ where: { tenantId, customerId, type, isDefault: true }, data: { isDefault: false } });
  }

  // Keeps the invariant "a customer with addresses of a type has exactly one default of that type".
  async ensureDefault(customerId, tenantId, type, tx = this.prisma) {
    const current = await tx.customerAddress.findFirst({ where: { tenantId, customerId, type, isDefault: true }, select: { id: true } });
    if (current) return;
    const oldest = await tx.customerAddress.findFirst({ where: { tenantId, customerId, type }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (oldest) await tx.customerAddress.update({ where: { id: oldest.id }, data: { isDefault: true } });
  }
}

function addressData(data) {
  return {
    label: data.label,
    firstName: data.firstName,
    lastName: data.lastName,
    company: data.company,
    line1: data.line1,
    line2: data.line2,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    country: data.country,
    phone: data.phone,
  };
}
