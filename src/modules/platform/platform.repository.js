import { getPrismaClient } from '../../config/database.js';

export class PlatformRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async listTenants({ page = 1, limit = 20, status, search } = {}) {
    // Normalize pagination: query strings arrive as strings, Prisma requires Int
    page = Number(page);
    limit = Number(limit);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(limit) || limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    const where = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }
    // Exclude platform internal tenant
    where.slug = where.slug ? where.slug : { not: '__platform' };
    if (where.slug && typeof where.slug === 'object' && where.slug.not) {
      // already set
    } else if (!where.slug) {
      where.slug = { not: '__platform' };
    }

    // If status and slug filter both present, keep both
    const actualWhere = { ...where };
    if (status) actualWhere.status = status;
    // Ensure platform tenant excluded regardless
    actualWhere.slug = { not: '__platform' };
    if (search) {
      actualWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (page - 1) * limit;
    // Ensure skip/take are integers for Prisma
    const safeSkip = Number.isInteger(skip) && skip >= 0 ? skip : 0;
    const safeTake = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const [data, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where: actualWhere,
        orderBy: { createdAt: 'desc' },
        skip: safeSkip,
        take: safeTake,
        include: { settings: true, domains: true },
      }),
      this.prisma.tenant.count({ where: actualWhere }),
    ]);
    return { data, total, page, limit };
  }

  async findTenantById(id) {
    return this.prisma.tenant.findUnique({
      where: { id },
      include: { settings: true, domains: true },
    });
  }

  async findTenantBySlug(slug) {
    return this.prisma.tenant.findUnique({
      where: { slug },
      include: { settings: true, domains: true },
    });
  }

  async existsBySlug(slug) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    return !!tenant;
  }
}
