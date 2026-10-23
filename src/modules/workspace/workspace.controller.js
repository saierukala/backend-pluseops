import { WorkspaceService } from './workspace.service.js';

const workspaceService = new WorkspaceService();

function auditContextFrom(req) {
  return {
    userId: req.context.userId,
    ipAddress: req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

export async function getWorkspace(req, res, next) {
  try {
    const workspace = await workspaceService.get(req.context.tenantId);
    res.status(200).json({ success: true, data: workspace, message: 'Workspace retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateWorkspace(req, res, next) {
  try {
    const workspace = await workspaceService.updateName(req.context.tenantId, req.body.name, auditContextFrom(req));
    res.status(200).json({ success: true, data: workspace, message: 'Workspace updated successfully' });
  } catch (error) { next(error); }
}

export async function getSettings(req, res, next) {
  try {
    const settings = await workspaceService.getSettings(req.context.tenantId);
    res.status(200).json({ success: true, data: settings, message: 'Settings retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updateSettings(req, res, next) {
  try {
    const settings = await workspaceService.updateSettings(req.context.tenantId, req.body, auditContextFrom(req));
    res.status(200).json({ success: true, data: settings, message: 'Settings updated successfully' });
  } catch (error) { next(error); }
}

export async function listDomains(req, res, next) {
  try {
    const domains = await workspaceService.listDomains(req.context.tenantId);
    res.status(200).json({ success: true, data: domains, message: 'Domains retrieved successfully' });
  } catch (error) { next(error); }
}

export async function createDomain(req, res, next) {
  try {
    const domain = await workspaceService.addDomain(req.context.tenantId, req.body.domain, auditContextFrom(req));
    res.status(201).json({ success: true, data: domain, message: 'Domain added successfully' });
  } catch (error) { next(error); }
}

export async function updateDomain(req, res, next) {
  try {
    const domain = await workspaceService.makePrimary(req.context.tenantId, req.params.domainId, auditContextFrom(req));
    res.status(200).json({ success: true, data: domain, message: 'Primary domain updated successfully' });
  } catch (error) { next(error); }
}

export async function deleteDomain(req, res, next) {
  try {
    await workspaceService.removeDomain(req.context.tenantId, req.params.domainId, auditContextFrom(req));
    res.status(200).json({ success: true, data: null, message: 'Domain removed successfully' });
  } catch (error) { next(error); }
}
