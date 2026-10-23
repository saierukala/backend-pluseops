import { reportService } from './reports.service.js';

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
