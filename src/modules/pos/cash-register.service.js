import { getPrismaClient } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { auditService } from '../audit/audit.service.js';

/**
 * Phase 39: the cash drawer. A counter (register) has shifts (sessions): open with a float, cash sales and refunds
 * go in and out automatically, staff record cash in / cash out, and closing compares the cash counted with
 * what should be there: expected = float + sales − refunds + cash in − cash out.
 */
export const DEFAULT_REGISTER = 'Main counter';
const cents = (v) => Math.round(Number(v ?? 0) * 100);
const money = (c) => (c / 100).toFixed(2);

const notFound = (what) => new AppError(`${what} not found`, { statusCode: 404, code: what === 'Register' ? 'REGISTER_NOT_FOUND' : 'CASH_SESSION_NOT_FOUND' });

/** Totals of a shift from its movements. */
export function sessionTotals(session, movements) {
  const by = { SALE: 0, REFUND: 0, CASH_IN: 0, CASH_OUT: 0 };
  for (const m of movements) by[m.type] = (by[m.type] ?? 0) + cents(m.amount);
  const expected = cents(session.openingFloat) + by.SALE - by.REFUND + by.CASH_IN - by.CASH_OUT;
  return {
    openingFloat: money(cents(session.openingFloat)),
    cashSales: money(by.SALE),
    cashRefunds: money(by.REFUND),
    cashIn: money(by.CASH_IN),
    cashOut: money(by.CASH_OUT),
    expectedCash: money(expected),
  };
}

function toSession(session, movements = session.movements ?? []) {
  const { movements: _omit, register, ...rest } = session;
  void _omit;
  return {
    ...rest,
    registerName: register?.name ?? undefined,
    totals: sessionTotals(session, movements),
    movements: movements.map((m) => ({ id: m.id, type: m.type, amount: m.amount, reason: m.reason, orderId: m.orderId, paymentId: m.paymentId, createdBy: m.createdBy, createdAt: m.createdAt })),
  };
}

export class CashRegisterService {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async log(tx, ctx, { tenantId, action, resourceId, oldValue = null, newValue, activity, description }) {
    const { userId = null, ipAddress = null, userAgent = null } = ctx;
    await auditService.logAudit({ tenantId, userId, action, resource: 'cash_register', resourceId, oldValue, newValue, ipAddress, userAgent, tx });
    await auditService.logActivity({ tenantId, userId, action: activity, description, metadata: { resourceId }, ipAddress, userAgent, tx });
  }

  /** Every business has at least one counter, created on first use. */
  async ensureDefault(tenantId) {
    const existing = await this.prisma.cashRegister.findFirst({ where: { tenantId, isActive: true }, orderBy: { createdAt: 'asc' } });
    if (existing) return existing;
    try {
      return await this.prisma.cashRegister.create({ data: { tenantId, name: DEFAULT_REGISTER } });
    } catch (err) {
      if (err?.code === 'P2002') return this.prisma.cashRegister.findFirst({ where: { tenantId, name: DEFAULT_REGISTER } });
      throw err;
    }
  }

