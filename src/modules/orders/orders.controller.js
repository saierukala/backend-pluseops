import { OrderService } from './orders.service.js';

const orderService = new OrderService();

function auditContextFrom(req) {
  return {
    ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export async function createOrder(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const order = await orderService.create(tenantId, userId, req.body, auditContextFrom(req));
    res.status(201).json({ success: true, data: order, message: 'Order created successfully' });
  } catch (error) { next(error); }
}

export async function listOrders(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, status, customerId, sortBy, sortOrder } = req.query;
    const result = await orderService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      customerId,
      sortBy,
      sortOrder,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Orders retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getOrder(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const order = await orderService.getById(id, tenantId);
    res.status(200).json({ success: true, data: order, message: 'Order retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateOrderStatus(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { id } = req.params;
    const { status, reason } = req.body;
    const order = await orderService.updateStatus(id, tenantId, userId, status, reason, auditContextFrom(req));
    res.status(200).json({ success: true, data: order, message: 'Order status updated successfully' });
  } catch (error) { next(error); }
}

export async function cancelOrder(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { id } = req.params;
    const reason = req.body?.reason || null;
    const order = await orderService.cancel(id, tenantId, userId, reason, auditContextFrom(req));
    res.status(200).json({ success: true, data: order, message: 'Order cancelled successfully' });
  } catch (error) { next(error); }
}

export async function getOrderHistory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const { page, limit } = req.query;
    const result = await orderService.getHistory(id, tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Order history retrieved successfully' });
  } catch (error) { next(error); }
}
