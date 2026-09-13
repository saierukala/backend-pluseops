import { CategoryRepository } from './categories.repository.js';
import { AppError } from '../../common/errors/app-error.js';

export class CategoryService {
  constructor() {
    this.repository = new CategoryRepository();
  }

  async create(tenantId, data) {
    const existingSlug = await this.repository.existsBySlug(data.slug, tenantId);
    if (existingSlug) {
      throw new AppError('Category with this slug already exists', {
        statusCode: 409,
        code: 'CATEGORY_SLUG_EXISTS',
      });
    }

    if (data.parentId) {
      const parent = await this.repository.findById(data.parentId, tenantId);
      if (!parent) {
        throw new AppError('Parent category not found', {
          statusCode: 404,
          code: 'PARENT_CATEGORY_NOT_FOUND',
        });
      }
    }

    return this.repository.create(data, tenantId);
  }

  async getById(id, tenantId) {
    const category = await this.repository.findById(id, tenantId);
    if (!category) {
      throw new AppError('Category not found', {
        statusCode: 404,
        code: 'CATEGORY_NOT_FOUND',
      });
    }
    return category;
  }

  async list(tenantId, options = {}) {
    return this.repository.list(tenantId, options);
  }

  async update(id, tenantId, data) {
    await this.getById(id, tenantId);

    if (data.slug) {
      const existingSlug = await this.repository.existsBySlug(data.slug, tenantId, id);
      if (existingSlug) {
        throw new AppError('Category with this slug already exists', {
          statusCode: 409,
          code: 'CATEGORY_SLUG_EXISTS',
        });
      }
    }

    if (data.parentId) {
      if (data.parentId === id) {
        throw new AppError('Category cannot be its own parent', {
          statusCode: 400,
          code: 'INVALID_PARENT_CATEGORY',
        });
      }

      const parent = await this.repository.findById(data.parentId, tenantId);
      if (!parent) {
        throw new AppError('Parent category not found', {
          statusCode: 404,
          code: 'PARENT_CATEGORY_NOT_FOUND',
        });
      }

      const wouldCreateCycle = await this.wouldCreateCycle(id, data.parentId, tenantId);
      if (wouldCreateCycle) {
        throw new AppError('Category hierarchy would create a cycle', {
          statusCode: 400,
          code: 'CATEGORY_CYCLE_DETECTED',
        });
      }
    }

    return this.repository.update(id, tenantId, data);
  }

  async delete(id, tenantId) {
    await this.getById(id, tenantId);

    const hasChildren = await this.repository.hasChildren(id, tenantId);
    if (hasChildren) {
      throw new AppError('Cannot delete category with children. Reassign or delete children first.', {
        statusCode: 400,
        code: 'CATEGORY_HAS_CHILDREN',
      });
    }

    const hasProducts = await this.repository.hasProducts(id, tenantId);
    if (hasProducts) {
      throw new AppError('Cannot delete category with associated products. Remove products first.', {
        statusCode: 400,
        code: 'CATEGORY_HAS_PRODUCTS',
      });
    }

    return this.repository.delete(id, tenantId);
  }

  async getTree(tenantId) {
    return this.repository.getTree(tenantId);
  }

  async wouldCreateCycle(categoryId, newParentId, tenantId) {
    let currentId = newParentId;
    while (currentId) {
      if (currentId === categoryId) {
        return true;
      }
      const parent = await this.repository.findById(currentId, tenantId);
      currentId = parent?.parentId ?? null;
    }
    return false;
  }
}