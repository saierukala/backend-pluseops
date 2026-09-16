import { getPrismaClient } from '../../config/database.js';

export class ProductRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId) {
    return this.prisma.product.create({
      data: {
        tenantId,
        name: data.name,
        description: data.description,
        brand: data.brand,
        status: data.status ?? 'DRAFT',
        basePrice: data.basePrice,
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.product.findFirst({
      where: { id, tenantId },
      include: {
        categories: {
          include: { category: true },
        },
        variants: {
          include: {
            attributes: {
              include: { attributeDefinition: true },
            },
            images: true,
          },
        },
        images: true,
      },
    });
  }

  async list(tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      categoryId,
      minPrice,
      maxPrice,
      sku,
      barcode,
      attributeFilters,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { tenantId };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (categoryId) {
      where.categories = { some: { categoryId, tenantId } };
    }

    const variantFilters = [];
    if (sku) {
      variantFilters.push({ sku: { contains: sku, mode: 'insensitive' } });
    }
    if (barcode) {
      variantFilters.push({ barcode: { contains: barcode, mode: 'insensitive' } });
    }
    if (minPrice !== undefined || maxPrice !== undefined) {
      const priceFilter = {};
      if (minPrice !== undefined) priceFilter.gte = minPrice;
      if (maxPrice !== undefined) priceFilter.lte = maxPrice;
      variantFilters.push({ price: priceFilter });
    }
    if (attributeFilters && Object.keys(attributeFilters).length > 0) {
      const attrConditions = [];
      for (const [attrCode, attrValue] of Object.entries(attributeFilters)) {
        attrConditions.push({
          attributeDefinition: { code: attrCode, tenantId },
          value: attrValue,
        });
      }
      const attrFilter = attrConditions.length === 1 ? attrConditions[0] : { AND: attrConditions };
      variantFilters.push({ attributes: { some: attrFilter } });
    }
    if (variantFilters.length > 0) {
      where.variants = {
        some: {
          tenantId,
          AND: variantFilters,
        },
      };
    }

    const allowedSortFields = ['name', 'brand', 'status', 'basePrice', 'createdAt', 'updatedAt'];
    const allowedSortOrders = ['asc', 'desc'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const safeSortOrder = allowedSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          categories: {
            include: { category: { select: { id: true, name: true, slug: true } } },
          },
          variants: {
            where: { status: { not: 'DRAFT' } },
            include: {
              attributes: {
                include: { attributeDefinition: { select: { id: true, name: true, code: true, dataType: true } } },
              },
              images: { where: { isPrimary: true }, take: 1 },
            },
            orderBy: { createdAt: 'asc' },
            take: 10,
          },
          images: { where: { isPrimary: true }, take: 1 },
          _count: { select: { variants: true } },
        },
        orderBy: { [safeSortBy]: safeSortOrder },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data: products,
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async update(id, tenantId, data) {
    return this.prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        brand: data.brand,
        status: data.status,
        basePrice: data.basePrice,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.product.delete({
      where: { id },
    });
  }

  async setCategories(productId, tenantId, categoryIds, primaryCategoryId = null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.productCategory.deleteMany({
        where: { productId, tenantId },
      });

      if (categoryIds && categoryIds.length > 0) {
        const primaryId = primaryCategoryId ?? categoryIds[0];
        await tx.productCategory.createMany({
          data: categoryIds.map((catId) => ({
            tenantId,
            productId,
            categoryId: catId,
            isPrimary: catId === primaryId,
          })),
          skipDuplicates: true,
        });
      }

      return tx.productCategory.findMany({
        where: { productId, tenantId },
        include: { category: true },
      });
    });
  }

  async getCategories(productId, tenantId) {
    return this.prisma.productCategory.findMany({
      where: { productId, tenantId },
      include: { category: true },
    });
  }

  async getOverview(tenantId) {
    const [totalProducts, totalCategories, variantCount] = await Promise.all([
      this.prisma.product.count({ where: { tenantId } }),
      this.prisma.category.count({ where: { tenantId } }),
      this.prisma.productVariant.count({ where: { tenantId } }),
    ]);
    return { products: totalProducts, categories: totalCategories, variants: variantCount };
  }
}