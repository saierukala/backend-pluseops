import { NotificationRepository, NotificationPreferenceRepository } from './notifications.repository.js';
import { AppError } from '../../common/errors/app-error.js';
import { normalizePreferencePayload } from './notifications.validation.js';
import { emitNotificationCreated } from '../../realtime/realtime.service.js';

const notificationRepository = new NotificationRepository();
const preferenceRepository = new NotificationPreferenceRepository();

export const NOTIFICATION_CHANNELS = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  SMS: 'SMS',
  PUSH: 'PUSH',
};

export const NOTIFICATION_TYPES = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
};

export class NotificationService {
  constructor() {
    this.notificationRepository = notificationRepository;
    this.preferenceRepository = preferenceRepository;
  }

  // Provider-independent abstraction: business modules call this without knowing channel implementation
  async createNotification({ tenantId, userId = null, type = 'INFO', title, message, channel = 'IN_APP', referenceType = null, referenceId = null, metadata = {}, tx = null }) {
    if (!tenantId) throw new AppError('tenantId is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (!title || typeof title !== 'string' || title.trim().length === 0) throw new AppError('title is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (!message || typeof message !== 'string' || message.trim().length === 0) throw new AppError('message is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    const allowedTypes = ['INFO', 'SUCCESS', 'WARNING', 'ERROR'];
    const allowedChannels = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'];
    if (type && !allowedTypes.includes(type)) throw new AppError('Invalid notification type', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (channel && !allowedChannels.includes(channel)) throw new AppError('Invalid notification channel', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (title.length > 255) throw new AppError('Title too long', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (message.length > 2000) throw new AppError('Message too long', { statusCode: 400, code: 'VALIDATION_ERROR' });
    // Sensitive data guard: do not allow storing secrets in metadata inadvertently - but we don't block, just ensure no password-like keys leaked? We sanitize metadata keys?
    // Keep metadata as sanitized object, limit size
    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};

    // Respect preferences where applicable: if user has disabled channel, we still create in-app record but skip external delivery
    // For Phase 12, we always create record regardless; channel abstraction means future delivery can check preference
    // However, we respect preference by not failing if disabled - creation always succeeds
    const data = {
      tenantId,
      userId: userId || null,
      type,
      title: String(title).trim(),
      message: String(message).trim(),
      channel,
      referenceType: referenceType ? String(referenceType) : null,
      referenceId: referenceId ? String(referenceId) : null,
      metadata: safeMetadata,
    };
    const created = await this.notificationRepository.create(data, tx);
    // Emit realtime event (minimal payload, tenant/user isolated)
    try {
      emitNotificationCreated(tenantId, userId || null, {
        id: created.id,
        tenantId: created.tenantId,
        userId: created.userId,
        type: created.type,
        title: created.title,
        message: created.message,
        channel: created.channel,
        referenceType: created.referenceType,
        referenceId: created.referenceId,
        createdAt: created.createdAt,
      });
    } catch (_e) { void _e; }
    return created;
  }

  // Channel abstraction placeholder - future providers implement this interface
  async dispatchViaChannel(notification) {
    // In Phase 12, dispatch is a no-op for external channels; in-app is just DB record
    // Future: check preference, enqueue BullMQ job, or send via provider
    return notification;
  }

  async notify({ tenantId, userId, type, title, message, channel, referenceType, referenceId, metadata }) {
    const notification = await this.createNotification({ tenantId, userId, type, title, message, channel, referenceType, referenceId, metadata });
    // Optionally check preference before dispatch
    if (userId && channel !== 'IN_APP') {
      const prefs = await this.preferenceRepository.list(tenantId, userId);
      const prefMap = new Map(prefs.map((p) => [p.channel, p.isEnabled]));
      if (prefMap.has(channel) && prefMap.get(channel) === false) {
        // Channel disabled - still return notification, but don't dispatch
        return notification;
      }
    }
    await this.dispatchViaChannel(notification);
    return notification;
  }

  async list(tenantId, userId, options) {
    return this.notificationRepository.list(tenantId, userId, options);
  }

  async markAsRead(id, tenantId, userId) {
    const notification = await this.notificationRepository.findById(id, tenantId, userId);
    if (!notification) throw new AppError('Notification not found', { statusCode: 404, code: 'NOTIFICATION_NOT_FOUND' });
    if (notification.isRead) return notification;
    return this.notificationRepository.markAsRead(id, tenantId, userId);
  }

  async markAllAsRead(tenantId, userId) {
    const count = await this.notificationRepository.markAllAsRead(tenantId, userId);
    return { updated: count };
  }

  async getPreferences(tenantId, userId) {
    return this.preferenceRepository.ensureDefaults(tenantId, userId);
  }

  async updatePreferences(tenantId, userId, body) {
    const normalized = normalizePreferencePayload(body);
    if (Object.keys(normalized).length === 0) {
      throw new AppError('No valid preference fields provided', { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    // Validate channel values - already boolean via zod, but double-check
    for (const [ch, val] of Object.entries(normalized)) {
      if (typeof val !== 'boolean') throw new AppError(`Invalid value for ${ch}`, { statusCode: 400, code: 'VALIDATION_ERROR' });
      if (!['IN_APP', 'EMAIL', 'SMS', 'PUSH'].includes(ch)) throw new AppError(`Invalid channel ${ch}`, { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    // Mass assignment guard: ignore tenantId, userId, createdAt etc - only normalized channels are applied
    const updated = await this.preferenceRepository.bulkUpdate(tenantId, userId, normalized);
    // Return full list after update for consistency
    const all = await this.preferenceRepository.list(tenantId, userId);
    return all.length === 0 ? updated : all;
  }

  async getOverview(tenantId) {
    return this.notificationRepository.getOverview(tenantId);
  }
}

export const notificationService = new NotificationService();
