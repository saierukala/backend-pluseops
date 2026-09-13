import { Router } from 'express';
import { z } from 'zod';
import {
  createCategory,
  getCategory,
  listCategories,
  updateCategory,
  deleteCategory,
  getCategoryTree,
} from './categories.controller.js';
import {
  createCategorySchema,
  updateCategorySchema,
  getCategorySchema,
  deleteCategorySchema,
  listCategoriesQuerySchema,
  getCategoryTreeSchema,
} from './categories.validation.js';
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

export const categoriesRouter = Router();

categoriesRouter.use(authenticate());

categoriesRouter.post('/', validate(createCategorySchema), authorize('category:create'), createCategory);
categoriesRouter.get('/', validate(listCategoriesQuerySchema), authorize('category:read'), listCategories);
categoriesRouter.get('/tree', validate(getCategoryTreeSchema), authorize('category:read'), getCategoryTree);
categoriesRouter.get('/:id', validate(getCategorySchema), authorize('category:read'), getCategory);
categoriesRouter.patch('/:id', validate(updateCategorySchema), authorize('category:update'), updateCategory);
categoriesRouter.delete('/:id', validate(deleteCategorySchema), authorize('category:delete'), deleteCategory);