import { logPlatformAction, platformActorFrom } from '../platform-ops/platform-audit.js';
import { supportService } from './support.service.js';

function clientFrom(req) {
  return { ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null };
}

export async function startSupportSession(req, res, next) {
  try {
    const result = await supportService.start(req.context, req.params.id, req.body.reason, clientFrom(req));
    await logPlatformAction(platformActorFrom(req), { action: 'support.start', targetType: 'support_session', targetId: result.sessionId, tenantId: req.params.id, details: { reason: req.body.reason, expiresAt: result.expiresAt } });
    res.status(201).json({ success: true, data: result, message: 'Read-only support session started' });
  } catch (error) { next(error); }
}

export async function endSupportSession(req, res, next) {
  try {
    await supportService.end(req.context, req.params.sessionId, clientFrom(req));
    await logPlatformAction(platformActorFrom(req), { action: 'support.end', targetType: 'support_session', targetId: req.params.sessionId });
    res.status(200).json({ success: true, data: null, message: 'Support session ended' });
  } catch (error) { next(error); }
}
