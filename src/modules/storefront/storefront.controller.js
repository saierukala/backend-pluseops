import { AppError } from '../../common/errors/app-error.js';
import { getPrismaClient } from '../../config/database.js';
import { env } from '../../config/env.js';
import { domainName } from '../workspace/workspace.validation.js';
import { CustomerService } from '../customers/customers.service.js';
import { findOpenStore } from './storefront.middleware.js';
import * as catalog from './storefront.catalog.js';
import { storefrontAuthService as auth } from './storefront.auth.js';
import * as shop from './storefront.shop.js';

const customers = new CustomerService();
const ok = (res, data, message, status = 200, extra = {}) => res.status(status).json({ success: true, data, ...extra, message });
const client = (req) => ({ ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null });
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (error) { next(error); }
};

function storeInfo(store) {
  const { currency, locale, timezone, contactEmail, contactPhone } = { ...store.settings, currency: store.currency };
  // GST rate lets the shop preview tax in the cart; the order total is still computed server-side at checkout
  return { slug: store.slug, name: store.name, currency, locale, timezone, contactEmail, contactPhone, gstRatePercent: store.gstRatePercent };
}

// Host → store, for a storefront app serving several businesses: a verified custom domain, or
// <slug>.<STOREFRONT_BASE_DOMAIN> when that is configured. Unverified domains never resolve.
export const resolveHost = handle(async (req, res) => {
  const parsed = domainName.safeParse(res.locals.query.host.split(':')[0]);
  let store = null;
  if (parsed.success) {
    const host = parsed.data;
    const base = env.STOREFRONT_BASE_DOMAIN?.toLowerCase();
    if (base && host.endsWith(`.${base}`) && !host.slice(0, -(base.length + 1)).includes('.')) {
      store = await findOpenStore({ slug: host.slice(0, -(base.length + 1)) });
    } else {
      const domain = await getPrismaClient().tenantDomain.findFirst({ where: { domain: host, verified: true }, select: { tenantId: true } });
      if (domain) store = await findOpenStore({ id: domain.tenantId });
    }
  }
  if (!store) throw new AppError('Store not found', { statusCode: 404, code: 'STORE_NOT_FOUND' });
  ok(res, storeInfo(store), 'Store resolved');
});

export const getStore = handle(async (req, res) => ok(res, { ...storeInfo(req.store), onlinePayment: await shop.onlinePaymentInfo(req.store) }, 'Store retrieved'));
export const listCategories = handle(async (req, res) => ok(res, await catalog.listCategories(req.store.id), 'Categories retrieved'));
export const listProducts = handle(async (req, res) => {
  const result = await catalog.listProducts(req.store, res.locals.query);
  ok(res, result.data, 'Products retrieved', 200, { meta: result.meta });
});
export const getProduct = handle(async (req, res) => ok(res, await catalog.getProduct(req.store, req.params.productId), 'Product retrieved'));

export const register = handle(async (req, res) => ok(res, await auth.register(req.store, req.body), 'Registration received', 202));
export const forgotPassword = handle(async (req, res) => ok(res, await auth.forgotPassword(req.store, req.body), 'Request received', 202));
export const setPassword = handle(async (req, res) => ok(res, await auth.setPassword(req.store, req.body, client(req)), 'Password set'));
export const login = handle(async (req, res) => ok(res, await auth.login(req.store, req.body, client(req)), 'Signed in'));
export const refresh = handle(async (req, res) => ok(res, await auth.refresh(req.store, req.body), 'Token refreshed'));
export const logout = handle(async (req, res) => {
  await auth.logout(req.store, req.body);
  ok(res, null, 'Signed out');
});

export const getProfile = handle(async (req, res) => ok(res, await shop.getProfile(req.store, req.customer.id), 'Profile retrieved'));
export const updateProfile = handle(async (req, res) => ok(res, await shop.updateProfile(req.store, req.customer.id, req.body), 'Profile updated'));

const addressCtx = (req) => ({ userId: null, ...client(req) });
export const listAddresses = handle(async (req, res) => ok(res, await customers.listAddresses(req.customer.id, req.store.id, res.locals.query.type), 'Addresses retrieved'));
export const createAddress = handle(async (req, res) => ok(res, await customers.createAddress(req.customer.id, req.store.id, req.body, addressCtx(req)), 'Address created', 201));
export const updateAddress = handle(async (req, res) => ok(res, await customers.updateAddress(req.customer.id, req.params.addressId, req.store.id, req.body, addressCtx(req)), 'Address updated'));
export const deleteAddress = handle(async (req, res) => {
  await customers.deleteAddress(req.customer.id, req.params.addressId, req.store.id, addressCtx(req));
  ok(res, null, 'Address deleted');
});

export const listOrders = handle(async (req, res) => {
  const result = await shop.listOrders(req.store, req.customer.id, res.locals.query);
  ok(res, result.data, 'Orders retrieved', 200, { meta: result.meta });
});
export const getOrder = handle(async (req, res) => ok(res, await shop.getOrder(req.store, req.customer.id, req.params.orderId), 'Order retrieved'));
export const verifyPayment = handle(async (req, res) => ok(res, await shop.verifyPayment(req.store, req.customer.id, req.params.paymentId, req.body), 'Payment confirmed'));
export const payOrder = handle(async (req, res) => ok(res, await shop.payOrder(req.store, req.customer.id, req.params.orderId), 'Payment started', 201));

export const getCart = handle(async (req, res) => ok(res, await shop.getCart(req.store, req.customer.id), 'Cart retrieved'));
export const setCartItem = handle(async (req, res) => ok(res, await shop.setCartItem(req.store, req.customer.id, req.params.variantId, req.body.quantity), 'Cart updated'));
export const removeCartItem = handle(async (req, res) => ok(res, await shop.setCartItem(req.store, req.customer.id, req.params.variantId, 0), 'Cart updated'));
export const clearCart = handle(async (req, res) => ok(res, await shop.clearCart(req.store, req.customer.id), 'Cart cleared'));
export const checkout = handle(async (req, res) => ok(res, await shop.checkout(req.store, req.customer.id, req.body, client(req)), 'Order placed', 201));
