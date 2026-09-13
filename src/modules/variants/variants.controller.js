import { VariantService } from './variants.service.js';

const variantService = new VariantService();

export async function createVariant(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;
    const variant = await variantService.create(productId, tenantId, req.body);
    res.status(201).json({
      success: true,
      data: variant,
      message: 'Variant created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getVariant(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId, productId } = req.params;
    const variant = await variantService.getById(variantId, tenantId, productId);
    res.status(200).json({
      success: true,
      data: variant,
      message: 'Variant retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listVariants(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;
    const { page, limit, status, sortBy, sortOrder } = req.query;

    const result = await variantService.listByProduct(productId, tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Variants retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateVariant(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId, productId } = req.params;
    const variant = await variantService.update(variantId, tenantId, req.body, productId);
    res.status(200).json({
      success: true,
      data: variant,
      message: 'Variant updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteVariant(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId, productId } = req.params;
    await variantService.delete(variantId, tenantId, productId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Variant deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function setVariantAttributes(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId, productId } = req.params;
    const { attributes } = req.body;
    const result = await variantService.setAttributes(variantId, tenantId, attributes, productId);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Variant attributes updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getVariantAttributes(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { variantId, productId } = req.params;
    const attributes = await variantService.getAttributes(variantId, tenantId, productId);
    res.status(200).json({
      success: true,
      data: attributes,
      message: 'Variant attributes retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}