import { getPrismaClient } from '../../config/database.js';

export class VariantRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async create(data, tenantId, productId) {
    return this.prisma.productVariant.create({
      data: {
        tenantId,
        productId,
        sku: data.sku,
        barcode: data.barcode,
        price: data.price,
        costPrice: data.costPrice,
        status: data.status ?? 'DRAFT',
      },
    });
  }

  async findById(id, tenantId) {
    return this.prisma.productVariant.findFirst({
      where: { id, tenantId },
      include: {
        product: true,
        attributes: {
          include: { attributeDefinition: true },
        },
        images: true,
      },
    });
  }

  async findBySku(sku, tenantId) {
    return this.prisma.productVariant.findFirst({
      where: { sku, tenantId },
    });
  }

  async listByProduct(productId, tenantId, options = {}) {
    const {
      page = 1,
      limit = 20,
      status,
      sortBy = 'createdAt',
      sortOrder = 'asc',
    } = options;

    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);

    const where = { productId, tenantId };

    if (status) {
      where.status = status;
    }

    const allowedSortFields = ['sku', 'price', 'status', 'createdAt', 'updatedAt'];
    const allowedSortOrders = ['asc', 'desc'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
    const safeSortOrder = allowedSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'asc';

    const [variants, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where,
        include: {
          attributes: {
            include: { attributeDefinition: { select: { id: true, name: true, code: true, dataType: true } } },
          },
          images: { where: { isPrimary: true }, take: 1 },
        },
        orderBy: { [safeSortBy]: safeSortOrder },
        skip,
        take,
      }),
      this.prisma.productVariant.count({ where }),
    ]);

    return {
      data: variants,
      meta: {
        page,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  async update(id, tenantId, data) {
    return this.prisma.productVariant.update({
      where: { id },
      data: {
        sku: data.sku,
        barcode: data.barcode,
        price: data.price,
        costPrice: data.costPrice,
        status: data.status,
      },
    });
  }

  async delete(id, _tenantId) {
    return this.prisma.productVariant.delete({
      where: { id },
    });
  }

  async setAttributes(variantId, tenantId, attributes) {
    return this.prisma.$transaction(async (tx) => {
      await tx.productVariantAttribute.deleteMany({
        where: { variantId, tenantId },
      });

      if (attributes && attributes.length > 0) {
        const attrDefs = await tx.attributeDefinition.findMany({
          where: { id: { in: attributes.map(a => a.attributeDefinitionId) }, tenantId },
          select: { id: true, dataType: true },
        });

        const attrDefMap = new Map(attrDefs.map(a => [a.id, a.dataType]));

        for (const attr of attributes) {
          const attrDef = attrDefMap.get(attr.attributeDefinitionId);
          if (!attrDef) {
            const { AppError } = await import('../../common/errors/app-error.js');
            throw new AppError(`Attribute definition ${attr.attributeDefinitionId} not found`, {
              statusCode: 404,
              code: 'ATTRIBUTE_NOT_FOUND',
            });
          }

          if (!this.validateAttributeValue(attrDef, attr.value)) {
            const { AppError } = await import('../../common/errors/app-error.js');
            throw new AppError(`Invalid value for attribute ${attr.attributeDefinitionId}: expected ${attrDef}`, {
              statusCode: 400,
              code: 'INVALID_ATTRIBUTE_VALUE',
            });
          }
        }

        await tx.productVariantAttribute.createMany({
          data: attributes.map((attr) => ({
            tenantId,
            variantId,
            attributeDefinitionId: attr.attributeDefinitionId,
            value: attr.value,
          })),
          skipDuplicates: true,
        });
      }

      return tx.productVariantAttribute.findMany({
        where: { variantId, tenantId },
        include: { attributeDefinition: true },
      });
    });
  }

  validateAttributeValue(dataType, value) {
    switch (dataType) {
      case 'NUMBER':
        return !isNaN(Number(value));
      case 'BOOLEAN':
        return value === 'true' || value === 'false';
      case 'OPTION':
      case 'TEXT':
        return typeof value === 'string';
      default:
        return true;
    }
  }

  async getAttributes(variantId, tenantId) {
    return this.prisma.productVariantAttribute.findMany({
      where: { variantId, tenantId },
      include: { attributeDefinition: true },
    });
  }
}