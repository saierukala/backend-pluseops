import { z } from 'zod';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { checkTemplate } from './notification-templates.validation.js';
import { renderTemplate } from './template.renderer.js';

const notFound = () => new AppError('Template not found', { statusCode: 404, code: 'TEMPLATE_NOT_FOUND' });
const exists = () => new AppError('A template with this name already exists for this channel', { statusCode: 409, code: 'TEMPLATE_EXISTS' });

function toTemplate(t) {
  return {
    id: t.id, name: t.name, channel: t.channel, subject: t.subject, body: t.body,
    variables: Array.isArray(t.variables) ? t.variables : [], isActive: t.isActive, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

export class NotificationTemplateService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async log(tx, ctx, { tenantId, action, resourceId, oldValue, newValue, description }) {
    const { userId = null, ipAddress = null, userAgent = null } = ctx;
    await auditService.logAudit({ tenantId, userId, action, resource: 'notification_template', resourceId, oldValue, newValue, ipAddress, userAgent, tx });
    await auditService.logActivity({ tenantId, userId, action: `notification_template.${action.toLowerCase()}`, description, metadata: { resourceId }, ipAddress, userAgent, tx });
  }

  async get(tenantId, id) {
    const template = await this.prisma.notificationTemplate.findFirst({ where: { id, tenantId } });
    if (!template) throw notFound();
    return template;
  }

  async getById(tenantId, id) {
    return toTemplate(await this.get(tenantId, id));
  }

  async list(tenantId, { page = 1, limit = 20, channel, isActive, search } = {}) {
    const where = { tenantId };
    if (channel) where.channel = channel;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) where.name = { contains: search, mode: 'insensitive' };
    const take = Math.min(limit, 100);
    const [rows, total] = await Promise.all([
      this.prisma.notificationTemplate.findMany({ where, orderBy: [{ name: 'asc' }, { channel: 'asc' }], skip: (page - 1) * take, take }),
      this.prisma.notificationTemplate.count({ where }),
    ]);
    return { data: rows.map(toTemplate), meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async create(tenantId, data, ctx = {}) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.notificationTemplate.create({
          data: { tenantId, name: data.name, channel: data.channel, subject: data.subject ?? null, body: data.body, variables: data.variables, isActive: data.isActive ?? true },
        });
        await this.log(tx, ctx, { tenantId, action: 'CREATE', resourceId: created.id, oldValue: null, newValue: toTemplate(created), description: `Template ${created.name} (${created.channel}) created` });
        return toTemplate(created);
      });
    } catch (err) {
      if (err?.code === 'P2002') throw exists();
      throw err;
    }
  }

  async update(tenantId, id, changes, ctx = {}) {
    const existing = toTemplate(await this.get(tenantId, id));
    const merged = { ...existing, ...changes };
    // Re-check the template as a whole: a body edit may use a variable the stored list doesn't declare.
    const issues = [];
    checkTemplate(merged, { addIssue: (issue) => issues.push(issue) });
    if (issues.length) throw new z.ZodError(issues.map((i) => ({ ...i, path: ['body', ...i.path] })));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.notificationTemplate.update({
          where: { id },
          data: { name: changes.name, channel: changes.channel, subject: changes.subject, body: changes.body, variables: changes.variables, isActive: changes.isActive },
        });
        await this.log(tx, ctx, { tenantId, action: 'UPDATE', resourceId: id, oldValue: existing, newValue: toTemplate(updated), description: `Template ${updated.name} (${updated.channel}) updated` });
        return toTemplate(updated);
      });
    } catch (err) {
      if (err?.code === 'P2002') throw exists();
      throw err;
    }
  }

  async delete(tenantId, id, ctx = {}) {
    const existing = toTemplate(await this.get(tenantId, id));
    await this.prisma.$transaction(async (tx) => {
      await tx.notificationTemplate.delete({ where: { id } });
      await this.log(tx, ctx, { tenantId, action: 'DELETE', resourceId: id, oldValue: existing, newValue: null, description: `Template ${existing.name} (${existing.channel}) deleted` });
    });
  }

  async preview(tenantId, id, variables) {
    return renderTemplate(await this.get(tenantId, id), variables);
  }
}

export const notificationTemplateService = new NotificationTemplateService();