  async list(tenantId) {
    await this.ensureDefault(tenantId);
    const registers = await this.prisma.cashRegister.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      include: { sessions: { where: { status: 'OPEN' }, include: { movements: true }, take: 1 } },
    });
    return registers.map(({ sessions, ...r }) => ({ ...r, openSession: sessions[0] ? toSession(sessions[0]) : null }));
  }

  async create(tenantId, { name }, ctx = {}) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const register = await tx.cashRegister.create({ data: { tenantId, name } });
        await this.log(tx, ctx, { tenantId, action: 'CREATE', resourceId: register.id, newValue: { name }, activity: 'cash_register.create', description: `Counter "${name}" added` });
        return register;
      });
    } catch (err) {
      if (err?.code === 'P2002') throw new AppError('A counter with this name already exists', { statusCode: 409, code: 'REGISTER_NAME_EXISTS' });
      throw err;
    }
  }

  async open(tenantId, registerId, { openingFloat = '0', note }, ctx = {}) {
    const register = await this.prisma.cashRegister.findFirst({ where: { id: registerId, tenantId, isActive: true } });
    if (!register) throw notFound('Register');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const session = await tx.cashSession.create({
          data: { tenantId, registerId, openingFloat, openedBy: ctx.userId ?? null, note: note ?? null },
          include: { register: true, movements: true },
        });
        await this.log(tx, ctx, {
          tenantId, action: 'CREATE', resourceId: session.id, newValue: { registerId, openingFloat },
          activity: 'cash_register.open', description: `${register.name} opened with ₹${Number(openingFloat).toFixed(2)}`,
        });
        return toSession(session);
      });
    } catch (err) {
      if (err?.code === 'P2002') throw new AppError(`${register.name} is already open`, { statusCode: 409, code: 'REGISTER_ALREADY_OPEN' });
      throw err;
    }
  }

  async openSessionFor(tenantId, registerId, tx = this.prisma) {
    return tx.cashSession.findFirst({ where: { tenantId, registerId, status: 'OPEN' }, include: { register: true, movements: true } });
  }

  async current(tenantId, registerId) {
    const register = await this.prisma.cashRegister.findFirst({ where: { id: registerId, tenantId } });
    if (!register) throw notFound('Register');
    const session = await this.openSessionFor(tenantId, registerId);
    return session ? toSession(session) : null;
  }

  async getSession(tenantId, sessionId) {
    const session = await this.prisma.cashSession.findFirst({ where: { id: sessionId, tenantId }, include: { register: true, movements: { orderBy: { createdAt: 'asc' } } } });
    if (!session) throw notFound('Cash session');
    return toSession(session);
  }

  async listSessions(tenantId, { registerId, page = 1, limit = 20 } = {}) {
    const where = { tenantId, ...(registerId ? { registerId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.cashSession.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { register: true, movements: true } }),
      this.prisma.cashSession.count({ where }),
    ]);
    return { data: rows.map((s) => toSession(s, s.movements)), meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /** Staff put cash in (change float top-up) or take it out (bank deposit, petty expense). */
  async addMovement(tenantId, sessionId, { type, amount, reason }, ctx = {}) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "cash_sessions" WHERE "id" = ${sessionId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, tenantId }, include: { movements: true, register: true } });
      if (!session) throw notFound('Cash session');
      if (session.status !== 'OPEN') throw new AppError('This shift is already closed', { statusCode: 409, code: 'CASH_SESSION_CLOSED' });
      if (type === 'CASH_OUT' && cents(amount) > cents(sessionTotals(session, session.movements).expectedCash)) {
        throw new AppError('There is not that much cash in the drawer', { statusCode: 409, code: 'INSUFFICIENT_CASH' });
      }
      await tx.cashMovement.create({ data: { tenantId, sessionId, type, amount, reason: reason ?? null, createdBy: ctx.userId ?? null } });
      await this.log(tx, ctx, {
        tenantId, action: 'UPDATE', resourceId: sessionId, newValue: { type, amount, reason },
        activity: type === 'CASH_IN' ? 'cash_register.cash_in' : 'cash_register.cash_out',
        description: `${type === 'CASH_IN' ? 'Cash in' : 'Cash out'} ₹${Number(amount).toFixed(2)} at ${session.register.name}${reason ? `: ${reason}` : ''}`,
      });
      return toSession(await tx.cashSession.findFirst({ where: { id: sessionId }, include: { register: true, movements: { orderBy: { createdAt: 'asc' } } } }));
    });
  }

  /** Close the shift: counted vs expected cash. */
  async close(tenantId, sessionId, { countedCash, note }, ctx = {}) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "cash_sessions" WHERE "id" = ${sessionId} AND "tenant_id" = ${tenantId} FOR UPDATE`;
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, tenantId }, include: { movements: true, register: true } });
      if (!session) throw notFound('Cash session');
      if (session.status !== 'OPEN') throw new AppError('This shift is already closed', { statusCode: 409, code: 'CASH_SESSION_CLOSED' });
      const expected = cents(sessionTotals(session, session.movements).expectedCash);
      const variance = cents(countedCash) - expected;
      await tx.cashSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', expectedCash: money(expected), countedCash, variance: money(variance), closedBy: ctx.userId ?? null, closedAt: new Date(), note: note ?? session.note },
      });
      await this.log(tx, ctx, {
        tenantId, action: 'UPDATE', resourceId: sessionId, oldValue: { status: 'OPEN' }, newValue: { status: 'CLOSED', expectedCash: money(expected), countedCash, variance: money(variance) },
        activity: 'cash_register.close',
        description: `${session.register.name} closed: expected ₹${money(expected)}, counted ₹${Number(countedCash).toFixed(2)}${variance ? ` (${variance > 0 ? 'over' : 'short'} ₹${money(Math.abs(variance))})` : ''}`,
      });
      return toSession(await tx.cashSession.findFirst({ where: { id: sessionId }, include: { register: true, movements: { orderBy: { createdAt: 'asc' } } } }));
    });
  }

  /** A cash sale lands in the open shift (called inside the sale's transaction). */
  async recordSale(tx, { tenantId, sessionId, amount, orderId, paymentId, userId }) {
    await tx.cashMovement.create({ data: { tenantId, sessionId, type: 'SALE', amount, orderId, paymentId, createdBy: userId ?? null } });
  }
}

export const cashRegisterService = new CashRegisterService();
