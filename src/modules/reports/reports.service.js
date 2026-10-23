import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { getUserPermissions } from '../auth/authorization.middleware.js';
import { auditService } from '../audit/audit.service.js';
import { logger } from '../../config/logger.js';
import { REPORT_DEFINITIONS, MAX_ROWS } from './reports.builders.js';
import { csvLine } from './reports.csv.js';
import { env } from '../../config/env.js';

export const DOWNLOAD_URL_TTL_SECONDS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;

const notFound = () => new AppError('Report not found', { statusCode: 404, code: 'REPORT_NOT_FOUND' });

function toReport(r) {
  return {
    id: r.id, type: r.type, format: r.format, status: r.status, filters: r.filters,
    rowCount: r.rowCount, sizeBytes: r.sizeBytes, error: r.error, requestedBy: r.requestedBy, scheduleId: r.scheduleId ?? null,
    startedAt: r.startedAt, completedAt: r.completedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    // Phase 36: when the retention job deletes it (null = kept forever)
    expiresAt: env.REPORT_RETENTION_DAYS ? new Date(r.createdAt.getTime() + env.REPORT_RETENTION_DAYS * DAY_MS) : null,
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

  async request(context, { type, filters = {} }, client = {}, { scheduleId = null } = {}) {
    await this.assertCanRead(type, context);
    const { tenantId, userId } = context;
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.report.create({ data: { tenantId, requestedBy: userId, type, filters, scheduleId } });
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
      const completed = await this.prisma.report.update({
        where: { id: reportId },
        data: { status: 'COMPLETED', storageKey, rowCount, sizeBytes: buffer.length, completedAt: new Date() },
      });
      if (completed.scheduleId) {
        // The report is done either way; a mail problem must not mark it failed
        try {
          const { reportScheduleService } = await import('./report-schedules.service.js');
          await reportScheduleService.notifyRecipients(completed);
        } catch (err) {
          logger.warn({ err: err?.message, tenantId, reportId }, 'Scheduled report recipients not notified');
        }
      }
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

  /**
   * Phase 36 retention: deletes reports (and their files) created more than REPORT_RETENTION_DAYS ago, any status.
   * A file already gone is fine; a file that can't be deleted keeps its row for the next run.
   */
  async prune(now = new Date(), { tenantId = null } = {}) {
    if (!env.REPORT_RETENTION_DAYS) return { deleted: 0, retentionDays: 0 };
    const cutoff = new Date(now.getTime() - env.REPORT_RETENTION_DAYS * DAY_MS);
    let deleted = 0;
    let failed = 0;
    for (;;) {
      const batch = await this.prisma.report.findMany({
        where: { createdAt: { lt: cutoff }, ...(tenantId ? { tenantId } : {}) },
        orderBy: { createdAt: 'asc' }, take: PRUNE_BATCH, skip: failed, select: { id: true, tenantId: true, storageKey: true },
      });
      if (!batch.length) break;
      const removable = [];
      for (const r of batch) {
        try {
          if (r.storageKey) await this.storage.delete(r.storageKey);
          removable.push(r.id);
        } catch (err) {
          failed += 1;
          logger.warn({ err: err?.message, tenantId: r.tenantId, reportId: r.id }, 'Report file could not be deleted; kept for the next run');
        }
      }
      if (removable.length) deleted += (await this.prisma.report.deleteMany({ where: { id: { in: removable } } })).count;
      if (batch.length < PRUNE_BATCH) break;
    }
    return { deleted, failed, retentionDays: env.REPORT_RETENTION_DAYS, cutoff };
  }
}

export const reportService = new ReportService();
