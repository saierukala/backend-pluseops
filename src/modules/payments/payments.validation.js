import { z } from 'zod';

const decimalString = z.string().regex(/^\d+(\.\d{1,2})?$/, { message: 'Invalid decimal format' });
const uuid = z.string().uuid();

export const createPaymentSchema = z.object({
  body: z.object({
    orderId: uuid,
    provider: z.string().max(50).optional(),
    currency: z.string().min(3).max(3).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
});

export const confirmPaymentSchema = z.object({
  body: z.object({
    paymentId: uuid,
    providerPaymentId: z.string().max(255).optional(),
    simulateFailure: z.boolean().optional(),
  }).strict(),
});

export const webhookSchema = z.object({
  body: z.object({
    eventId: z.string().min(1).max(255),
    type: z.enum(['payment.succeeded', 'payment.failed', 'payment.refunded', 'charge.succeeded', 'charge.failed']),
    paymentId: uuid.optional(),
    providerPaymentId: z.string().max(255).optional(),
    providerTransactionId: z.string().max(255).optional(),
    amount: decimalString.optional(),
    currency: z.string().min(3).max(3).optional(),
    tenantId: uuid.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  headers: z.object({
    'x-webhook-signature': z.string().optional(),
    'x-payment-signature': z.string().optional(),
  }).passthrough().optional(),
});

export const listPaymentsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED']).optional(),
  orderId: uuid.optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const listPaymentsSchema = z.object({ query: listPaymentsQuery });

export const getPaymentSchema = z.object({
  params: z.object({ id: uuid }),
});

export const refundPaymentSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    amount: decimalString,
    reason: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
});

// Phase 35: Razorpay's body is verified byte-for-byte (rawBody) in the service; only the tenant id is checked here
export const razorpayWebhookSchema = z.object({ params: z.object({ tenantId: z.string().uuid() }), body: z.any() });
