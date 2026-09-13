import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  createProductImage,
  createVariantImage,
  getProductImage,
  listProductImages,
  listVariantImages,
  updateProductImage,
  deleteProductImage,
} from './product-images.controller.js';
import {
  createProductImageSchema,
  createVariantImageSchema,
  getImageSchema,
  updateImageSchema,
  deleteImageSchema,
  listProductImagesQuerySchema,
  listVariantImagesQuerySchema,
} from './product-images.validation.js';
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

export const productImagesRouter = Router({ mergeParams: true });

productImagesRouter.use(authenticate());

productImagesRouter.post(
  '/products/:productId/images',
  upload.single('image'),
  validate(createProductImageSchema),
  authorize('product:update'),
  createProductImage
);

productImagesRouter.post(
  '/products/:productId/variants/:variantId/images',
  upload.single('image'),
  validate(createVariantImageSchema),
  authorize('product:update'),
  createVariantImage
);

productImagesRouter.get(
  '/products/:productId/images',
  validate(listProductImagesQuerySchema),
  authorize('product:read'),
  listProductImages
);

productImagesRouter.get(
  '/products/:productId/variants/:variantId/images',
  validate(listVariantImagesQuerySchema),
  authorize('product:read'),
  listVariantImages
);

productImagesRouter.get(
  '/products/:productId/images/:imageId',
  validate(getImageSchema),
  authorize('product:read'),
  getProductImage
);

productImagesRouter.patch(
  '/products/:productId/images/:imageId',
  validate(updateImageSchema),
  authorize('product:update'),
  updateProductImage
);

productImagesRouter.delete(
  '/products/:productId/images/:imageId',
  validate(deleteImageSchema),
  authorize('product:delete'),
  deleteProductImage
);