import { getPrismaClient } from '../../config/database.js';

export class ProductImageRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId) {
    return this.prisma.productImage.create({
      data: {
        tenantId,
        productId: data.productId,
        variantId: data.variantId ?? null,
        storageKey: data.storageKey,
        url: data.url,
        altText: data.altText,
        sortOrder: data.sortOrder ?? 0,
        isPrimary: data.isPrimary ?? false,
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.productImage.findFirst({
      where: { id, tenantId },
      include: {
        product: { select: { id: true, name: true } },
        variant: { select: { id: true, sku: true } },
      },
    });
  }

  async listByProduct(productId, tenantId, options = {}) {
    const { page = 1, limit = 20, variantId } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { productId, tenantId };
    if (variantId !== undefined) {
      where.variantId = variantId === 'null' ? null : variantId;
    }

    const [images, total] = await Promise.all([
      this.prisma.productImage.findMany({
        where,
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
      this.prisma.productImage.count({ where }),
    ]);

    return {
      data: images,
      meta: { page, limit: take, total, totalPages: Math.ceil(total / take) },
    };
  }

  async update(id, tenantId, data) {
    return this.prisma.productImage.update({
      where: { id },
      data: {
        altText: data.altText,
        sortOrder: data.sortOrder,
        isPrimary: data.isPrimary,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.productImage.delete({
      where: { id },
    });
  }

  async setPrimary(id, tenantId, productId, variantId = null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.productImage.updateMany({
        where: { productId, tenantId, variantId: variantId ?? null, isPrimary: true },
        data: { isPrimary: false },
      });

      return tx.productImage.update({
        where: { id },
        data: { isPrimary: true },
      });
    });
  }
}