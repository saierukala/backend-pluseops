import { z } from 'zod';

export const startSupportSessionSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().trim().min(5).max(500) }),
});

export const endSupportSessionSchema = z.object({
  params: z.object({ sessionId: z.string().uuid() }),
});
