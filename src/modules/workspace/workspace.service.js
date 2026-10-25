import crypto from 'node:crypto';
import dns from 'node:dns';
import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { WorkspaceRepository } from './workspace.repository.js';
import { auditService } from '../audit/audit.service.js';
import { logger } from '../../config/logger.js';
import { stateName } from '../gst/india.js';

export const SETTING_KEYS = ['currency', 'timezone', 'locale', 'contactEmail', 'contactPhone', 'gstRatePercent'];

// The same message whether the domain is this tenant's or another's, so the API doesn't reveal who owns it.
const domainTaken = () => new AppError('This domain is already registered', { statusCode: 409, code: 'DOMAIN_TAKEN' });
const domainNotFound = () => new AppError('Domain not found', { statusCode: 404, code: 'DOMAIN_NOT_FOUND' });

export const VERIFICATION_PREFIX = '_pulseops-verify';

function verificationRecord(d) {
  return { type: 'TXT', name: `${VERIFICATION_PREFIX}.${d.domain}`, value: d.verificationToken };
}

export function toSettings(metadata) {
  const settings = {};
  for (const key of SETTING_KEYS) settings[key] = metadata?.[key] ?? null;
  return settings;
}

export const TAX_PROFILE_KEYS = [
  'legalName', 'tradeName', 'registrationType', 'gstin', 'pan', 'stateCode', 'address', 'phone', 'email',
  'bankName', 'accountNumber', 'ifsc', 'upiId', 'signatory', 'invoicePrefix', 'invoiceTerms', 'pricesIncludeTax',
];

function toTaxProfile(profile) {
  const out = {};
  for (const key of TAX_PROFILE_KEYS) out[key] = profile?.[key] ?? null;
  out.stateName = stateName(out.stateCode);
  return out;
}

