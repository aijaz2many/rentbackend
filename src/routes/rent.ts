import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';
import { RentEngine } from '../services/rentEngine';
import { PaymentService } from '../services/paymentService';

const router = Router();

// Validation
const generateMonthlyRentSchema = z.object({
  billingYear: z.number().int().min(2020).max(2100),
  billingMonth: z.number().int().min(1).max(12),
  dryRun: z.boolean().optional().default(false),
  prorate: z.boolean().optional().default(true),
  propertyId: z.string().uuid().optional(),
});

const recordPaymentSchema = z.object({
  tenantId: z.string().uuid(),
  apartmentId: z.string().uuid(),
  amount: z.number().positive(),
  paymentMethodCode: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE', 'OTHER']).default('UPI'),
  transactionId: z.string().optional().nullable(),
  rentChargeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

// 1. GET rent status lookups
router.get('/meta/lookups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [statuses, methods] = await Promise.all([
      prisma.tsmib_rent_status.findMany(),
      prisma.tsmib_payment_method.findMany(),
    ]);
    res.json({ statuses, methods });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch lookups' });
  }
});

// 2. LIST rent charges with filters
router.get('/charges', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { year, month, status, apartmentId } = req.query;

    const where: any = { organization_id: orgId };
    if (tenantScope) {
      where.tsmib_leases = {
        tsmib_lease_tenants: { some: { tenant_id: tenantScope } },
      };
    }
    if (year) where.billing_year = Number(year);
    if (month) where.billing_month = Number(month);
    if (apartmentId) where.apartment_id = String(apartmentId);
    if (status) {
      const statusRecord = await prisma.tsmib_rent_status.findFirst({
        where: { code: String(status) },
      });
      if (statusRecord) where.rent_status_id = statusRecord.id;
    }

    const charges = await prisma.tsmib_rent_charges.findMany({
      where,
      include: {
        tsmib_apartments: {
          include: { tsmib_buildings: true },
        },
        tsmib_rent_status: true,
        tsmib_leases: {
          include: {
            tsmib_lease_tenants: {
              where: { is_primary: true },
              include: { tsmib_tenants: true },
            },
          },
        },
        tsmib_payment_allocations: true,
      },
      orderBy: [{ billing_year: 'desc' }, { billing_month: 'desc' }, { due_date: 'asc' }],
    });

    const response = charges.map((c) => {
      const primaryTenant = c.tsmib_leases.tsmib_lease_tenants[0]?.tsmib_tenants;
      const totalPaid = c.tsmib_payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);
      const totalCharge = Number(c.total_amount || c.rent_amount);

      return {
        id: c.id,
        leaseId: c.lease_id,
        apartmentId: c.apartment_id,
        apartmentNumber: c.tsmib_apartments.apartment_number,
        buildingName: c.tsmib_apartments.tsmib_buildings.name,
        tenantName: primaryTenant ? `${primaryTenant.first_name} ${primaryTenant.last_name || ''}`.trim() : 'Unknown',
        tenantPhone: primaryTenant?.phone,
        billingYear: c.billing_year,
        billingMonth: c.billing_month,
        dueDate: c.due_date,
        rentAmount: c.rent_amount,
        lateFee: c.late_fee,
        totalAmount: totalCharge,
        paidAmount: totalPaid,
        pendingAmount: Math.max(0, totalCharge - totalPaid),
        status: c.tsmib_rent_status.code,
        statusName: c.tsmib_rent_status.name,
      };
    });

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list charges' });
  }
});

// 3. GENERATE MONTHLY RENT CHARGES (Phase 8: Idempotent Rent Engine)
router.post('/generate-charges', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { billingYear, billingMonth, dryRun, prorate, propertyId } = generateMonthlyRentSchema.parse(req.body);

    const result = await RentEngine.generateMonthlyRentCharges({
      organizationId: orgId,
      billingYear,
      billingMonth,
      dryRun,
      prorate,
      propertyId,
    });

    res.json({
      message: dryRun
        ? `Rent preview generated for ${result.billingPeriod}`
        : `Rent generation completed for ${result.billingPeriod}`,
      ...result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to generate rent charges' });
  }
});

// 4. PROCESS OVERDUE CHARGES & APPLY LATE FEES (Phase 8: Late Fee & Status Engine)
router.post('/process-overdue', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const result = await RentEngine.processOverdueCharges(orgId);

    res.json({
      message: `Overdue processing completed: ${result.overdueChargesCount} charges marked OVERDUE (${result.lateFeesAppliedCount} late fees applied)`,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to process overdue charges' });
  }
});

// 5. GET RENT SUMMARY & COLLECTION RATE (Phase 8: Analytics Engine)
router.get('/summary', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { year, month } = req.query;

    const summary = await RentEngine.getRentSummary(
      orgId,
      year ? Number(year) : undefined,
      month ? Number(month) : undefined
    );

    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch rent summary' });
  }
});

// 6. RECORD PAYMENT (Phase 9 & 10: Payments, Allocations & Receipts)
router.post('/payments', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = recordPaymentSchema.parse(req.body);

    const result = await PaymentService.recordPayment({
      organizationId: orgId,
      ...data,
    });

    res.status(201).json({
      message: 'Payment recorded and receipt generated successfully',
      ...result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to record payment' });
  }
});

export default router;
