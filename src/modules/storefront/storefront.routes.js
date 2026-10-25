import { idempotent } from '../../common/middleware/idempotency.js';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { createAuthLimiter } from '../../common/middleware/rate-limiters.js';
import { resolveStore, authenticateCustomer } from './storefront.middleware.js';
import { refreshCookie, shopperCookie } from '../../common/http/refresh-cookie.js';
import * as c from './storefront.controller.js';
import * as v from './storefront.validation.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({ body: req.body, params: req.params, query: req.query });
    if (!result.success) return next(new z.ZodError(result.error.issues));
    if (result.data.body !== undefined) req.body = result.data.body;
    if (result.data.params !== undefined) req.params = { ...req.params, ...result.data.params };
    // Express 5 re-parses req.query on every access, so the coerced query travels on res.locals.
    res.locals.query = result.data.query ?? {};
    next();
  };
}

const authLimiter = env.NODE_ENV !== 'test' ? createAuthLimiter() : (req, res, next) => next();

/**
 * Phase 32 public commerce API. Everything is scoped to the store in the URL (tenant slug); shopper
 * tokens (`scope: "customer"`) only work for the store that issued them and nowhere in the staff API.
 */
export const storefrontRouter = Router();
storefrontRouter.get('/resolve', validate(v.resolveSchema), c.resolveHost);

const store = Router({ mergeParams: true });
storefrontRouter.use('/:store', resolveStore(), store);

store.get('/', c.getStore);
store.get('/categories', c.listCategories);
store.get('/products', validate(v.listProductsSchema), c.listProducts);
store.get('/products/:productId', validate(v.productParamsSchema), c.getProduct);

store.post('/auth/register', authLimiter, validate(v.registerSchema), c.register);
// Phase 36: optional httpOnly refresh cookie, scoped to this store's auth path
const shopCookie = (req) => shopperCookie(req.store.slug);
store.post('/auth/set-password', authLimiter, refreshCookie(shopCookie), validate(v.setPasswordSchema), c.setPassword);
store.post('/auth/login', authLimiter, refreshCookie(shopCookie), validate(v.loginSchema), c.login);
store.post('/auth/forgot-password', authLimiter, validate(v.forgotPasswordSchema), c.forgotPassword);
store.post('/auth/refresh', authLimiter, refreshCookie(shopCookie), validate(v.refreshSchema), c.refresh);
store.post('/auth/logout', refreshCookie(shopCookie, { clear: true }), validate(v.refreshSchema), c.logout);

const signedIn = authenticateCustomer();
store.get('/account', signedIn, c.getProfile);
store.patch('/account', signedIn, validate(v.updateProfileSchema), c.updateProfile);
store.get('/account/addresses', signedIn, validate(v.listAddressesSchema), c.listAddresses);
store.post('/account/addresses', signedIn, validate(v.createAddressSchema), c.createAddress);
store.patch('/account/addresses/:addressId', signedIn, validate(v.updateAddressSchema), c.updateAddress);
store.delete('/account/addresses/:addressId', signedIn, validate(v.addressParamsSchema), c.deleteAddress);
store.get('/account/orders', signedIn, validate(v.listOrdersSchema), c.listOrders);
store.get('/account/orders/:orderId', signedIn, validate(v.orderParamsSchema), c.getOrder);
store.post('/account/orders/:orderId/pay', signedIn, validate(v.orderParamsSchema), c.payOrder);
store.post('/account/payments/:paymentId/verify', signedIn, validate(v.verifyPaymentSchema), c.verifyPayment);

store.get('/cart', signedIn, c.getCart);
store.put('/cart/items/:variantId', signedIn, validate(v.setCartItemSchema), c.setCartItem);
store.delete('/cart/items/:variantId', signedIn, validate(v.cartItemParamsSchema), c.removeCartItem);
store.delete('/cart', signedIn, c.clearCart);
store.post('/checkout', signedIn, validate(v.checkoutSchema), idempotent((req) => req.store?.id), c.checkout);
