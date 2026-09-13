import { ProductImageService } from './product-images.service.js';

const productImageService = new ProductImageService();

export async function createProductImage(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'FILE_REQUIRED', message: 'Image file is required', details: null },
        requestId: req.id,
      });
    }

    const image = await productImageService.createProductImage(productId, tenantId, req.file, req.body);
    res.status(201).json({
      success: true,
      data: image,
      message: 'Product image uploaded successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function createVariantImage(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId, variantId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'FILE_REQUIRED', message: 'Image file is required', details: null },
        requestId: req.id,
      });
    }

    const image = await productImageService.createVariantImage(productId, variantId, tenantId, req.file, req.body);
    res.status(201).json({
      success: true,
      data: image,
      message: 'Variant image uploaded successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getProductImage(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { imageId, productId } = req.params;
    const image = await productImageService.getImage(imageId, tenantId, productId);
    res.status(200).json({
      success: true,
      data: image,
      message: 'Image retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listProductImages(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;
    const { page, limit } = req.query;

    const result = await productImageService.listProductImages(productId, tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Product images retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listVariantImages(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId, variantId } = req.params;
    const { page, limit } = req.query;

    const result = await productImageService.listVariantImages(productId, variantId, tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Variant images retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateProductImage(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { imageId, productId } = req.params;
    const image = await productImageService.updateImage(imageId, tenantId, req.body, productId);
    res.status(200).json({
      success: true,
      data: image,
      message: 'Image updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteProductImage(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { imageId, productId } = req.params;
    await productImageService.deleteImage(imageId, tenantId, productId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}