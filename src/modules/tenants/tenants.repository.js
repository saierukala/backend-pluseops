import { getPrismaClient } from '../../config/database.js';

export class TenantRepository {
  async create(data) {
    const prisma = getPrismaClient();
    return prisma.tenant.create({
      data: {
        name: data.name,
        slug: data.slug,
        status: data.status || 'TRIAL',
        plan: data.plan || 'free',
      },
      include: {
        settings: true,
        domains: true,
      },
    });
  }

  async findById(id) {
    const prisma = getPrismaClient();
    return prisma.tenant.findUnique({
      where: { id },
      include: {
        settings: true,
        domains: true,
      },
    });
  }

  async findBySlug(slug) {
    const prisma = getPrismaClient();
    return prisma.tenant.findUnique({
      where: { slug },
      include: {
        settings: true,
        domains: true,
      },
    });
  }

  async update(id, data) {
    const prisma = getPrismaClient();
    return prisma.tenant.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug,
        status: data.status,
        plan: data.plan,
      },
      include: {
        settings: true,
        domains: true,
      },
    });
  }

  async delete(id) {
    const prisma = getPrismaClient();
    return prisma.tenant.delete({
      where: { id },
    });
  }

  async existsBySlug(slug) {
    const prisma = getPrismaClient();
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true },
    });
    return !!tenant;
  }
}