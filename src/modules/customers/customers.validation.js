import { z } from 'zod';
import { orderStatusEnum } from '../orders/orders.validation.js';
import { isValidGstin, isValidPan, toStateCode } from '../gst/india.js';

export const addressTypeEnum = z.enum(['SHIPPING', 'BILLING']);

const email = z.string().trim().toLowerCase().email().max(255);
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const country = z.string().trim().regex(/^[A-Za-z]{2}$/, { message: 'country must be an ISO 3166-1 alpha-2 code' }).transform((c) => c.toUpperCase());

const addressFields = {
  type: addressTypeEnum,
  label: optionalText(100),
  firstName: optionalText(100),
  lastName: optionalText(100),
  company: optionalText(255),
  line1: z.string().trim().min(1).max(255),
  line2: optionalText(255),
  city: z.string().trim().min(1).max(100),
  state: optionalText(100),
  postalCode: optionalText(20),
  country,
  phone: optionalText(30),
  isDefault: z.boolean().optional(),
};

export const addressBodySchema = z.object(addressFields);

// Phase 38: consumer or GST-registered business. A business needs its company name; GSTIN/PAN are checked.
const upper = (schema) => z.string().trim().transform((v) => v.toUpperCase()).pipe(schema);
const taxFields = {
  customerType: z.enum(['CONSUMER', 'BUSINESS']).optional(),
  companyName: optionalText(255),
  gstin: upper(z.string().refine(isValidGstin, { message: 'gstin is not a valid GSTIN (format or check digit)' })).nullable().optional(),
  pan: upper(z.string().refine(isValidPan, { message: 'pan must look like ABCDE1234F' })).nullable().optional(),
  stateCode: z.string().transform((v, ctx) => {
    const code = toStateCode(v);
    if (!code) ctx.addIssue({ code: 'custom', message: 'stateCode must be an Indian state (GST code, short form or name)' });
    return code ?? z.NEVER;
  }).nullable().optional(),
};
const businessHasName = (data) => data.customerType !== 'BUSINESS' || Boolean(data.companyName);
const gstinMatchesState = (data) => !data.gstin || !data.stateCode || data.gstin.slice(0, 2) === data.stateCode;

const customerId = z.object({ id: z.string().uuid() });
const addressParams = z.object({ id: z.string().uuid(), addressId: z.string().uuid() });
const atLeastOne = (data) => Object.keys(data).length > 0;

export const createCustomerSchema = z.object({
  body: z.object({
    email,
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: optionalText(30),
    metadata: z.record(z.string(), z.unknown()).optional(),
    addresses: z.array(addressBodySchema).max(20).optional(),
    ...taxFields,
  }).refine(businessHasName, { message: 'A business customer needs a company name', path: ['companyName'] })
    .refine(gstinMatchesState, { message: 'The GSTIN belongs to a different state', path: ['gstin'] }),
});

export const updateCustomerSchema = z.object({
  params: customerId,
  body: z.object({
    email: email.optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: optionalText(30),
    metadata: z.record(z.string(), z.unknown()).optional(),
    ...taxFields,
  }).refine(atLeastOne, { message: 'At least one field must be provided' })
    .refine(gstinMatchesState, { message: 'The GSTIN belongs to a different state', path: ['gstin'] }),
});

export const getCustomerSchema = z.object({ params: customerId });

export const deleteCustomerSchema = z.object({ params: customerId });

export const listCustomersQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().trim().max(255).optional(),
    sortBy: z.enum(['createdAt', 'updatedAt', 'email', 'lastName']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
});

export const listCustomerOrdersSchema = z.object({
  params: customerId,
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: orderStatusEnum.optional(),
  }),
});

export const listAddressesSchema = z.object({
  params: customerId,
  query: z.object({ type: addressTypeEnum.optional() }),
});

export const createAddressSchema = z.object({ params: customerId, body: addressBodySchema });

export const updateAddressSchema = z.object({
  params: addressParams,
  body: z.object(addressFields).partial().refine(atLeastOne, { message: 'At least one field must be provided' }),
});

export const deleteAddressSchema = z.object({ params: addressParams });
