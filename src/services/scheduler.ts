import { RentEngine } from './rentEngine';
import { prisma } from '../lib/prisma';
import {
  notifyOrganizationAfterBusinessEvent,
  notifyTenantAfterBusinessEvent,
} from './notificationService';
import { cleanupExpiredDocumentUploads } from './documentStorage';

export class RentScheduler {
  private static intervalHandle: NodeJS.Timeout | null = null;

  /**
   * Initialize background automated routines
   * Runs overdue processing once a day (and shortly after startup).
   */
  static start() {
    console.log('⏰ [RentScheduler] Starting Rent Engine background scheduler...');

    // Run initial overdue check 10 seconds after startup
    setTimeout(() => {
      this.runDailyOverdueJob().catch((err) => {
        console.error('❌ [RentScheduler] Initial overdue check error:', err.message);
      });
    }, 10000);

    // Run every 24 hours (86,400,000 ms)
    this.intervalHandle = setInterval(() => {
      this.runDailyOverdueJob().catch((err) => {
        console.error('❌ [RentScheduler] Daily overdue check error:', err.message);
      });
    }, 24 * 60 * 60 * 1000);
  }

  static stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('⏹️ [RentScheduler] Scheduler stopped.');
    }
  }

  /**
   * Run overdue processing across all active organizations
   */
  static async runDailyOverdueJob() {
    console.log('🔍 [RentScheduler] Running automated overdue & late-fee evaluation...');
    try {
      const organizations = await prisma.tsmib_organizations.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true },
      });

      for (const org of organizations) {
        try {
          const now = new Date();
          if (now.getUTCDate() <= 5) {
            const generated = await RentEngine.generateMonthlyRentCharges({
              organizationId: org.id,
              billingYear: now.getUTCFullYear(),
              billingMonth: now.getUTCMonth() + 1,
              dryRun: false,
              prorate: true,
            });
            if (generated.chargesCreated > 0) {
              console.log(`💰 [RentScheduler] Org "${org.name}": created ${generated.chargesCreated} current-month rent charges.`);
            }
          }

          const result = await RentEngine.processOverdueCharges(org.id);
          if (result.overdueChargesCount > 0) {
            console.log(
              `🔔 [RentScheduler] Org "${org.name}": marked ${result.overdueChargesCount} charges as OVERDUE (${result.lateFeesAppliedCount} late fees applied totaling ₹${result.totalLateFeeAmount})`
            );
          }

          await Promise.all([
            this.notifyRentDue(org.id),
            this.notifyExpiringLeases(org.id),
            this.notifyStaleMaintenance(org.id),
          ]);
          await cleanupExpiredDocumentUploads(org.id);
        } catch (err: any) {
          console.error(`❌ [RentScheduler] Scheduled jobs failed for org "${org.name}":`, err.message);
        }
      }
    } catch (err: any) {
      console.error('❌ [RentScheduler] Error during daily overdue job:', err.message);
    }
  }

  private static async notificationExistsToday(
    organizationId: string,
    tenantId: string,
    type: string,
    message: string,
    dayStart: Date
  ): Promise<boolean> {
    const existing = await prisma.tsmib_notifications.findFirst({
      where: {
        organization_id: organizationId,
        tenant_id: tenantId,
        notification_type: type,
        message,
        created_at: { gte: dayStart },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }

  private static async notifyRentDue(organizationId: string): Promise<void> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const reminderThrough = new Date(today);
    reminderThrough.setUTCDate(reminderThrough.getUTCDate() + 3);

    const charges = await prisma.tsmib_rent_charges.findMany({
      where: {
        organization_id: organizationId,
        due_date: { gte: today, lte: reminderThrough },
        tsmib_rent_status: { code: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      },
      include: {
        tsmib_apartments: { select: { apartment_number: true } },
        tsmib_leases: {
          include: {
            tsmib_lease_tenants: {
              where: { is_primary: true },
              select: { tenant_id: true },
            },
          },
        },
        tsmib_payment_allocations: true,
      },
    });

    for (const charge of charges) {
      const tenantId = charge.tsmib_leases.tsmib_lease_tenants[0]?.tenant_id;
      if (!tenantId) continue;
      const outstanding = Math.max(
        0,
        Number(charge.total_amount || (Number(charge.rent_amount) + Number(charge.late_fee || 0))) -
          charge.tsmib_payment_allocations.reduce((total, allocation) => total + Number(allocation.amount), 0)
      );
      if (!outstanding) continue;

      const dueDate = new Date(charge.due_date).toISOString().slice(0, 10);
      const message = `Rent of ₹${outstanding.toLocaleString('en-IN')} for apartment ${charge.tsmib_apartments.apartment_number} is due on ${dueDate}.`;
      if (await this.notificationExistsToday(organizationId, tenantId, 'RENT_DUE', message, today)) continue;

      await notifyTenantAfterBusinessEvent(tenantId, {
        organizationId,
        title: 'Rent due soon',
        message,
        type: 'RENT_DUE',
      });
    }
  }

  private static async notifyExpiringLeases(organizationId: string): Promise<void> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const throughDate = new Date(today);
    throughDate.setUTCDate(throughDate.getUTCDate() + 30);

    const leases = await prisma.tsmib_leases.findMany({
      where: {
        organization_id: organizationId,
        status: 'ACTIVE',
        end_date: { gte: today, lte: throughDate },
      },
      include: {
        tsmib_apartments: { select: { apartment_number: true } },
        tsmib_lease_tenants: {
          where: { is_primary: true },
          select: { tenant_id: true },
        },
      },
    });

    const dayStart = new Date(today);
    for (const lease of leases) {
      const tenantId = lease.tsmib_lease_tenants[0]?.tenant_id;
      if (!tenantId || !lease.end_date) continue;

      const expirationDate = new Date(lease.end_date);
      expirationDate.setUTCHours(0, 0, 0, 0);
      const daysRemaining = Math.round((expirationDate.getTime() - today.getTime()) / 86_400_000);
      if (![30, 7, 1, 0].includes(daysRemaining)) continue;

      const message = `Your lease for apartment ${lease.tsmib_apartments.apartment_number} expires on ${expirationDate.toISOString().slice(0, 10)}.`;
      if (await this.notificationExistsToday(organizationId, tenantId, 'LEASE_EXPIRING', message, dayStart)) continue;

      await notifyTenantAfterBusinessEvent(tenantId, {
        organizationId,
        title: daysRemaining === 0 ? 'Lease expires today' : 'Lease expiring soon',
        message,
        type: 'LEASE_EXPIRING',
      });
    }
  }

  private static async notifyStaleMaintenance(organizationId: string): Promise<void> {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const requests = await prisma.tsmib_maintenance_requests.findMany({
      where: {
        organization_id: organizationId,
        requested_at: { lte: threeDaysAgo },
        tsmib_maintenance_status: { code: { notIn: ['COMPLETED', 'CANCELLED'] } },
      },
      include: {
        tsmib_maintenance_status: { select: { code: true } },
      },
    });
    const reminderWindowStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    for (const request of requests) {
      const message = `Maintenance request ${request.request_number} has been ${request.tsmib_maintenance_status.code.toLowerCase().replaceAll('_', ' ')} for more than 3 days.`;
      const existing = await prisma.tsmib_notifications.findFirst({
        where: {
          organization_id: organizationId,
          user_id: { not: null },
          notification_type: 'MAINTENANCE_REMINDER',
          message,
          created_at: { gte: reminderWindowStart },
        },
        select: { id: true },
      });
      if (existing) continue;

      await notifyOrganizationAfterBusinessEvent({
        organizationId,
        title: 'Maintenance request needs attention',
        message,
        type: 'MAINTENANCE_REMINDER',
      }, ['OWNER', 'MANAGER', 'ADMIN']);
    }
  }
}