function toDomain(d) {
  return {
    id: d.id, domain: d.domain, primary: d.primary, verified: d.verified, verifiedAt: d.verifiedAt ?? null,
    // What to publish in DNS to prove ownership; gone once verified
    verification: d.verified ? null : verificationRecord(d),
    createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

export class WorkspaceService {
  constructor() {
    this.repository = new WorkspaceRepository();
    this.prisma = getPrismaClient();
  }

  async log(tx, auditContext, { tenantId, action, resource, resourceId, oldValue, newValue, activity, description }) {
    const { userId = null, ipAddress = null, userAgent = null } = auditContext;
    await auditService.logAudit({ tenantId, userId, action, resource, resourceId, oldValue, newValue, ipAddress, userAgent, tx });
    await auditService.logActivity({ tenantId, userId, action: activity, description, metadata: { resourceId }, ipAddress, userAgent, tx });
  }

  async get(tenantId) {
    const tenant = await this.repository.findTenant(tenantId);
    if (!tenant) throw new AppError('Tenant not found', { statusCode: 404, code: 'TENANT_NOT_FOUND' });
    const { settings, domains, ...profile } = tenant;
    return { ...profile, settings: toSettings(settings?.metadata), domains: domains.map(toDomain) };
  }

  async updateName(tenantId, name, auditContext = {}) {
    const before = await this.get(tenantId);
    await this.prisma.$transaction(async (tx) => {
      await this.repository.updateTenantName(tenantId, name, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'UPDATE', resource: 'tenant', resourceId: tenantId, oldValue: { name: before.name }, newValue: { name },
        activity: 'tenant.update', description: 'Workspace renamed',
      });
    });
    return this.get(tenantId);
  }

  async getSettings(tenantId) {
    return toSettings((await this.repository.findSettings(tenantId))?.metadata);
  }

  // Partial update: given keys are set, null clears them, other stored metadata is kept.
  async updateSettings(tenantId, changes, auditContext = {}) {
    return this.prisma.$transaction(async (tx) => {
      const current = (await this.repository.findSettings(tenantId, tx))?.metadata ?? {};
      const next = { ...current };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      await this.repository.saveSettings(tenantId, next, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'UPDATE', resource: 'tenant_settings', resourceId: tenantId,
        oldValue: toSettings(current), newValue: toSettings(next),
        activity: 'tenant.settings.update', description: `Workspace settings updated (${Object.keys(changes).join(', ')})`,
      });
      return toSettings(next);
    });
  }

  // Phase 38: the GST identity on invoices, kept in TenantSettings.metadata.taxProfile
  async getTaxProfile(tenantId) {
    return toTaxProfile((await this.repository.findSettings(tenantId))?.metadata?.taxProfile);
  }

  async updateTaxProfile(tenantId, changes, auditContext = {}) {
    return this.prisma.$transaction(async (tx) => {
      const metadata = (await this.repository.findSettings(tenantId, tx))?.metadata ?? {};
      const before = metadata.taxProfile ?? {};
      const next = { ...before };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      // A GSTIN carries the state and the PAN; fill them in when they weren't given
      if (next.gstin) {
        next.stateCode ??= next.gstin.slice(0, 2);
        next.pan ??= next.gstin.slice(2, 12);
      }
      if (next.gstin && next.stateCode !== next.gstin.slice(0, 2)) {
        throw new AppError('The GSTIN belongs to a different state than the business state', { statusCode: 400, code: 'GSTIN_STATE_MISMATCH' });
      }
      await this.repository.saveSettings(tenantId, { ...metadata, taxProfile: next }, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'UPDATE', resource: 'tenant_settings', resourceId: tenantId,
        oldValue: { taxProfile: before }, newValue: { taxProfile: next },
        activity: 'tenant.tax_profile.update', description: `Tax profile updated (${Object.keys(changes).join(', ')})`,
      });
      return toTaxProfile(next);
    });
  }

  async listDomains(tenantId) {
    return (await this.repository.listDomains(tenantId)).map(toDomain);
  }

  async addDomain(tenantId, domain, auditContext = {}) {
    // Unverified claims don't reserve a domain (anyone can type one in); a verified one does.
    if (await this.repository.findVerifiedDomain(domain)) throw domainTaken();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await this.repository.createDomain(tenantId, domain, crypto.randomBytes(16).toString('hex'), tx);
        await this.repository.ensurePrimary(tenantId, tx);
        await this.log(tx, auditContext, {
          tenantId, action: 'CREATE', resource: 'tenant_domain', resourceId: created.id, oldValue: null, newValue: { domain },
          activity: 'tenant.domain.create', description: `Domain ${domain} added`,
        });
        return toDomain(await this.repository.findDomain(created.id, tenantId, tx));
      });
    } catch (err) {
      if (err?.code === 'P2002') throw domainTaken();
      throw err;
    }
  }

  async makePrimary(tenantId, domainId, auditContext = {}) {
    const existing = await this.repository.findDomain(domainId, tenantId);
    if (!existing) throw domainNotFound();
    if (existing.primary) return toDomain(existing);
    return this.prisma.$transaction(async (tx) => {
      const updated = await this.repository.setPrimary(domainId, tenantId, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'UPDATE', resource: 'tenant_domain', resourceId: domainId, oldValue: { primary: false }, newValue: { primary: true },
        activity: 'tenant.domain.primary', description: `Domain ${existing.domain} made primary`,
      });
      return toDomain(updated);
    });
  }

  /** Checks the TXT record; the first tenant to verify a domain keeps it and other tenants' claims are dropped. */
  async verifyDomain(tenantId, domainId, auditContext = {}) {
    const existing = await this.repository.findDomain(domainId, tenantId);
    if (!existing) throw domainNotFound();
    if (existing.verified) return toDomain(existing);

    const record = verificationRecord(existing);
    let values = [];
    try {
      values = (await dns.promises.resolveTxt(record.name)).map((chunks) => chunks.join(''));
    } catch (err) {
      // Missing record, NXDOMAIN, timeouts, no resolver: all mean "not verified (yet)"
      logger.info({ tenantId, domain: existing.domain, code: err?.code }, 'Domain verification lookup failed');
    }
    if (!values.includes(record.value)) {
      throw new AppError(`TXT record ${record.name} with the verification value was not found (DNS changes can take a while to appear)`, {
        statusCode: 422, code: 'DOMAIN_VERIFICATION_FAILED', details: { expected: record },
      });
    }
    if (await this.repository.findVerifiedDomain(existing.domain)) throw domainTaken();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const verified = await this.repository.markVerified(domainId, tx);
        const dropped = await this.repository.deleteUnverifiedClaims(existing.domain, domainId, tx);
        for (const claim of dropped) await this.repository.ensurePrimary(claim.tenantId, tx);
        await this.log(tx, auditContext, {
          tenantId, action: 'UPDATE', resource: 'tenant_domain', resourceId: domainId, oldValue: { verified: false }, newValue: { verified: true },
          activity: 'tenant.domain.verify', description: `Domain ${existing.domain} verified`,
        });
        return toDomain(verified);
      });
    } catch (err) {
      if (err?.code === 'P2002') throw domainTaken();
      throw err;
    }
  }

  async removeDomain(tenantId, domainId, auditContext = {}) {
    const existing = await this.repository.findDomain(domainId, tenantId);
    if (!existing) throw domainNotFound();
    await this.prisma.$transaction(async (tx) => {
      await this.repository.deleteDomain(domainId, tx);
      await this.repository.ensurePrimary(tenantId, tx);
      await this.log(tx, auditContext, {
        tenantId, action: 'DELETE', resource: 'tenant_domain', resourceId: domainId, oldValue: { domain: existing.domain }, newValue: null,
        activity: 'tenant.domain.delete', description: `Domain ${existing.domain} removed`,
      });
    });
  }
}
