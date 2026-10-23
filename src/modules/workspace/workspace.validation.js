import { z } from 'zod';

const nullable = (schema) => schema.nullable().optional();

function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isLocale(value) {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

// Lower-cased, no scheme/path/port, no trailing dot; at least one dot and an alphabetic TLD.
const HOSTNAME_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const domainName = z.string().trim().toLowerCase()
  .transform((d) => d.replace(/\.$/, ''))
  .refine((d) => HOSTNAME_RE.test(d), { message: 'domain must be a hostname such as shop.example.com (no scheme, path or port)' });

// Known keys only; null clears a setting. Stored in TenantSettings.metadata.
export const settingsBody = z.object({
  currency: nullable(z.string().trim().regex(/^[A-Za-z]{3}$/, { message: 'currency must be an ISO 4217 code' }).transform((c) => c.toUpperCase())),
  timezone: nullable(z.string().trim().refine(isTimeZone, { message: 'timezone must be an IANA time zone, e.g. Asia/Kolkata' })),
  locale: nullable(z.string().trim().refine(isLocale, { message: 'locale must be a BCP 47 tag, e.g. en-IN' })),
  contactEmail: nullable(z.string().trim().toLowerCase().email().max(255)),
  contactPhone: nullable(z.string().trim().max(30)),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one setting must be provided' });

export const updateWorkspaceSchema = z.object({
  body: z.object({ name: z.string().trim().min(1).max(255) }),
});

export const updateSettingsSchema = z.object({ body: settingsBody });

export const createDomainSchema = z.object({ body: z.object({ domain: domainName }) });

const domainParams = z.object({ domainId: z.string().uuid() });

export const updateDomainSchema = z.object({
  params: domainParams,
  body: z.object({ primary: z.literal(true, { message: 'Set primary: true on the domain that should become primary' }) }),
});

export const deleteDomainSchema = z.object({ params: domainParams });
