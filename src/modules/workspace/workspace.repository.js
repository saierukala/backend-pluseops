import { getPrismaClient } from '../../config/database.js';

const TENANT_FIELDS = { id: true, name: true, slug: true, status: true, plan: true, createdAt: true, updatedAt: true };
const DOMAIN_ORDER = [{ primary: 'desc' }, { createdAt: 'asc' }];

export class WorkspaceRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async findTenant(tenantId, tx = this.prisma) {
    return tx.tenant.findUnique({
      where: { id: tenantId },
      select: { ...TENANT_FIELDS, settings: { select: { metadata: true, updatedAt: true } }, domains: { orderBy: DOMAIN_ORDER } },
    });
  }

  async updateTenantName(tenantId, name, tx = this.prisma) {
    return tx.tenant.update({ where: { id: tenantId }, data: { name }, select: TENANT_FIELDS });
  }

  async findSettings(tenantId, tx = this.prisma) {
    return tx.tenantSettings.findUnique({ where: { tenantId } });
  }

  async saveSettings(tenantId, metadata, tx = this.prisma) {
    return tx.tenantSettings.upsert({ where: { tenantId }, update: { metadata }, create: { tenantId, metadata } });
  }

  async listDomains(tenantId) {
    return this.prisma.tenantDomain.findMany({ where: { tenantId }, orderBy: DOMAIN_ORDER });
  }

  async findDomainByName(domain) {
    return this.prisma.tenantDomain.findUnique({ where: { domain } });
  }

  async findDomain(domainId, tenantId, tx = this.prisma) {
    return tx.tenantDomain.findFirst({ where: { id: domainId, tenantId } });
  }

  async createDomain(tenantId, domain, tx = this.prisma) {
    return tx.tenantDomain.create({ data: { tenantId, domain } });
  }

  async deleteDomain(domainId, tx = this.prisma) {
    return tx.tenantDomain.delete({ where: { id: domainId } });
  }

  async setPrimary(domainId, tenantId, tx = this.prisma) {
    await tx.tenantDomain.updateMany({ where: { tenantId, primary: true }, data: { primary: false } });
    return tx.tenantDomain.update({ where: { id: domainId }, data: { primary: true } });
  }

  // Keeps "a tenant with domains has exactly one primary"; the oldest domain takes over.
  async ensurePrimary(tenantId, tx = this.prisma) {
    const primary = await tx.tenantDomain.findFirst({ where: { tenantId, primary: true }, select: { id: true } });
    if (primary) return;
    const oldest = await tx.tenantDomain.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (oldest) await tx.tenantDomain.update({ where: { id: oldest.id }, data: { primary: true } });
  }
}
