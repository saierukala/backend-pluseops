import { z } from 'zod';
import { isValidGstin, isValidPan, toStateCode } from '../gst/india.js';

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
  // Phase 37: GST percent applied to new orders; null falls back to DEFAULT_GST_RATE_PERCENT
  gstRatePercent: nullable(z.number().min(0).max(100).refine((n) => Number.isInteger(n * 100), { message: 'gstRatePercent allows at most two decimals' })),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one setting must be provided' });

const upper = (schema) => z.string().trim().transform((v) => v.toUpperCase()).pipe(schema);

// Phase 38: the business's GST identity, printed on every tax invoice. Known keys only; null clears one.
export const REGISTRATION_TYPES = ['REGULAR', 'COMPOSITION', 'UNREGISTERED'];
export const taxProfileBody = z.object({
  legalName: nullable(z.string().trim().min(1).max(255)),
  tradeName: nullable(z.string().trim().min(1).max(255)),
  registrationType: nullable(z.enum(REGISTRATION_TYPES)),
  gstin: nullable(upper(z.string().refine(isValidGstin, { message: 'gstin is not a valid GSTIN (format or check digit)' }))),
  pan: nullable(upper(z.string().refine(isValidPan, { message: 'pan must look like ABCDE1234F' }))),
  // "29", "KA" or "Karnataka" are all accepted and stored as the two-digit GST state code
  stateCode: nullable(z.string().transform((v, ctx) => {
    const code = toStateCode(v);
    if (!code) ctx.addIssue({ code: 'custom', message: 'stateCode must be an Indian state (GST code, short form or name)' });
    return code ?? z.NEVER;
  })),
  address: nullable(z.object({
    line1: z.string().trim().min(1).max(255),
    line2: z.string().trim().max(255).nullable().optional(),
    city: z.string().trim().min(1).max(100),
    pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, { message: 'pincode must be 6 digits' }),
  })),
  phone: nullable(z.string().trim().max(30)),
  email: nullable(z.string().trim().toLowerCase().email().max(255)),
  bankName: nullable(z.string().trim().min(1).max(100)),
  accountNumber: nullable(z.string().trim().regex(/^[0-9]{6,20}$/, { message: 'accountNumber must be 6–20 digits' })),
  ifsc: nullable(upper(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'ifsc must look like HDFC0001234' }))),
  upiId: nullable(z.string().trim().regex(/^[\w.-]{2,}@[a-zA-Z]{2,}$/, { message: 'upiId must look like shop@okhdfcbank' })),
  signatory: nullable(z.string().trim().min(1).max(100)),
  invoicePrefix: nullable(upper(z.string().regex(/^[A-Z0-9-]{1,10}$/, { message: 'invoicePrefix: up to 10 letters, numbers or -' }))),
  invoiceTerms: nullable(z.string().trim().max(1000)),
  pricesIncludeTax: nullable(z.boolean()),
}).refine((data) => Object.keys(data).length > 0, { message: 'At least one field must be provided' })
  .refine((data) => !data.gstin || !data.stateCode || data.gstin.slice(0, 2) === data.stateCode, {
    message: 'The GSTIN belongs to a different state than stateCode', path: ['gstin'],
  });

export const updateTaxProfileSchema = z.object({ body: taxProfileBody });

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

// Phase 35: the shop's own Razorpay account (secrets are write-only)
export const savePaymentGatewaySchema = z.object({
  body: z.object({
    keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,}$/, 'keyId must be a Razorpay key id (rzp_test_… or rzp_live_…)'),
    keySecret: z.string().trim().min(8).max(128),
    webhookSecret: z.string().min(8).max(128).optional(),
    enabled: z.boolean().optional(),
  }),
});

export const updatePaymentGatewaySchema = z.object({ body: z.object({ enabled: z.boolean() }) });
