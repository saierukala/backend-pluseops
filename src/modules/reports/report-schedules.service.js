import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { REPORT_DEFINITIONS } from './reports.builders.js';
import { reportService } from './reports.service.js';

// Phase 36: a schedule re-requests a report each day/week/month for the period that just ended. Periods are UTC days,
// like the report filters. The creator's permissions apply at every run; recipients (staff of the same tenant) get
// a link to the report in the staff app by email, never the data itself.

const notFound = () => new AppError('Report schedule not found', { statusCode: 404, code: 'REPORT_SCHEDULE_NOT_FOUND' });
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** The most recent period of this frequency that has fully ended at `now`: { key, from, to } (UTC days). */
export function latestCompletedPeriod(frequency, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (frequency === 'DAILY') {
    const d = day(addDays(today, -1));
    return { key: d, from: d, to: d };
  }
  if (frequency === 'WEEKLY') {
    // ISO weeks run Monday–Sunday: the last full one ends on the most recent Sunday before today
    const sinceMonday = (today.getUTCDay() + 6) % 7;
    const monday = addDays(today, -sinceMonday - 7);
    return { key: `week-of-${day(monday)}`, from: day(monday), to: day(addDays(monday, 6)) };
  }
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  return { key: day(first).slice(0, 7), from: day(first), to: day(last) };
}

