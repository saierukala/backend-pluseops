import { getPrismaClient } from '../../config/database.js';

export class NotificationRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async list(tenantId, userId, options = {}) {
    const {
      page = 1,
      limit = 20,
      isRead,
      type,
      channel,
      sortOrder = 'desc',
    } = options;
    const skip = (page - 1) * limit;
    const take = Math.min(limit, 100);
    const where = {
      tenantId,
      OR: [
        { userId },
        { userId: null },
      ],
    };
    if (isRead !== undefined && isRead !== null) where.isRead = isRead;
    if (type) where.type = type;
    if (channel) where.channel = channel;

    const safeOrder = ['asc', 'desc'].includes(sortOrder) ? sortOrder : 'desc';
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: safeOrder },
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { data, meta: { page, limit: take, total, totalPages: Math.ceil(total / take) } };
  }

  async findById(id, tenantId, userId) {
    // tenant scoped, and visible to user (own or tenant-wide)
    return this.prisma.notification.findFirst({
      where: {
        id,
        tenantId,
        OR: [
          { userId },
          { userId: null },
        ],
      },
    });
  }

  async findByIdStrict(id, tenantId) {
    return this.prisma.notification.findFirst({ where: { id, tenantId } });
  }

  async markAsRead(id, tenantId, userId) {
    const existing = await this.findById(id, tenantId, userId);
    if (!existing) return null;
    if (existing.isRead) return existing;
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllAsRead(tenantId, userId) {
    const result = await this.prisma.notification.updateMany({
      where: {
        tenantId,
        isRead: false,
        OR: [
          { userId },
          { userId: null },
        ],
      },
      data: { isRead: true, readAt: new Date() },
    });
    return result.count;
  }

  async create(data, tx = null) {
    const client = tx || this.prisma;
    return client.notification.create({ data });
  }

  async createMany(dataArray, tx = null) {
    const client = tx || this.prisma;
    return client.notification.createMany({ data: dataArray });
  }

  async getOverview(tenantId) {
    const [total, unread, recent] = await Promise.all([
      this.prisma.notification.count({ where: { tenantId } }),
      this.prisma.notification.count({ where: { tenantId, isRead: false } }),
      this.prisma.notification.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, type: true, title: true, channel: true, isRead: true, createdAt: true },
      }),
    ]);
    return { total, unread, recent };
  }
}

export class NotificationPreferenceRepository {
  constructor() {
    this.prisma = getPrismaClient();
  }

  async list(tenantId, userId) {
    const prefs = await this.prisma.notificationPreference.findMany({
      where: { tenantId, userId },
      orderBy: { channel: 'asc' },
    });
    return prefs;
  }

  async ensureDefaults(tenantId, userId) {
    const channels = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'];
    const existing = await this.prisma.notificationPreference.findMany({
      where: { tenantId, userId },
    });
    const existingChannels = new Set(existing.map((p) => p.channel));
    const missing = channels.filter((c) => !existingChannels.has(c));
    if (missing.length > 0) {
      await this.prisma.notificationPreference.createMany({
        data: missing.map((channel) => ({
          tenantId,
          userId,
          channel,
          isEnabled: true,
        })),
        skipDuplicates: true,
      });
    }
    return this.prisma.notificationPreference.findMany({
      where: { tenantId, userId },
      orderBy: { channel: 'asc' },
    });
  }

  async upsert(tenantId, userId, channel, isEnabled) {
    return this.prisma.notificationPreference.upsert({
      where: { tenantId_userId_channel: { tenantId, userId, channel } },
      update: { isEnabled },
      create: { tenantId, userId, channel, isEnabled },
    });
  }

  async bulkUpdate(tenantId, userId, updates) {
    const results = [];
    for (const [channel, isEnabled] of Object.entries(updates)) {
      const pref = await this.upsert(tenantId, userId, channel, isEnabled);
      results.push(pref);
    }
    return results;
  }
}
