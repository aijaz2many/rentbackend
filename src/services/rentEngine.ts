import { prisma } from '../lib/prisma';
import { notifyTenantAfterBusinessEvent } from './notificationService';

export interface GenerateRentOptions {
  organizationId: string;
  billingYear: number;
  billingMonth: number;
  dryRun?: boolean;
  prorate?: boolean;
  propertyId?: string;
}

export interface RentChargePreview {
  leaseId: string;
  apartmentId: string;
  apartmentNumber: string;
  buildingName: string;
  tenantName: string;
  monthlyRent: number;
  calculatedRent: number;
  lateFee: number;
  dueDate: string;
  isProrated: boolean;
  prorateReason?: string;
  alreadyExists: boolean;
}

export interface GenerateRentResult {
  billingPeriod: string;
  dryRun: boolean;
  activeLeasesFound: number;
  chargesCreated: number;
  chargesSkipped: number;
  totalRentAmount: number;
  details: RentChargePreview[];
}

export interface ProcessOverdueResult {
  overdueChargesCount: number;
  lateFeesAppliedCount: number;
  totalLateFeeAmount: number;
  updatedChargeIds: string[];
}

export class RentEngine {
  /**
   * Helper to compute days in a given month and year
   */
  static getDaysInMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
  }

  /**
   * Idempotent Rent Generation Engine
   * Generates rent charges for all active leases for a given billing month and year.
   */
  static async generateMonthlyRentCharges(options: GenerateRentOptions): Promise<GenerateRentResult> {
    const { organizationId, billingYear, billingMonth, dryRun = false, prorate = true, propertyId } = options;

    const daysInMonth = this.getDaysInMonth(billingYear, billingMonth);
    const monthStart = new Date(Date.UTC(billingYear, billingMonth - 1, 1, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(billingYear, billingMonth - 1, daysInMonth, 23, 59, 59));

    // Get PENDING rent status
    const pendingStatus = await prisma.tsmib_rent_status.findFirst({
      where: { code: 'PENDING' },
    });
    if (!pendingStatus) {
      throw new Error("System configuration error: 'PENDING' rent status not found in database.");
    }

    // Build lease query
    const leaseWhere: any = {
      organization_id: organizationId,
      status: 'ACTIVE',
      start_date: { lte: monthEnd },
      OR: [
        { end_date: null },
        { end_date: { gte: monthStart } },
      ],
    };

    if (propertyId) {
      leaseWhere.tsmib_apartments = {
        tsmib_buildings: {
          property_id: propertyId,
        },
      };
    }

    const activeLeases = await prisma.tsmib_leases.findMany({
      where: leaseWhere,
      include: {
        tsmib_apartments: {
          include: {
            tsmib_buildings: true,
          },
        },
        tsmib_lease_tenants: {
          where: { is_primary: true },
          include: {
            tsmib_tenants: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    // Check existing charges for this month to guarantee idempotency
    const existingCharges = await prisma.tsmib_rent_charges.findMany({
      where: {
        organization_id: organizationId,
        billing_year: billingYear,
        billing_month: billingMonth,
      },
      select: { lease_id: true },
    });

    const existingLeaseIds = new Set(existingCharges.map((c) => c.lease_id));

    const previews: RentChargePreview[] = [];
    let chargesCreated = 0;
    let chargesSkipped = 0;
    let totalRentAmount = 0;

    for (const lease of activeLeases) {
      const alreadyExists = existingLeaseIds.has(lease.id);
      const primaryTenant = lease.tsmib_lease_tenants[0]?.tsmib_tenants;
      const tenantName = primaryTenant
        ? `${primaryTenant.first_name} ${primaryTenant.last_name || ''}`.trim()
        : 'Unknown Tenant';

      const fullMonthlyRent = Number(lease.monthly_rent);
      let calculatedRent = fullMonthlyRent;
      let isProrated = false;
      let prorateReason: string | undefined;

      // Proration calculation
      if (prorate) {
        const leaseStart = new Date(lease.start_date);
        const leaseEnd = lease.end_date ? new Date(lease.end_date) : null;

        let activeDays = daysInMonth;

        // Check if lease started during this billing month
        if (
          leaseStart.getUTCFullYear() === billingYear &&
          leaseStart.getUTCMonth() + 1 === billingMonth
        ) {
          const startDay = leaseStart.getUTCDate();
          activeDays = daysInMonth - startDay + 1;
          isProrated = true;
          prorateReason = `Move-in on day ${startDay} (${activeDays}/${daysInMonth} days)`;
        }

        // Check if lease ends during this billing month
        if (
          leaseEnd &&
          leaseEnd.getUTCFullYear() === billingYear &&
          leaseEnd.getUTCMonth() + 1 === billingMonth
        ) {
          const endDay = leaseEnd.getUTCDate();
          activeDays = Math.min(activeDays, endDay);
          isProrated = true;
          prorateReason = prorateReason
            ? `${prorateReason}, move-out on day ${endDay}`
            : `Move-out on day ${endDay} (${activeDays}/${daysInMonth} days)`;
        }

        if (isProrated && activeDays > 0 && activeDays < daysInMonth) {
          const dailyRate = fullMonthlyRent / daysInMonth;
          calculatedRent = Math.round(dailyRate * activeDays);
        }
      }

      // Compute due date (clamp to valid day of month)
      const targetDueDay = Math.min(Math.max(lease.rent_due_day || 5, 1), 28);
      const dueDate = new Date(Date.UTC(billingYear, billingMonth - 1, targetDueDay));
      const lateFee = Number(lease.late_fee || 0);

      previews.push({
        leaseId: lease.id,
        apartmentId: lease.apartment_id,
        apartmentNumber: lease.tsmib_apartments.apartment_number,
        buildingName: lease.tsmib_apartments.tsmib_buildings.name,
        tenantName,
        monthlyRent: fullMonthlyRent,
        calculatedRent,
        lateFee,
        dueDate: dueDate.toISOString().split('T')[0],
        isProrated,
        prorateReason,
        alreadyExists,
      });

      if (alreadyExists) {
        chargesSkipped++;
      } else {
        totalRentAmount += calculatedRent;
        if (!dryRun) {
          try {
            await prisma.tsmib_rent_charges.create({
              data: {
                organization_id: organizationId,
                lease_id: lease.id,
                apartment_id: lease.apartment_id,
                billing_year: billingYear,
                billing_month: billingMonth,
                due_date: dueDate,
                rent_amount: calculatedRent as any,
                late_fee: 0,
                rent_status_id: pendingStatus.id,
              },
            });
            chargesCreated++;
            if (primaryTenant) {
              await notifyTenantAfterBusinessEvent(primaryTenant.id, {
                organizationId,
                title: 'Rent charge created',
                message: `Rent of ₹${calculatedRent.toLocaleString('en-IN')} for ${lease.tsmib_apartments.apartment_number} is due on ${dueDate.toLocaleDateString('en-IN')}.`,
                type: 'RENT_CHARGE_CREATED',
              });
            }
          } catch (createErr: any) {
            // In case of race condition or duplicate constraint
            chargesSkipped++;
          }
        } else {
          chargesCreated++;
        }
      }
    }

    return {
      billingPeriod: `${billingMonth.toString().padStart(2, '0')}/${billingYear}`,
      dryRun,
      activeLeasesFound: activeLeases.length,
      chargesCreated,
      chargesSkipped,
      totalRentAmount,
      details: previews,
    };
  }

  /**
   * Overdue Processor & Late Fee Engine
   * Evaluates unpaid charges where dueDate < today, transitions status to OVERDUE,
   * and automatically applies configured late fees from lease agreements.
   */
  static async processOverdueCharges(organizationId: string): Promise<ProcessOverdueResult> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const overdueStatus = await prisma.tsmib_rent_status.findFirst({
      where: { code: 'OVERDUE' },
    });
    if (!overdueStatus) {
      throw new Error("System configuration error: 'OVERDUE' rent status not found in database.");
    }

    // Find all charges where due_date < today and not fully paid or cancelled
    const charges = await prisma.tsmib_rent_charges.findMany({
      where: {
        organization_id: organizationId,
        due_date: { lt: today },
        tsmib_rent_status: {
          code: { in: ['PENDING', 'PARTIALLY_PAID'] },
        },
      },
      include: {
        tsmib_leases: true,
        tsmib_payment_allocations: true,
      },
    });

    let overdueCount = 0;
    let lateFeesApplied = 0;
    let totalLateFeeAmount = 0;
    const updatedIds: string[] = [];

    for (const charge of charges) {
      const leaseLateFee = Number(charge.tsmib_leases?.late_fee || 0);
      const currentLateFee = Number(charge.late_fee || 0);
      const baseRent = Number(charge.rent_amount);

      let newLateFee = currentLateFee;
      let feeAppliedThisRun = false;

      // Apply late fee if configured on the lease and not yet added to this charge
      if (currentLateFee === 0 && leaseLateFee > 0) {
        newLateFee = leaseLateFee;
        feeAppliedThisRun = true;
        lateFeesApplied++;
        totalLateFeeAmount += leaseLateFee;
      }

      await prisma.tsmib_rent_charges.update({
        where: { id: charge.id },
        data: {
          rent_status_id: overdueStatus.id,
          late_fee: newLateFee as any,
          updated_at: new Date(),
        },
      });

      overdueCount++;
      updatedIds.push(charge.id);
      const primaryLeaseTenant = await prisma.tsmib_lease_tenants.findFirst({
        where: { lease_id: charge.lease_id, is_primary: true },
        select: { tenant_id: true },
      });
      if (primaryLeaseTenant) {
        await notifyTenantAfterBusinessEvent(primaryLeaseTenant.tenant_id, {
          organizationId,
          title: 'Rent payment overdue',
          message: `A rent charge of ₹${(baseRent + newLateFee).toLocaleString('en-IN')} is overdue. Please contact your property manager if you have already paid.`,
          type: 'RENT_OVERDUE',
        });
      }
    }

    return {
      overdueChargesCount: overdueCount,
      lateFeesAppliedCount: lateFeesApplied,
      totalLateFeeAmount,
      updatedChargeIds: updatedIds,
    };
  }

  /**
   * Rent Summary & Collection Analytics
   */
  static async getRentSummary(organizationId: string, year?: number, month?: number) {
    const where: any = { organization_id: organizationId };
    if (year) where.billing_year = year;
    if (month) where.billing_month = month;

    const charges = await prisma.tsmib_rent_charges.findMany({
      where,
      include: {
        tsmib_payment_allocations: true,
        tsmib_rent_status: true,
      },
    });

    let expectedRent = 0;
    let collectedRent = 0;
    let overdueRent = 0;
    let pendingRent = 0;
    let lateFeesTotal = 0;

    const counts = {
      PENDING: 0,
      PARTIALLY_PAID: 0,
      PAID: 0,
      OVERDUE: 0,
      CANCELLED: 0,
    };

    for (const c of charges) {
      const totalCharge = Number(c.total_amount || c.rent_amount);
      const paid = c.tsmib_payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);
      const lateFee = Number(c.late_fee || 0);

      expectedRent += totalCharge;
      collectedRent += paid;
      lateFeesTotal += lateFee;

      const statusCode = c.tsmib_rent_status?.code as keyof typeof counts;
      if (statusCode && counts[statusCode] !== undefined) {
        counts[statusCode]++;
      }

      if (statusCode === 'OVERDUE') {
        overdueRent += Math.max(0, totalCharge - paid);
      } else if (statusCode === 'PENDING' || statusCode === 'PARTIALLY_PAID') {
        pendingRent += Math.max(0, totalCharge - paid);
      }
    }

    const collectionRate = expectedRent > 0 ? Math.round((collectedRent / expectedRent) * 100) : 0;

    return {
      totalChargesCount: charges.length,
      expectedRent,
      collectedRent,
      pendingRent,
      overdueRent,
      lateFeesTotal,
      collectionRate,
      statusBreakdown: counts,
      currency: 'INR',
    };
  }
}