function toSchedule(s) {
  return {
    id: s.id, name: s.name, type: s.type, frequency: s.frequency, filters: s.filters, recipientUserIds: s.recipientUserIds,
    enabled: s.enabled, createdBy: s.createdBy, lastPeriod: s.lastPeriod, lastRunAt: s.lastRunAt, lastReportId: s.lastReportId,
    lastError: s.lastError, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

export class ReportScheduleService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  /** Recipients must be active staff of this tenant; returns them with their emails. */
  async activeStaff(tenantId, userIds) {
    if (!userIds.length) return [];
    return this.prisma.user.findMany({
      where: { id: { in: userIds }, status: 'ACTIVE', deletedAt: null, memberships: { some: { tenantId, status: 'ACTIVE' } } },
      select: { id: true, email: true, firstName: true },
    });
  }

  async assertRecipients(tenantId, userIds) {
    const found = await this.activeStaff(tenantId, userIds);
    const missing = userIds.filter((id) => !found.some((u) => u.id === id));
    if (missing.length) {
      throw new AppError('Recipients must be active users of this workspace', { statusCode: 400, code: 'INVALID_RECIPIENTS', details: { userIds: missing } });
    }
  }

  async log(tenantId, auditContext, action, resourceId, oldValue, newValue) {
    await auditService.logAudit({
      tenantId, userId: auditContext.userId ?? null, action, resource: 'report_schedule', resourceId, oldValue, newValue,
      ipAddress: auditContext.ipAddress ?? null, userAgent: auditContext.userAgent ?? null,
    });
  }

  async create(context, { name, type, frequency, filters = {}, recipientUserIds, enabled = true }, auditContext = {}) {
    const { tenantId, userId } = context;
    await reportService.assertCanRead(type, context);
    const recipients = [...new Set(recipientUserIds?.length ? recipientUserIds : [userId])];
    await this.assertRecipients(tenantId, recipients);
    const created = await this.prisma.reportSchedule.create({
      data: {
        tenantId, createdBy: userId, name, type, frequency, filters, recipientUserIds: recipients, enabled,
        // The first report covers the next period to end, not one that ended before the schedule existed
        lastPeriod: latestCompletedPeriod(frequency).key,
      },
    });
    await this.log(tenantId, { ...auditContext, userId }, 'CREATE', created.id, null, toSchedule(created));
    return toSchedule(created);
  }

  async list(tenantId, { page = 1, limit = 20 } = {}) {
    const where = { tenantId };
    const [rows, total] = await Promise.all([
      this.prisma.reportSchedule.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.reportSchedule.count({ where }),
    ]);
    return { data: rows.map(toSchedule), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async find(tenantId, id) {
    const row = await this.prisma.reportSchedule.findFirst({ where: { id, tenantId } });
    if (!row) throw notFound();
    return row;
  }

  async get(tenantId, id) {
    return toSchedule(await this.find(tenantId, id));
  }

  async update(context, id, changes, auditContext = {}) {
    const { tenantId } = context;
    const before = await this.find(tenantId, id);
    await reportService.assertCanRead(before.type, context);
    if (changes.recipientUserIds) await this.assertRecipients(tenantId, changes.recipientUserIds);
    if (changes.filters) {
      const allowed = REPORT_DEFINITIONS[before.type].filters;
      const wrong = Object.keys(changes.filters).filter((key) => !allowed.includes(key));
      if (wrong.length) throw new AppError(`${before.type} reports don't accept filters: ${wrong.join(', ')}`, { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    const data = {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.filters !== undefined ? { filters: changes.filters } : {}),
      ...(changes.recipientUserIds ? { recipientUserIds: [...new Set(changes.recipientUserIds)] } : {}),
      ...(changes.enabled !== undefined ? { enabled: changes.enabled, ...(changes.enabled ? { lastError: null } : {}) } : {}),
    };
    if (changes.frequency && changes.frequency !== before.frequency) {
      data.frequency = changes.frequency;
      data.lastPeriod = latestCompletedPeriod(changes.frequency).key;
    }
    // Switching back on resumes from now: no burst of reports for the periods missed while off
    if (changes.enabled === true && !before.enabled) data.lastPeriod = latestCompletedPeriod(data.frequency ?? before.frequency).key;
    const updated = await this.prisma.reportSchedule.update({ where: { id }, data });
    await this.log(tenantId, { ...auditContext, userId: context.userId }, 'UPDATE', id, toSchedule(before), toSchedule(updated));
    return toSchedule(updated);
  }

  async remove(context, id, auditContext = {}) {
    const before = await this.find(context.tenantId, id);
    await this.prisma.reportSchedule.delete({ where: { id } });
    await this.log(context.tenantId, { ...auditContext, userId: context.userId }, 'DELETE', id, toSchedule(before), null);
  }

  /**
   * Worker tick: requests a report for every enabled schedule whose latest completed period hasn't run yet.
   * Claiming the period with a conditional update makes concurrent ticks (two workers) run it once.
   */
  async runDue(now = new Date()) {
    const due = await this.prisma.reportSchedule.findMany({
      where: { enabled: true, tenant: { status: { in: ['ACTIVE', 'TRIAL'] } } },
      orderBy: { id: 'asc' },
    });
    const results = [];
    for (const schedule of due) {
      const period = latestCompletedPeriod(schedule.frequency, now);
      if (schedule.lastPeriod === period.key) continue;
      const { count } = await this.prisma.reportSchedule.updateMany({
        where: { id: schedule.id, enabled: true, lastPeriod: schedule.lastPeriod },
        data: { lastPeriod: period.key, lastRunAt: now },
      });
      if (count !== 1) continue;
      results.push(await this.runOne(schedule, period));
    }
    return { checked: due.length, ran: results.length, results };
  }

  async runOne(schedule, period) {
    const { tenantId } = schedule;
    const pause = async (reason) => {
      await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { enabled: false, lastError: reason } });
      logger.warn({ tenantId, scheduleId: schedule.id, reason }, 'Report schedule paused');
      return { scheduleId: schedule.id, paused: true, reason };
    };
    if (!schedule.createdBy || !(await this.activeStaff(tenantId, [schedule.createdBy])).length) {
      return pause('The user who created this schedule is no longer active; edit and re-enable it to continue');
    }
    const accepts = REPORT_DEFINITIONS[schedule.type].filters;
    const filters = {
      ...Object.fromEntries(Object.entries(schedule.filters ?? {}).filter(([key]) => accepts.includes(key) && key !== 'from' && key !== 'to')),
      ...(accepts.includes('from') ? { from: period.from, to: period.to } : {}),
    };
    try {
      const report = await reportService.request({ tenantId, userId: schedule.createdBy, scope: 'tenant' }, { type: schedule.type, filters }, {}, { scheduleId: schedule.id });
      await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastReportId: report.id, lastError: null } });
      return { scheduleId: schedule.id, reportId: report.id, period: period.key };
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 403) return pause(`The creator can no longer read ${schedule.type} data`);
      await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastError: err.message?.slice(0, 500) || 'Report request failed' } });
      throw err;
    }
  }

  /** After a scheduled report is built: tell the recipients where to find it. */
  async notifyRecipients(report) {
    const schedule = report.scheduleId ? await this.prisma.reportSchedule.findUnique({ where: { id: report.scheduleId } }) : null;
    if (!schedule) return;
    const recipients = await this.activeStaff(report.tenantId, schedule.recipientUserIds);
    const link = `${env.APP_URL}/reports/${report.id}`;
    const period = report.filters?.from ? ` for ${report.filters.from === report.filters.to ? report.filters.from : `${report.filters.from} to ${report.filters.to}`}` : '';
    const { enqueueEmail } = await import('../../jobs/queues/email.queue.js');
    for (const user of recipients) {
      try {
        await enqueueEmail({
          tenantId: report.tenantId,
          to: user.email,
          subject: `${schedule.name}: report ready${period}`,
          text: `${user.firstName ? `Hi ${user.firstName},` : 'Hi,'}\n\nYour ${schedule.frequency.toLowerCase()} ${report.type.toLowerCase()} report${period} is ready (${report.rowCount ?? 0} rows). Sign in to download it:\n${link}\n\nFiles are kept for ${env.REPORT_RETENTION_DAYS || 'an unlimited number of'} days.`,
          template: 'report.scheduled_ready',
          variables: { scheduleName: schedule.name, link, period: period.trim(), rowCount: String(report.rowCount ?? 0) },
        });
      } catch (err) {
        logger.warn({ err: err?.message, tenantId: report.tenantId, reportId: report.id }, 'Could not send scheduled report email');
      }
    }
  }
}

export const reportScheduleService = new ReportScheduleService();
