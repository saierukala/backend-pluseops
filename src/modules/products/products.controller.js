import { ProductService } from './products.service.js';

const productService = new ProductService();

export async function createProduct(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const product = await productService.create(tenantId, req.body);
    res.status(201).json({
      success: true,
      data: product,
      message: 'Product created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getProduct(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const product = await productService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: product,
      message: 'Product retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listProducts(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, search, status, categoryId, minPrice, maxPrice, sku, barcode, sortBy, sortOrder } = req.query;

    const attributeFilters = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (key.startsWith('attribute[') && key.endsWith(']')) {
        const attrName = key.slice(10, -1);
        attributeFilters[attrName] = value;
      }
    }

    const result = await productService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      search,
      status,
      categoryId,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      sku,
      barcode,
      attributeFilters,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Products retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateProduct(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const product = await productService.update(id, tenantId, req.body);
    res.status(200).json({
      success: true,
      data: product,
      message: 'Product updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteProduct(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    await productService.delete(id, tenantId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function setProductCategories(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;
    const { categories, primaryCategoryId } = req.body;
    const result = await productService.setCategories(productId, tenantId, categories, primaryCategoryId);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Product categories updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getProductCategories(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { productId } = req.params;
    const categories = await productService.getCategories(productId, tenantId);
    res.status(200).json({
      success: true,
      data: categories,
      message: 'Product categories retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}