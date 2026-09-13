import { Router } from 'express';
import { z } from 'zod';
import {
  createVariant,
  getVariant,
  listVariants,
  updateVariant,
  deleteVariant,
  setVariantAttributes,
  getVariantAttributes,
} from './variants.controller.js';
import {
  createVariantSchema,
  updateVariantSchema,
  getVariantSchema,
  deleteVariantSchema,
  listVariantsQuerySchema,
  setVariantAttributesSchema,
  getVariantAttributesSchema,
} from './variants.validation.js';
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

export const variantsRouter = Router({ mergeParams: true });

variantsRouter.use(authenticate());

variantsRouter.post('/', validate(createVariantSchema), authorize('product:create'), createVariant);
variantsRouter.get('/', validate(listVariantsQuerySchema), authorize('product:read'), listVariants);
variantsRouter.get('/:variantId', validate(getVariantSchema), authorize('product:read'), getVariant);
variantsRouter.patch('/:variantId', validate(updateVariantSchema), authorize('product:update'), updateVariant);
variantsRouter.delete('/:variantId', validate(deleteVariantSchema), authorize('product:delete'), deleteVariant);

variantsRouter.put('/:variantId/attributes', validate(setVariantAttributesSchema), authorize('product:update'), setVariantAttributes);
variantsRouter.get('/:variantId/attributes', validate(getVariantAttributesSchema), authorize('product:read'), getVariantAttributes);