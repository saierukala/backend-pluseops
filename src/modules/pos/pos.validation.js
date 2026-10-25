import { z } from 'zod';
import { PAYMENT_METHODS } from './pos.service.js';

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: 'amount like 120 or 120.50' });
const positiveMoney = money.refine((v) => Number(v) > 0, { message: 'must be more than 0' });
const uuid = z.string().uuid();
const page = { page: z.coerce.number().int().positive().default(1), limit: z.coerce.number().int().positive().max(100).default(20) };

export const lookupSchema = z.object({
  query: z.object({ q: z.string().trim().min(1).max(100), warehouseId: uuid.optional(), limit: z.coerce.number().int().positive().max(50).default(20) }),
});

export const saleSchema = z.object({
  body: z.object({
    // Leave out for a walk-in sale
    customerId: uuid.optional(),
    warehouseId: uuid.optional(),
    registerId: uuid.optional(),
    items: z.array(z.object({
      variantId: uuid,
      quantity: z.number().int().positive().max(100000),
      discount: money.optional(),
    })).min(1).max(200),
    payments: z.array(z.object({
      method: z.enum(PAYMENT_METHODS),
      amount: positiveMoney,
      // Cash handed over (change = tendered − amount)
      tendered: money.optional(),
      // Card slip, UTR, cheque number…
      reference: z.string().trim().max(100).optional(),
      // UPI through Razorpay: the QR shown at the counter; the server confirms it with Razorpay
      razorpayQrId: z.string().trim().regex(/^qr_[A-Za-z0-9]+$/).optional(),
    }).refine((p) => !p.razorpayQrId || p.method === 'UPI', { message: 'razorpayQrId is only for UPI', path: ['razorpayQrId'] }))
      .min(1).max(5),
    note: z.string().trim().max(500).optional(),
  }),
});

export const holdSchema = z.object({
  body: z.object({
    label: z.string().trim().max(100).optional(),
    cart: z.object({
      customerId: uuid.optional(),
      items: z.array(z.object({ variantId: uuid, quantity: z.number().int().positive(), discount: money.optional() }).passthrough()).min(1).max(200),
    }).passthrough(),
  }),
});

export const heldParams = z.object({ params: z.object({ id: uuid }) });

export const upiQrSchema = z.object({ body: z.object({ amount: positiveMoney }) });
export const upiQrParams = z.object({ params: z.object({ qrId: z.string().regex(/^qr_[A-Za-z0-9]+$/) }) });

// ── Cash register ──────────────────────────────────────────────────────

export const createRegisterSchema = z.object({ body: z.object({ name: z.string().trim().min(1).max(60) }) });
export const registerParams = z.object({ params: z.object({ registerId: uuid }) });
export const openRegisterSchema = z.object({
  params: z.object({ registerId: uuid }),
  body: z.object({ openingFloat: money.default('0'), note: z.string().trim().max(500).optional() }),
});
export const sessionParams = z.object({ params: z.object({ sessionId: uuid }) });
export const listSessionsSchema = z.object({ query: z.object({ registerId: uuid.optional(), ...page }) });
export const cashMovementSchema = z.object({
  params: z.object({ sessionId: uuid }),
  body: z.object({ type: z.enum(['CASH_IN', 'CASH_OUT']), amount: positiveMoney, reason: z.string().trim().min(1).max(200) }),
});
export const closeSessionSchema = z.object({
  params: z.object({ sessionId: uuid }),
  body: z.object({ countedCash: money, note: z.string().trim().max(500).optional() }),
});
