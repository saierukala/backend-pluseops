import { CategoryService } from './categories.service.js';

const categoryService = new CategoryService();

export async function createCategory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const category = await categoryService.create(tenantId, req.body);
    res.status(201).json({
      success: true,
      data: category,
      message: 'Category created successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getCategory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const category = await categoryService.getById(id, tenantId);
    res.status(200).json({
      success: true,
      data: category,
      message: 'Category retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function listCategories(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { page, limit, search, isActive, parentId, sortBy, sortOrder } = req.query;

    const result = await categoryService.list(tenantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      search,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      parentId,
      sortBy,
      sortOrder,
    });

    res.status(200).json({
      success: true,
      data: result.data,
      meta: result.meta,
      message: 'Categories retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function updateCategory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    const category = await categoryService.update(id, tenantId, req.body);
    res.status(200).json({
      success: true,
      data: category,
      message: 'Category updated successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteCategory(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const { id } = req.params;
    await categoryService.delete(id, tenantId);
    res.status(200).json({
      success: true,
      data: null,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function getCategoryTree(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const tree = await categoryService.getTree(tenantId);
    res.status(200).json({
      success: true,
      data: tree,
      message: 'Category tree retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}