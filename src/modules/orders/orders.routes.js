import { Router } from 'express';
import { z } from 'zod';
import { createOrder, listOrders, getOrder, updateOrderStatus, cancelOrder, getOrderHistory } from './orders.controller.js';
import { createOrderSchema, listOrdersQuerySchema, getOrderSchema, updateOrderStatusSchema, cancelOrderSchema, getOrderHistorySchema } from './orders.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    if (result.data.query) Object.assign(req.query, result.data.query);
    next();
  };
}

export const ordersRouter = Router();
ordersRouter.use(authenticate());

ordersRouter.post('/', validate(createOrderSchema), authorize('order:create'), createOrder);
ordersRouter.get('/', validate(listOrdersQuerySchema), authorize('order:read'), listOrders);
ordersRouter.get('/:id', validate(getOrderSchema), authorize('order:read'), getOrder);
ordersRouter.patch('/:id/status', validate(updateOrderStatusSchema), authorize('order:update'), updateOrderStatus);
ordersRouter.post('/:id/cancel', validate(cancelOrderSchema), authorize('order:cancel'), cancelOrder);
ordersRouter.get('/:id/history', validate(getOrderHistorySchema), authorize('order:read'), getOrderHistory);
