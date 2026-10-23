import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';
import { signAccessToken } from '../auth/jwt.util.js';
import { SYSTEM_PERMISSIONS } from '../permissions/system-permissions.js';

/**
 * Phase 30 (frontend F33): read-only platform support access to one tenant.
 *
 * A platform admin with `platform:tenant:access` opens a support session with a reason and gets a short-lived
 * `scope: "support"` access token for that tenant (no refresh token). With it only GET/HEAD requests and `*:read`
 * permissions pass; every request is written to the tenant's activity log under the platform admin's user id,
 * and the start/end of the session to the tenant's audit log. Ending the session, its expiry, losing the
 * permission or the tenant being suspended cuts the token off immediately.
 */
export const SUPPORT_SESSION_MINUTES = 30;
export const SUPPORT_ACCESS_PERMISSION = { resource: 'platform:tenant', action: 'access' };
const PLATFORM_TENANT_SLUG = '__platform';
const READ_PERMISSIONS = SYSTEM_PERMISSIONS.filter((p) => p.action === 'read').map((p) => p.name).sort();

const isActiveTenant = (tenant) => tenant && tenant.slug !== PLATFORM_TENANT_SLUG && (tenant.status === 'ACTIVE' || tenant.status === 'TRIAL');

export class SupportService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async start(platformUser, tenantId, reason, client = {}) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.slug === PLATFORM_TENANT_SLUG) throw new AppError('Tenant not found', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
    if (!isActiveTenant(tenant)) throw new AppError('Tenant is not active', { statusCode: 409, code: 'TENANT_INACTIVE' });

    const expiresAt = new Date(Date.now() + SUPPORT_SESSION_MINUTES * 60 * 1000);
    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportSession.create({ data: { tenantId, platformUserId: platformUser.userId, reason, expiresAt } });
      await auditService.logAudit({
        tenantId, userId: platformUser.userId, action: 'LOGIN', resource: 'support_session', resourceId: created.id,
        oldValue: null, newValue: { platformUser: platformUser.email, reason, readOnly: true, expiresAt },
        ipAddress: client.ipAddress, userAgent: client.userAgent, tx,
      });
      await auditService.logActivity({
        tenantId, userId: platformUser.userId, action: 'support.session.start',
        description: `Platform support (${platformUser.email}) opened a read-only session: ${reason}`,
        metadata: { supportSessionId: created.id }, ipAddress: client.ipAddress, userAgent: client.userAgent, tx,
      });
      return created;
    });

    const accessToken = signAccessToken(
      { sub: platformUser.userId, tenantId, sessionId: session.id, email: platformUser.email, scope: 'support' },
      { expiresIn: SUPPORT_SESSION_MINUTES * 60 },
    );
    return {
      sessionId: session.id,
      accessToken,
      expiresAt,
      readOnly: true,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  }

  // Only the platform admin who opened a session can end it; ending twice is a no-op.
  async end(platformUser, sessionId, client = {}) {
    const session = await this.prisma.supportSession.findFirst({ where: { id: sessionId, platformUserId: platformUser.userId } });
    if (!session) throw new AppError('Support session not found', { statusCode: 404, code: 'SUPPORT_SESSION_NOT_FOUND' });
    if (session.endedAt) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.supportSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
      await auditService.logAudit({
        tenantId: session.tenantId, userId: platformUser.userId, action: 'LOGOUT', resource: 'support_session', resourceId: sessionId,
        oldValue: null, newValue: { platformUser: platformUser.email }, ipAddress: client.ipAddress, userAgent: client.userAgent, tx,
      });
    });
  }

  // The live session behind a support token, or null if it ended, expired, or its holder lost access.
  async findActive(decoded) {
    const session = await this.prisma.supportSession.findFirst({
      where: { id: decoded.sessionId, platformUserId: decoded.sub, tenantId: decoded.tenantId, endedAt: null, expiresAt: { gt: new Date() } },
      include: { tenant: true, platformUser: true },
    });
    if (!session || !isActiveTenant(session.tenant) || session.platformUser.status !== 'ACTIVE') return null;
    const grant = await this.prisma.platformUserRole.findFirst({
      where: { userId: decoded.sub, role: { permissions: { some: { permission: SUPPORT_ACCESS_PERMISSION } } } },
      select: { id: true },
    });
    return grant ? session : null;
  }

  // GET /auth/me for a support token: who is looking, at which tenant, and what the UI may show.
  async describe(context) {
    const session = await this.prisma.supportSession.findUnique({ where: { id: context.sessionId }, include: { tenant: true, platformUser: true } });
    const { platformUser: user, tenant } = session;
    return {
      id: user.id,
      tenantId: tenant.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      scope: 'support',
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, plan: tenant.plan },
      support: { sessionId: session.id, readOnly: true, reason: session.reason, expiresAt: session.expiresAt },
      roles: [],
      permissions: READ_PERMISSIONS,
    };
  }

  logRequest(req, statusCode) {
    const { tenantId, userId, support } = req.context;
    auditService.logActivity({
      tenantId, userId, action: 'support.view',
      description: `${req.method} ${req.originalUrl.split('?')[0]}`,
      metadata: { supportSessionId: support.sessionId, statusCode },
      ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null,
    }).catch(() => {});
  }
}

export const supportService = new SupportService();
