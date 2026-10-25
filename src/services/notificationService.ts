import { prisma } from '../lib/prisma';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_TOKEN_PATTERN = /^(Expo|Exponent)PushToken\[[^\]]+\]$/;

export type NotificationInput = {
  organizationId: string;
  title: string;
  message: string;
  type?: string | null;
};

export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_PATTERN.test(token);
}

async function dispatchPushToUsers(userIds: string[], notification: NotificationInput): Promise<void> {
  if (userIds.length === 0) return;

  const tokens = await prisma.tsmib_push_tokens.findMany({
    where: { user_id: { in: userIds } },
    select: { expo_push_token: true },
  });
  if (tokens.length === 0) return;

  for (let offset = 0; offset < tokens.length; offset += 100) {
    const batch = tokens.slice(offset, offset + 100);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch.map(({ expo_push_token }) => ({
          to: expo_push_token,
          title: notification.title,
          body: notification.message,
          sound: 'default',
          data: { type: notification.type || 'GENERAL' },
        }))),
      });
      if (!response.ok) {
        throw new Error(`Expo push service returned HTTP ${response.status}`);
      }

      const result = await response.json() as {
        data?: Array<{ status?: string; message?: string; details?: { error?: string } }>;
      };
      const failedTickets = (result.data || []).filter((ticket) => ticket.status === 'error');
      if (failedTickets.length > 0) {
        console.error('Expo push delivery failures:', failedTickets);
      }
    } catch (error) {
      console.error('Unable to deliver Expo push notifications:', error);
    }
  }
}

export async function notifyUsers(
  userIds: string[],
  notification: NotificationInput
): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return;

  await prisma.tsmib_notifications.createMany({
    data: uniqueUserIds.map((userId) => ({
      organization_id: notification.organizationId,
      user_id: userId,
      title: notification.title,
      message: notification.message,
      notification_type: notification.type || 'GENERAL',
    })),
  });
  try {
    await dispatchPushToUsers(uniqueUserIds, notification);
  } catch (error) {
    console.error('Unable to prepare Expo push notifications:', error);
  }
}

export async function notifyOrganization(
  notification: NotificationInput,
  roles?: string[]
): Promise<void> {
  const users = await prisma.tsmib_users.findMany({
    where: {
      organization_id: notification.organizationId,
      status: 'ACTIVE',
      ...(roles
        ? { tsmib_user_roles: { some: { tsmib_roles: { role: { in: roles } } } } }
        : {}),
    },
    select: { id: true },
  });
  await notifyUsers(users.map((user) => user.id), notification);
}

export async function notifyTenant(
  tenantId: string,
  notification: NotificationInput
): Promise<void> {
  const tenant = await prisma.tsmib_tenants.findFirst({
    where: { id: tenantId, organization_id: notification.organizationId },
    select: { id: true, email: true, phone: true },
  });
  if (!tenant) return;

  const contact = tenant.email
    ? { email: tenant.email }
    : tenant.phone
      ? { phone: tenant.phone }
      : null;
  const linkedUsers = contact
    ? await prisma.tsmib_users.findMany({
        where: {
          organization_id: notification.organizationId,
          status: 'ACTIVE',
          ...contact,
          tsmib_user_roles: { some: { tsmib_roles: { role: 'TENANT' } } },
        },
        select: { id: true },
      })
    : [];
  const linkedUserId = linkedUsers.length === 1 ? linkedUsers[0].id : null;
  if (linkedUsers.length > 1) {
    console.warn(`Tenant ${tenant.id} has multiple matching login accounts; push delivery skipped.`);
  }

  await prisma.tsmib_notifications.create({
    data: {
      organization_id: notification.organizationId,
      user_id: linkedUserId,
      tenant_id: tenant.id,
      title: notification.title,
      message: notification.message,
      notification_type: notification.type || 'GENERAL',
    },
  });
  if (linkedUserId) {
    try {
      await dispatchPushToUsers([linkedUserId], notification);
    } catch (error) {
      console.error(`Unable to prepare Expo push notification for tenant ${tenant.id}:`, error);
    }
  }
}

export async function notifyTenantAfterBusinessEvent(
  tenantId: string,
  notification: NotificationInput
): Promise<void> {
  try {
    await notifyTenant(tenantId, notification);
  } catch (error) {
    console.error(`Unable to persist ${notification.type || 'general'} notification for tenant ${tenantId}:`, error);
  }
}

export async function notifyOrganizationAfterBusinessEvent(
  notification: NotificationInput,
  roles?: string[]
): Promise<void> {
  try {
    await notifyOrganization(notification, roles);
  } catch (error) {
    console.error(`Unable to persist ${notification.type || 'general'} organization notification:`, error);
  }
}

export async function publishAnnouncement(
  notification: NotificationInput,
  recipientUserIds?: string[]
): Promise<number> {
  const users = await prisma.tsmib_users.findMany({
    where: {
      organization_id: notification.organizationId,
      status: 'ACTIVE',
      ...(recipientUserIds ? { id: { in: recipientUserIds } } : {}),
    },
    select: { id: true },
  });
  if (recipientUserIds && users.length !== new Set(recipientUserIds).size) {
    throw new Error('One or more recipients are not active users in your organization');
  }

  await notifyUsers(users.map((user) => user.id), { ...notification, type: 'ANNOUNCEMENT' });
  return users.length;
}
