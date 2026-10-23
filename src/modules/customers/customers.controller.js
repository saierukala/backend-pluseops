import { CustomerService } from './customers.service.js';

const customerService = new CustomerService();

function auditContextFrom(req) {
  return {
    userId: req.context.userId,
    ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export async function createCustomer(req, res, next) {
  try {
    const customer = await customerService.create(req.context.tenantId, req.body, auditContextFrom(req));
    res.status(201).json({ success: true, data: customer, message: 'Customer created successfully' });
  } catch (error) { next(error); }
}

export async function listCustomers(req, res, next) {
  try {
    const { page, limit, search, sortBy, sortOrder } = res.locals.query;
    const result = await customerService.list(req.context.tenantId, { page, limit, search, sortBy, sortOrder });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Customers retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getCustomer(req, res, next) {
  try {
    const customer = await customerService.getById(req.params.id, req.context.tenantId);
    res.status(200).json({ success: true, data: customer, message: 'Customer retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateCustomer(req, res, next) {
  try {
    const customer = await customerService.update(req.params.id, req.context.tenantId, req.body, auditContextFrom(req));
    res.status(200).json({ success: true, data: customer, message: 'Customer updated successfully' });
  } catch (error) { next(error); }
}

export async function deleteCustomer(req, res, next) {
  try {
    await customerService.delete(req.params.id, req.context.tenantId, auditContextFrom(req));
    res.status(200).json({ success: true, data: null, message: 'Customer deleted successfully' });
  } catch (error) { next(error); }
}

export async function listCustomerOrders(req, res, next) {
  try {
    const { page, limit, status } = res.locals.query;
    const result = await customerService.listOrders(req.params.id, req.context.tenantId, { page, limit, status });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Customer orders retrieved successfully' });
  } catch (error) { next(error); }
}

export async function listAddresses(req, res, next) {
  try {
    const addresses = await customerService.listAddresses(req.params.id, req.context.tenantId, res.locals.query.type);
    res.status(200).json({ success: true, data: addresses, message: 'Addresses retrieved successfully' });
  } catch (error) { next(error); }
}

export async function createAddress(req, res, next) {
  try {
    const address = await customerService.createAddress(req.params.id, req.context.tenantId, req.body, auditContextFrom(req));
    res.status(201).json({ success: true, data: address, message: 'Address created successfully' });
  } catch (error) { next(error); }
}

export async function updateAddress(req, res, next) {
  try {
    const { id, addressId } = req.params;
    const address = await customerService.updateAddress(id, addressId, req.context.tenantId, req.body, auditContextFrom(req));
    res.status(200).json({ success: true, data: address, message: 'Address updated successfully' });
  } catch (error) { next(error); }
}

export async function deleteAddress(req, res, next) {
  try {
    const { id, addressId } = req.params;
    await customerService.deleteAddress(id, addressId, req.context.tenantId, auditContextFrom(req));
    res.status(200).json({ success: true, data: null, message: 'Address deleted successfully' });
  } catch (error) { next(error); }
}
