import { notificationService } from './notifications.service.js';

export async function listNotifications(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { page, limit, isRead, type, channel, sortOrder } = req.query;
    let parsedIsRead;
    if (isRead !== undefined) {
      if (typeof isRead === 'boolean') parsedIsRead = isRead;
      else if (isRead === 'true') parsedIsRead = true;
      else if (isRead === 'false') parsedIsRead = false;
    }
    const result = await notificationService.list(tenantId, userId, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      isRead: parsedIsRead,
      type,
      channel,
      sortOrder,
    });
    res.status(200).json({ success: true, data: result.data, meta: result.meta, pagination: result.meta, message: 'Notifications retrieved successfully' });
  } catch (error) { next(error); }
}

export async function markOneAsRead(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const { id } = req.params;
    const notification = await notificationService.markAsRead(id, tenantId, userId);
    res.status(200).json({ success: true, data: notification, message: 'Notification marked as read' });
  } catch (error) { next(error); }
}

export async function markAllAsRead(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const result = await notificationService.markAllAsRead(tenantId, userId);
    res.status(200).json({ success: true, data: result, message: 'All notifications marked as read' });
  } catch (error) { next(error); }
}

export async function getPreferences(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const prefs = await notificationService.getPreferences(tenantId, userId);
    res.status(200).json({ success: true, data: prefs, message: 'Notification preferences retrieved successfully' });
  } catch (error) { next(error); }
}

export async function updatePreferences(req, res, next) {
  try {
    const tenantId = req.context.tenantId;
    const userId = req.context.userId;
    const prefs = await notificationService.updatePreferences(tenantId, userId, req.body);
    res.status(200).json({ success: true, data: prefs, message: 'Notification preferences updated successfully' });
  } catch (error) { next(error); }
}
