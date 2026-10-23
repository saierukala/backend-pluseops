import { Router } from 'express';
import { z } from 'zod';
import {
  createCustomer, listCustomers, getCustomer, updateCustomer, deleteCustomer, listCustomerOrders,
  listAddresses, createAddress, updateAddress, deleteAddress,
} from './customers.controller.js';
import {
  createCustomerSchema, listCustomersQuerySchema, getCustomerSchema, updateCustomerSchema, deleteCustomerSchema,
  listCustomerOrdersSchema, listAddressesSchema, createAddressSchema, updateAddressSchema, deleteAddressSchema,
} from './customers.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    req.body = result.data.body;
    req.params = result.data.params;
    // Express 5 re-parses req.query on every access, so the coerced query travels on res.locals.
    res.locals.query = result.data.query ?? {};
    next();
  };
}

export const customersRouter = Router();
customersRouter.use(authenticate());

customersRouter.post('/', validate(createCustomerSchema), authorize('customer:create'), createCustomer);
customersRouter.get('/', validate(listCustomersQuerySchema), authorize('customer:read'), listCustomers);
customersRouter.get('/:id', validate(getCustomerSchema), authorize('customer:read'), getCustomer);
customersRouter.patch('/:id', validate(updateCustomerSchema), authorize('customer:update'), updateCustomer);
customersRouter.delete('/:id', validate(deleteCustomerSchema), authorize('customer:delete'), deleteCustomer);
// Order history exposes order data, so it needs order:read as well.
customersRouter.get('/:id/orders', validate(listCustomerOrdersSchema), authorize('customer:read'), authorize('order:read'), listCustomerOrders);

customersRouter.get('/:id/addresses', validate(listAddressesSchema), authorize('customer:read'), listAddresses);
customersRouter.post('/:id/addresses', validate(createAddressSchema), authorize('customer:update'), createAddress);
customersRouter.patch('/:id/addresses/:addressId', validate(updateAddressSchema), authorize('customer:update'), updateAddress);
customersRouter.delete('/:id/addresses/:addressId', validate(deleteAddressSchema), authorize('customer:update'), deleteAddress);
