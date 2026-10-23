import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { getUserPermissions } from '../auth/authorization.middleware.js';
import { auditService } from '../audit/audit.service.js';
import { logger } from '../../config/logger.js';
import { REPORT_DEFINITIONS, MAX_ROWS } from './reports.builders.js';
import { csvLine } from './reports.csv.js';

export const DOWNLOAD_URL_TTL_SECONDS = 300;

const notFound = () => new AppError('Report not found', { statusCode: 404, code: 'REPORT_NOT_FOUND' });

function toReport(r) {
  return {
    id: r.id, type: r.type, format: r.format, status: r.status, filters: r.filters,
    rowCount: r.rowCount, sizeBytes: r.sizeBytes, error: r.error, requestedBy: r.requestedBy,
    startedAt: r.startedAt, completedAt: r.completedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export class ReportService {
  constructor() {
    this.prisma = getPrismaClient();
    this.storage = new StorageService();
  }

  // A report exposes the rows behind it, so the caller also needs that data's read permission
  // (e.g. a CUSTOMERS export needs customer:read). Read-only support sessions may read everything.
  async assertCanRead(type, context) {
    if (context.scope === 'support') return;
    const { permission } = REPORT_DEFINITIONS[type];
    const [resource, action] = permission.split(':');
    const granted = await getUserPermissions(context.userId, context.tenantId);
    if (!granted.some((p) => p.resource === resource && p.action === action)) {
      throw new AppError(`${type} reports need ${permission}`, { statusCode: 403, code: 'FORBIDDEN' });
    }
  }

  async request(context, { type, filters = {} }, client = {}) {
    await this.assertCanRead(type, context);
    const { tenantId, userId } = context;
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.report.create({ data: { tenantId, requestedBy: userId, type, filters } });
      await auditService.logAudit({
        tenantId, userId, action: 'EXPORT', resource: 'report', resourceId: created.id, oldValue: null, newValue: { type, filters },
        ipAddress: client.ipAddress, userAgent: client.userAgent, tx,
      });
      return created;
    });
    const { enqueueReport } = await import('../../jobs/queues/report.queue.js');
    await enqueueReport({ tenantId, userId, reportId: report.id, reportType: type });
    return toReport(await this.prisma.report.findUnique({ where: { id: report.id } }));
  }

  async list(tenantId, { page = 1, limit = 20, type, status } = {}) {
    const where = { tenantId, ...(type ? { type } : {}), ...(status ? { status } : {}) };
    const take = Math.min(limit, 100);
    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * take, take }),
      this.prisma.report.count({ where }),
    ]);
    return { data: rows.map(toReport), meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async get(tenantId, id) {
    const report = await this.prisma.report.findFirst({ where: { id, tenantId } });
    if (!report) throw notFound();
    return report;
  }

  async getById(tenantId, id) {
    return toReport(await this.get(tenantId, id));
  }

  async download(context, id) {
    const report = await this.get(context.tenantId, id);
    await this.assertCanRead(report.type, context);
    if (report.status !== 'COMPLETED') {
      throw new AppError(`Report is ${report.status.toLowerCase()}, not ready to download`, { statusCode: 409, code: 'REPORT_NOT_READY' });
    }
    const url = await this.storage.getSignedUrl(report.storageKey, DOWNLOAD_URL_TTL_SECONDS);
    return {
      url,
      fileName: `${report.type.toLowerCase()}-${report.createdAt.toISOString().slice(0, 10)}-${report.id.slice(0, 8)}.csv`,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  /** Worker side: build the CSV, store it under the tenant's prefix, record the outcome. */
  async generate(tenantId, reportId) {
    const report = await this.prisma.report.findFirst({ where: { id: reportId, tenantId } });
    if (!report) return { skipped: true, reason: 'report not found' };
    if (report.status === 'COMPLETED') return { skipped: true, reason: 'already completed' };

    await this.prisma.report.update({ where: { id: reportId }, data: { status: 'PROCESSING', startedAt: new Date(), error: null } });
    try {
      const definition = REPORT_DEFINITIONS[report.type];
      const chunks = [csvLine(definition.header)];
      let rowCount = 0;
      for await (const row of definition.rows(tenantId, report.filters ?? {})) {
        if (++rowCount > MAX_ROWS) throw new AppError(`Report exceeds ${MAX_ROWS} rows; narrow the filters`, { statusCode: 422, code: 'REPORT_TOO_LARGE' });
        chunks.push(csvLine(row));
      }
      // UTF-8 BOM so Excel opens non-ASCII names correctly
      const buffer = Buffer.from(`\uFEFF${chunks.join('')}`, 'utf8');
      const storageKey = `tenants/${tenantId}/reports/${reportId}.csv`;
      await this.storage.upload(storageKey, buffer, 'text/csv');
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'COMPLETED', storageKey, rowCount, sizeBytes: buffer.length, completedAt: new Date() },
      });
      return { reportId, tenantId, status: 'COMPLETED', rowCount };
    } catch (err) {
      logger.warn({ err, tenantId, reportId }, 'Report generation failed');
      await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'FAILED', error: err instanceof AppError ? err.message : 'Report generation failed', completedAt: new Date() },
      });
      throw err;
    }
  }
}

export const reportService = new ReportService();
