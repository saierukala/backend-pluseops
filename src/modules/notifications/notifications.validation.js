import { z } from 'zod';

export const notificationTypeEnum = z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR']);
export const notificationChannelEnum = z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']);

export const listNotificationsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    isRead: z.enum(['true', 'false']).transform((v) => v === 'true').or(z.boolean()).optional(),
    type: notificationTypeEnum.optional(),
    channel: notificationChannelEnum.optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
  params: z.object({}).optional(),
  body: z.object({}).optional(),
});

export const markReadParamsSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const patchPreferencesSchema = z.object({
  body: z.object({
    preferences: z.object({
      IN_APP: z.boolean().optional(),
      EMAIL: z.boolean().optional(),
      SMS: z.boolean().optional(),
      PUSH: z.boolean().optional(),
    }).partial().strict().optional(),
    IN_APP: z.boolean().optional(),
    EMAIL: z.boolean().optional(),
    SMS: z.boolean().optional(),
    PUSH: z.boolean().optional(),
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    push: z.boolean().optional(),
  }).refine((data) => {
    const keys = ['IN_APP', 'EMAIL', 'SMS', 'PUSH', 'inApp', 'email', 'sms', 'push', 'preferences'];
    return keys.some((k) => data[k] !== undefined);
  }, { message: 'At least one preference field must be provided' }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

// Helper to normalize preferences body to canonical channel map
export function normalizePreferencePayload(body) {
  const mapping = {
    IN_APP: 'IN_APP',
    EMAIL: 'EMAIL',
    SMS: 'SMS',
    PUSH: 'PUSH',
    inApp: 'IN_APP',
    email: 'EMAIL',
    sms: 'SMS',
    push: 'PUSH',
  };
  const result = {};
  if (body.preferences && typeof body.preferences === 'object') {
    for (const [k, v] of Object.entries(body.preferences)) {
      if (['IN_APP', 'EMAIL', 'SMS', 'PUSH'].includes(k) && typeof v === 'boolean') result[k] = v;
    }
  }
  for (const [alias, canonical] of Object.entries(mapping)) {
    if (body[alias] !== undefined && typeof body[alias] === 'boolean' && result[canonical] === undefined) {
      result[canonical] = body[alias];
    }
  }
  // Filter out non-boolean
  const filtered = {};
  for (const ch of ['IN_APP', 'EMAIL', 'SMS', 'PUSH']) {
    if (typeof result[ch] === 'boolean') filtered[ch] = result[ch];
  }
  return filtered;
}

// Validation for service-level creation (not HTTP, but reused)
export const createNotificationSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable().optional(),
  type: notificationTypeEnum.default('INFO'),
  title: z.string().min(1).max(255),
  message: z.string().min(1).max(2000),
  channel: notificationChannelEnum.default('IN_APP'),
  referenceType: z.string().max(100).optional().nullable(),
  referenceId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});
