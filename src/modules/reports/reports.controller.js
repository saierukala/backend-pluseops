import { reportService } from './reports.service.js';
import { reportScheduleService } from './report-schedules.service.js';

function clientFrom(req) {
  return { ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null };
}

export async function createReport(req, res, next) {
  try {
    const report = await reportService.request(req.context, req.body, clientFrom(req));
    res.status(202).json({ success: true, data: report, message: 'Report requested' });
  } catch (error) { next(error); }
}

export async function listReports(req, res, next) {
  try {
    const result = await reportService.list(req.context.tenantId, res.locals.query);
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Reports retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getReport(req, res, next) {
  try {
    const report = await reportService.getById(req.context.tenantId, req.params.id);
    res.status(200).json({ success: true, data: report, message: 'Report retrieved successfully' });
  } catch (error) { next(error); }
}

export async function downloadReport(req, res, next) {
  try {
    const download = await reportService.download(req.context, req.params.id);
    res.status(200).json({ success: true, data: download, message: 'Download link created' });
  } catch (error) { next(error); }
}

// ── Phase 36: schedules ────────────────────────────────────────────────

export async function createReportSchedule(req, res, next) {
  try {
    const schedule = await reportScheduleService.create(req.context, req.body, clientFrom(req));
    res.status(201).json({ success: true, data: schedule, message: 'Report schedule created' });
  } catch (error) { next(error); }
}

export async function listReportSchedules(req, res, next) {
  try {
    const result = await reportScheduleService.list(req.context.tenantId, res.locals.query);
    res.status(200).json({ success: true, data: result.data, meta: result.meta, message: 'Report schedules retrieved successfully' });
  } catch (error) { next(error); }
}

export async function getReportSchedule(req, res, next) {
  try {
    res.status(200).json({ success: true, data: await reportScheduleService.get(req.context.tenantId, req.params.id), message: 'Report schedule retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateReportSchedule(req, res, next) {
  try {
    const schedule = await reportScheduleService.update(req.context, req.params.id, req.body, clientFrom(req));
    res.status(200).json({ success: true, data: schedule, message: 'Report schedule updated' });
  } catch (error) { next(error); }
}

export async function deleteReportSchedule(req, res, next) {
  try {
    await reportScheduleService.remove(req.context, req.params.id, clientFrom(req));
    res.status(204).send();
  } catch (error) { next(error); }
}
