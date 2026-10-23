import { z } from 'zod';
import { placeholders } from './template.renderer.js';

export const channelEnum = z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']);
const name = z.string().trim().toLowerCase().max(100).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, { message: 'name is a key like order.created' });
const variables = z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: 'variable names are identifiers' })).max(50)
  .refine((v) => new Set(v).size === v.length, { message: 'variables must be unique' });
const fields = {
  name,
  channel: channelEnum,
  subject: z.string().trim().min(1).max(255).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
  variables,
  isActive: z.boolean().optional(),
};

// Every placeholder must be declared, and every channel but SMS needs a subject (title for in-app/push).
export function checkTemplate(t, ctx) {
  if (t.channel !== 'SMS' && !t.subject) ctx.addIssue({ code: 'custom', path: ['subject'], message: `${t.channel} templates need a subject` });
  const declared = new Set(t.variables ?? []);
  for (const field of ['subject', 'body']) {
    for (const v of placeholders(t[field])) {
      if (!declared.has(v)) ctx.addIssue({ code: 'custom', path: [field], message: `{{${v}}} is not in variables` });
    }
  }
}

const idParams = z.object({ id: z.string().uuid() });

export const createTemplateSchema = z.object({
  body: z.object({ ...fields, variables: variables.default([]) }).superRefine(checkTemplate),
});

export const updateTemplateSchema = z.object({
  params: idParams,
  body: z.object(fields).partial().refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' }),
});

export const listTemplatesSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    channel: channelEnum.optional(),
    isActive: z.enum(['true', 'false']).optional(),
    search: z.string().trim().max(100).optional(),
  }),
});

export const templateIdSchema = z.object({ params: idParams });

export const previewTemplateSchema = z.object({
  params: idParams,
  body: z.object({ variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) }).default({ variables: {} }),
});
