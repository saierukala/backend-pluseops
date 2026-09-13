import { getPrismaClient } from '../../config/database.js';

export class CategoryRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId) {
    return this.prisma.category.create({
      data: {
        tenantId,
        name: data.name,
        slug: data.slug,
        description: data.description,
        parentId: data.parentId,
        sortOrder: data.sortOrder ?? 0,
        isActive: data.isActive ?? true,
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.category.findFirst({
      where: { id, tenantId },
      include: {
        children: true,
        _count: {
          select: { productCategories: true },
        },
      },
    });
  }

  async findBySlug(slug, tenantId) {
    return this.prisma.category.findFirst({
      where: { slug, tenantId },
    });
  }

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      isActive,
      parentId,
      sortBy = 'sortOrder',
      sortOrder = 'asc',
    } = options;

    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { tenantId };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (parentId !== undefined) {
      where.parentId = parentId === 'null' ? null : parentId;
    }

    const allowedSortFields = ['name', 'slug', 'sortOrder', 'createdAt', 'updatedAt', 'isActive'];
    const allowedSortOrders = ['asc', 'desc'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'sortOrder';
    const safeSortOrder = allowedSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'asc';

    const [categories, total] = await Promise.all([
      this.prisma.category.findMany({
        where,
        include: {
          children: { select: { id: true, name: true, slug: true } },
          _count: { select: { productCategories: true } },
        },
        orderBy: { [safeSortBy]: safeSortOrder },
        skip,
        take,
      }),
      this.prisma.category.count({ where }),
    ]);

    return {
      data: categories,
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async update(id, tenantId, data) {
    return this.prisma.category.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description,
        parentId: data.parentId,
        sortOrder: data.sortOrder,
        isActive: data.isActive,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.category.delete({
      where: { id },
    });
  }

  async existsBySlug(slug, tenantId, excludeId = null) {
    const where = { slug, tenantId };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    const category = await this.prisma.category.findFirst({ where, select: { id: true } });
    return !!category;
  }

  async hasChildren(id, tenantId) {
    const count = await this.prisma.category.count({
      where: { parentId: id, tenantId },
    });
    return count > 0;
  }

  async hasProducts(id, tenantId) {
    const count = await this.prisma.productCategory.count({
      where: { categoryId: id, tenantId },
    });
    return count > 0;
  }

  async getTree(tenantId) {
    const categories = await this.prisma.category.findMany({
      where: { tenantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    const categoryMap = new Map();
    const roots = [];

    for (const cat of categories) {
      categoryMap.set(cat.id, { ...cat, children: [] });
    }

    for (const cat of categories) {
      const node = categoryMap.get(cat.id);
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}