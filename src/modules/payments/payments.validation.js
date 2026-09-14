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
