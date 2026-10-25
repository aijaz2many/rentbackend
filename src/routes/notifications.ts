import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';
import { isExpoPushToken, publishAnnouncement } from '../services/notificationService';

const router = Router();
const announcementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  recipientUserIds: z.array(z.string().uuid()).max(500).optional(),
});
const pushTokenSchema = z.object({
  token: z.string().min(1).max(255),
  deviceName: z.string().trim().max(100).optional().nullable(),
});

function notificationRecipientFilter(req: AuthenticatedRequest) {
  const recipients: Array<{ user_id?: string; tenant_id?: string }> = [
    { user_id: req.user!.userId },
  ];
  if (req.user!.tenantId) recipients.push({ tenant_id: req.user!.tenantId });
  return recipients;
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = z.object({
      unreadOnly: z.enum(['true', 'false']).default('false'),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(25),
    }).parse(req.query);
    const where = {
      organization_id: req.user!.organizationId,
      OR: notificationRecipientFilter(req),
      ...(query.unreadOnly === 'true' ? { is_read: false } : {}),
    };
    const [notifications, total] = await Promise.all([
      prisma.tsmib_notifications.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.tsmib_notifications.count({ where }),
    ]);
    return res.json({
      notifications,
      pagination: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Failed to list notifications' });
  }
});

router.get('/unread-count', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const count = await prisma.tsmib_notifications.count({
      where: {
        organization_id: req.user!.organizationId,
        OR: notificationRecipientFilter(req),
        is_read: false,
      },
    });
    return res.json({ count });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to count unread notifications' });
  }
});

router.patch('/read-all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await prisma.tsmib_notifications.updateMany({
      where: {
        organization_id: req.user!.organizationId,
        OR: notificationRecipientFilter(req),
        is_read: false,
      },
      data: { is_read: true, read_at: new Date() },
    });
    return res.json({ updated: result.count });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to mark notifications as read' });
  }
});

router.patch('/:id/read', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await prisma.tsmib_notifications.updateMany({
      where: {
        id: req.params.id,
        organization_id: req.user!.organizationId,
        OR: notificationRecipientFilter(req),
      },
      data: { is_read: true, read_at: new Date() },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Notification not found' });
    return res.json({ message: 'Notification marked as read' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to mark notification as read' });
  }
});

router.post(
  '/announcements',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = announcementSchema.parse(req.body);
      const recipients = data.recipientUserIds
        ? [...new Set(data.recipientUserIds)]
        : undefined;
      const count = await publishAnnouncement(
        {
          organizationId: req.user!.organizationId,
          title: data.title,
          message: data.message,
          type: 'ANNOUNCEMENT',
        },
        recipients
      );
      return res.status(201).json({ message: 'Announcement published', recipients: count });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      if (error.message === 'One or more recipients are not active users in your organization') {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: error.message || 'Failed to publish announcement' });
    }
  }
);

router.post('/push-tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = pushTokenSchema.parse(req.body);
    if (!isExpoPushToken(data.token)) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }

    const existing = await prisma.tsmib_push_tokens.findUnique({
      where: { expo_push_token: data.token },
    });
    if (existing && existing.user_id !== req.user!.userId) {
      return res.status(409).json({ error: 'Push token is registered to another user' });
    }

    const pushToken = await prisma.tsmib_push_tokens.upsert({
      where: { expo_push_token: data.token },
      create: {
        user_id: req.user!.userId,
        expo_push_token: data.token,
        device_name: data.deviceName || null,
      },
      update: {
        device_name: data.deviceName || null,
        updated_at: new Date(),
      },
    });
    return res.status(201).json({ id: pushToken.id });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Failed to register push token' });
  }
});

router.delete('/push-tokens', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = pushTokenSchema.pick({ token: true }).parse(req.body);
    const result = await prisma.tsmib_push_tokens.deleteMany({
      where: { user_id: req.user!.userId, expo_push_token: token },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Push token not found' });
    return res.json({ message: 'Push token removed' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Failed to remove push token' });
  }
});

export default router;
