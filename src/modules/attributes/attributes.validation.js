import { z } from 'zod';

export const attributeDataTypeEnum = z.enum(['TEXT', 'NUMBER', 'BOOLEAN', 'OPTION']);

export const createAttributeSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/),
    dataType: attributeDataTypeEnum,
    isRequired: z.boolean().default(false),
    description: z.string().max(1000).optional(),
  }),
});

export const updateAttributeSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().min(1).max(255).optional(),
    code: z.string().min(1).max(50).regex(/^[a-z0-9_-]+$/).optional(),
    dataType: attributeDataTypeEnum.optional(),
    isRequired: z.boolean().optional(),
    description: z.string().max(1000).optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getAttributeSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const deleteAttributeSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const listAttributesQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    search: z.string().max(255).optional(),
    dataType: attributeDataTypeEnum.optional(),
    sortBy: z.enum(['name', 'code', 'dataType', 'isRequired', 'createdAt', 'updatedAt']).default('name'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  }),
});

export const createAttributeValueSchema = z.object({
  params: z.object({
    attributeId: z.string().uuid(),
  }),
  body: z.object({
    value: z.string().min(1).max(255),
    displayName: z.string().min(1).max(255),
    sortOrder: z.coerce.number().int().default(0),
    isActive: z.boolean().default(true),
  }),
});

export const updateAttributeValueSchema = z.object({
  params: z.object({
    attributeId: z.string().uuid(),
    valueId: z.string().uuid(),
  }),
  body: z.object({
    value: z.string().min(1).max(255).optional(),
    displayName: z.string().min(1).max(255).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

export const getAttributeValueSchema = z.object({
  params: z.object({
    attributeId: z.string().uuid(),
    valueId: z.string().uuid(),
  }),
});

export const deleteAttributeValueSchema = z.object({
  params: z.object({
    attributeId: z.string().uuid(),
    valueId: z.string().uuid(),
  }),
});

export const listAttributeValuesQuerySchema = z.object({
  params: z.object({
    attributeId: z.string().uuid(),
  }),
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
});