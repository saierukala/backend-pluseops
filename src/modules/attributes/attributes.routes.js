import { Router } from 'express';
import { z } from 'zod';
import {
  createAttribute,
  getAttribute,
  listAttributes,
  updateAttribute,
  deleteAttribute,
  createAttributeValue,
  getAttributeValue,
  listAttributeValues,
  updateAttributeValue,
  deleteAttributeValue,
} from './attributes.controller.js';
import {
  createAttributeSchema,
  updateAttributeSchema,
  getAttributeSchema,
  deleteAttributeSchema,
  listAttributesQuerySchema,
  createAttributeValueSchema,
  updateAttributeValueSchema,
  getAttributeValueSchema,
  deleteAttributeValueSchema,
  listAttributeValuesQuerySchema,
} from './attributes.validation.js';
import { authenticate } from '../auth/auth.middleware.js';
import { authorize } from '../auth/authorization.middleware.js';

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (!result.success) {
      const error = new z.ZodError(result.error.issues);
      return next(error);
    }
    req.body = result.data.body;
    req.params = result.data.params;
    next();
  };
}

export const attributesRouter = Router();

attributesRouter.use(authenticate());

attributesRouter.post('/', validate(createAttributeSchema), authorize('attribute:create'), createAttribute);
attributesRouter.get('/', validate(listAttributesQuerySchema), authorize('attribute:read'), listAttributes);
attributesRouter.get('/:id', validate(getAttributeSchema), authorize('attribute:read'), getAttribute);
attributesRouter.patch('/:id', validate(updateAttributeSchema), authorize('attribute:update'), updateAttribute);
attributesRouter.delete('/:id', validate(deleteAttributeSchema), authorize('attribute:delete'), deleteAttribute);

attributesRouter.post('/:attributeId/values', validate(createAttributeValueSchema), authorize('attribute:update'), createAttributeValue);
attributesRouter.get('/:attributeId/values', validate(listAttributeValuesQuerySchema), authorize('attribute:read'), listAttributeValues);
attributesRouter.get('/:attributeId/values/:valueId', validate(getAttributeValueSchema), authorize('attribute:read'), getAttributeValue);
attributesRouter.patch('/:attributeId/values/:valueId', validate(updateAttributeValueSchema), authorize('attribute:update'), updateAttributeValue);
attributesRouter.delete('/:attributeId/values/:valueId', validate(deleteAttributeValueSchema), authorize('attribute:delete'), deleteAttributeValue);