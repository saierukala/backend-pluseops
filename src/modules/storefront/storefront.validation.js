import { z } from 'zod';
import { orderStatusEnum } from '../orders/orders.validation.js';
import { addressBodySchema, addressTypeEnum } from '../customers/customers.validation.js';

const email = z.string().trim().toLowerCase().email().max(255);
// Same rule as staff passwords
const password = z.string().min(8).max(128).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/);
const name = z.string().trim().min(1).max(100);
const uuid = z.string().uuid();
const page = z.coerce.number().int().positive().default(1);
const price = z.coerce.number().nonnegative().max(1e9);

export const resolveSchema = z.object({ query: z.object({ host: z.string().trim().min(1).max(253) }) });

export const listProductsSchema = z.object({
  query: z.object({
    page,
    limit: z.coerce.number().int().positive().max(60).default(24),
    search: z.string().trim().min(1).max(100).optional(),
    category: z.string().trim().toLowerCase().max(100).optional(),
    minPrice: price.optional(),
    maxPrice: price.optional(),
    inStock: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest'),
  }).refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, { message: 'minPrice must not exceed maxPrice', path: ['maxPrice'] }),
});

export const productParamsSchema = z.object({ params: z.object({ store: z.string(), productId: uuid }) });

export const registerSchema = z.object({ body: z.object({ email, firstName: name, lastName: name, phone: z.string().trim().max(30).optional() }) });
export const forgotPasswordSchema = z.object({ body: z.object({ email }) });
export const setPasswordSchema = z.object({ body: z.object({ token: z.string().trim().min(16).max(200), password }) });
export const loginSchema = z.object({ body: z.object({ email, password: z.string().min(1).max(128) }) });
export const refreshSchema = z.object({ body: z.object({ refreshToken: z.string().min(10).max(300) }) });

export const updateProfileSchema = z.object({
  body: z.object({ firstName: name.optional(), lastName: name.optional(), phone: z.string().trim().max(30).nullable().optional() })
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' }),
});

export const listAddressesSchema = z.object({ query: z.object({ type: addressTypeEnum.optional() }) });
export const createAddressSchema = z.object({ body: addressBodySchema });
export const updateAddressSchema = z.object({
  params: z.object({ store: z.string(), addressId: uuid }),
  body: addressBodySchema.partial().refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' }),
});
export const addressParamsSchema = z.object({ params: z.object({ store: z.string(), addressId: uuid }) });

export const listOrdersSchema = z.object({ query: z.object({ page, limit: z.coerce.number().int().positive().max(50).default(20), status: orderStatusEnum.optional() }) });
export const orderParamsSchema = z.object({ params: z.object({ store: z.string(), orderId: uuid }) });

export const setCartItemSchema = z.object({
  params: z.object({ store: z.string(), variantId: uuid }),
  body: z.object({ quantity: z.number().int().min(0).max(100) }),
});
export const cartItemParamsSchema = z.object({ params: z.object({ store: z.string(), variantId: uuid }) });

export const checkoutSchema = z.object({ body: z.object({ shippingAddressId: uuid.optional(), billingAddressId: uuid.optional() }).default({}) });

// Phase 35: the three fields Razorpay's checkout handler receives (razorpay_order_id, razorpay_payment_id, razorpay_signature)
export const verifyPaymentSchema = z.object({
  params: z.object({ store: z.string(), paymentId: uuid }),
  body: z.object({
    razorpayOrderId: z.string().min(1).max(64),
    razorpayPaymentId: z.string().min(1).max(64),
    razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/i, 'razorpaySignature must be a hex HMAC-SHA256'),
  }),
});
