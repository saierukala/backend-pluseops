import { Router } from 'express';
import { z } from 'zod';
import {
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
  deleteProduct,
  setProductCategories,
  getProductCategories,
} from './products.controller.js';
import {
  createProductSchema,
  updateProductSchema,
  getProductSchema,
  deleteProductSchema,
  listProductsQuerySchema,
  setCategoriesSchema,
  getProductCategoriesSchema,
} from './products.validation.js';
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

export const productsRouter = Router();

productsRouter.use(authenticate());

productsRouter.post('/', validate(createProductSchema), authorize('product:create'), createProduct);
productsRouter.get('/', validate(listProductsQuerySchema), authorize('product:read'), listProducts);
productsRouter.get('/:id', validate(getProductSchema), authorize('product:read'), getProduct);
productsRouter.patch('/:id', validate(updateProductSchema), authorize('product:update'), updateProduct);
productsRouter.delete('/:id', validate(deleteProductSchema), authorize('product:delete'), deleteProduct);

productsRouter.post('/:productId/categories', validate(setCategoriesSchema), authorize('product:update'), setProductCategories);
productsRouter.get('/:productId/categories', validate(getProductCategoriesSchema), authorize('product:read'), getProductCategories);