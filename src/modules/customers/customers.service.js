import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { CustomerRepository } from './customers.repository.js';
import { auditService } from '../audit/audit.service.js';

const SNAPSHOT_FIELDS = ['type', 'label', 'firstName', 'lastName', 'company', 'line1', 'line2', 'city', 'state', 'postalCode', 'country', 'phone'];

// Immutable copy of an address stored on an order; later edits to the address don't change the order.
export function toAddressSnapshot(address) {
  if (!address) return null;
  const snapshot = { addressId: address.id };
  for (const field of SNAPSHOT_FIELDS) snapshot[field] = address[field] ?? null;
  return snapshot;
}

function isUniqueViolation(err) {
  return err?.code === 'P2002';
}

const emailExists = () => new AppError('A customer with this email already exists', { statusCode: 409, code: 'CUSTOMER_EMAIL_EXISTS' });
const customerNotFound = () => new AppError('Customer not found', { statusCode: 404, code: 'CUSTOMER_NOT_FOUND' });
const addressNotFound = () => new AppError('Address not found', { statusCode: 404, code: 'ADDRESS_NOT_FOUND' });

export class CustomerService {
  constructor() {
    this.repository = new CustomerRepository();
    this.prisma = getPrismaClient();
  }

  async log(tx, auditContext, { tenantId, action, resource, resourceId, oldValue, newValue, activity, description }) {
    const { userId = null, ipAddress = null, userAgent = null } = auditContext;
    await auditService.logAudit({ tenantId, userId, action, resource, resourceId, oldValue, newValue, ipAddress, userAgent, tx });
    await auditService.logActivity({ tenantId, userId, action: activity, description, metadata: { resourceId }, ipAddress, userAgent, tx });
  }

  async create(tenantId, data, auditContext = {}) {
    if (await this.repository.findByEmail(data.email, tenantId)) throw emailExists();
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const customer = await this.repository.create(data, tenantId, tx);
        for (const address of data.addresses || []) {
          await this.addAddress(tx, customer.id, tenantId, address);
        }
        await this.log(tx, auditContext, {
          tenantId, action: 'CREATE', resource: 'customer', resourceId: customer.id,
          oldValue: null, newValue: { email: customer.email, firstName: customer.firstName, lastName: customer.lastName },
          activity: 'customer.create', description: `Customer ${customer.id} created`,
        });
        return customer.id;
      });
      return this.getById(id, tenantId);
    } catch (err) {
      if (isUniqueViolation(err)) throw emailExists();
      throw err;
    }
  }

  async getById(id, tenantId) {
    const customer = await this.repository.findById(id, tenantId);
    if (!customer) throw customerNotFound();
    return customer;
  }

  async list(tenantId, options) {
    return this.repository.list(tenantId, options);
  }

  async update(id, tenantId, data, auditContext = {}) {
    const existing = await this.getById(id, tenantId);
    if (data.email && data.email !== existing.email && await this.repository.findByEmail(data.email, tenantId)) throw emailExists();
    const oldValue = {};
    for (const key of Object.keys(data)) oldValue[key] = existing[key];
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.repository.update(id, data, tx);
        await this.log(tx, auditContext, {
          tenantId, action: 'UPDATE', resource: 'customer', resourceId: id, oldValue, newValue: data,
          activity: 'customer.update', description: `Customer ${id} updated`,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw emailExists();
      throw err;
    }
    return this.getById(id, tenantId);
  }

  // Soft delete: orders keep referencing the customer; the email becomes available again.
  async delete(id, tenantId, auditContext = {}) {
    const existing = await this.getById(id, tenantId);
    await this.prisma.$transaction(async (tx) => {
      await this.repository.softDelete(id, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'DELETE', resource: 'customer', resourceId: id,
        oldValue: { email: existing.email, firstName: existing.firstName, lastName: existing.lastName }, newValue: null,
        activity: 'customer.delete', description: `Customer ${id} deleted`,
      });
    });
  }

  async listOrders(id, tenantId, options) {
    await this.getById(id, tenantId);
    return this.repository.listOrders(id, tenantId, options);
  }

  async listAddresses(id, tenantId, type) {
    await this.getById(id, tenantId);
    return this.repository.listAddresses(id, tenantId, type);
  }

  async createAddress(id, tenantId, data, auditContext = {}) {
    await this.getById(id, tenantId);
    return this.prisma.$transaction(async (tx) => {
      const address = await this.addAddress(tx, id, tenantId, data);
      await this.log(tx, auditContext, {
        tenantId, action: 'CREATE', resource: 'customer_address', resourceId: address.id, oldValue: null, newValue: toAddressSnapshot(address),
        activity: 'customer.address.create', description: `Address ${address.id} added to customer ${id}`,
      });
      return address;
    });
  }

  async updateAddress(id, addressId, tenantId, data, auditContext = {}) {
    await this.getById(id, tenantId);
    const existing = await this.repository.findAddress(addressId, id, tenantId);
    if (!existing) throw addressNotFound();
    const type = data.type ?? existing.type;
    return this.prisma.$transaction(async (tx) => {
      if (data.isDefault === true) await this.repository.clearDefault(id, tenantId, type, tx);
      await this.repository.updateAddress(addressId, data, tx);
      await this.repository.ensureDefault(id, tenantId, existing.type, tx);
      if (type !== existing.type) await this.repository.ensureDefault(id, tenantId, type, tx);
      const updated = await this.repository.findAddress(addressId, id, tenantId, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'UPDATE', resource: 'customer_address', resourceId: addressId,
        oldValue: toAddressSnapshot(existing), newValue: toAddressSnapshot(updated),
        activity: 'customer.address.update', description: `Address ${addressId} of customer ${id} updated`,
      });
      return updated;
    });
  }

  async deleteAddress(id, addressId, tenantId, auditContext = {}) {
    await this.getById(id, tenantId);
    const existing = await this.repository.findAddress(addressId, id, tenantId);
    if (!existing) throw addressNotFound();
    await this.prisma.$transaction(async (tx) => {
      await this.repository.deleteAddress(addressId, tx);
      await this.repository.ensureDefault(id, tenantId, existing.type, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'DELETE', resource: 'customer_address', resourceId: addressId, oldValue: toAddressSnapshot(existing), newValue: null,
        activity: 'customer.address.delete', description: `Address ${addressId} removed from customer ${id}`,
      });
    });
  }

  // The first address of a type becomes the default; isDefault: true moves the default to this one.
  async addAddress(tx, customerId, tenantId, data) {
    if (data.isDefault) await this.repository.clearDefault(customerId, tenantId, data.type, tx);
    const address = await this.repository.createAddress(data, customerId, tenantId, tx);
    await this.repository.ensureDefault(customerId, tenantId, data.type, tx);
    return this.repository.findAddress(address.id, customerId, tenantId, tx);
  }

  // Resolves the address an order should snapshot: the given one (must belong to the customer and match
  // the type), else the customer's default of that type, else null.
  async resolveOrderAddress(customerId, tenantId, type, addressId) {
    if (!addressId) return this.repository.findDefaultAddress(customerId, tenantId, type);
    const address = await this.repository.findAddress(addressId, customerId, tenantId);
    if (!address) throw addressNotFound();
    if (address.type !== type) {
      throw new AppError(`Address ${addressId} is a ${address.type} address, expected ${type}`, { statusCode: 400, code: 'ADDRESS_TYPE_MISMATCH' });
    }
    return address;
  }
}
