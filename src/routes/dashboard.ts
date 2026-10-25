import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';

const router = Router();

router.get('/metrics', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = req.user!.organizationId;
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const [
      propertiesCount,
      buildingsCount,
      apartmentsCount,
      tenantsCount,
      activeLeases,
      openMaintenanceCount,
      completedMaintenanceCount,
      rentCharges,
      expenses,
    ] = await Promise.all([
      prisma.tsmib_properties.count({ where: { organization_id: organizationId } }),
      prisma.tsmib_buildings.count({
        where: { tsmib_properties: { organization_id: organizationId } },
      }),
      prisma.tsmib_apartments.count({
        where: { tsmib_buildings: { tsmib_properties: { organization_id: organizationId } } },
      }),
      prisma.tsmib_tenants.count({ where: { organization_id: organizationId } }),
      prisma.tsmib_leases.findMany({
        where: {
          organization_id: organizationId,
          status: 'ACTIVE',
          start_date: { lte: today },
          OR: [{ end_date: null }, { end_date: { gte: today } }],
        },
        select: { apartment_id: true, monthly_rent: true },
      }),
      prisma.tsmib_maintenance_requests.count({
        where: {
          organization_id: organizationId,
          tsmib_maintenance_status: { code: { notIn: ['COMPLETED', 'CANCELLED'] } },
        },
      }),
      prisma.tsmib_maintenance_requests.count({
        where: {
          organization_id: organizationId,
          tsmib_maintenance_status: { code: 'COMPLETED' },
          completed_at: { gte: monthStart, lt: nextMonthStart },
        },
      }),
      prisma.tsmib_rent_charges.findMany({
        where: {
          organization_id: organizationId,
          billing_year: now.getUTCFullYear(),
          billing_month: now.getUTCMonth() + 1,
        },
        select: {
          rent_amount: true,
          late_fee: true,
          total_amount: true,
          tsmib_payment_allocations: { select: { amount: true } },
          tsmib_rent_status: { select: { code: true } },
        },
      }),
      prisma.tsmib_expenses.findMany({
        where: {
          organization_id: organizationId,
          expense_date: { gte: monthStart, lt: nextMonthStart },
        },
        select: { amount: true },
      }),
    ]);

    let expectedRent = 0;
    let collectedRent = 0;
    let overdueRent = 0;
    for (const charge of rentCharges) {
      const chargeTotal = Number(charge.total_amount || Number(charge.rent_amount) + Number(charge.late_fee || 0));
      const paid = charge.tsmib_payment_allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0);
      expectedRent += chargeTotal;
      collectedRent += paid;
      if (charge.tsmib_rent_status.code === 'OVERDUE') {
        overdueRent += Math.max(0, chargeTotal - paid);
      }
    }

    const totalExpenses = expenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
    const occupiedApartmentCount = new Set(activeLeases.map((lease) => lease.apartment_id)).size;
    const vacantApartments = Math.max(0, apartmentsCount - occupiedApartmentCount);

    return res.json({
      period: {
        month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        currency: 'INR',
      },
      summary: {
        totalProperties: propertiesCount,
        totalBuildings: buildingsCount,
        totalApartments: apartmentsCount,
        occupiedApartments: occupiedApartmentCount,
        vacantApartments,
        totalTenants: tenantsCount,
        maintenanceRequests: openMaintenanceCount,
        openMaintenanceRequests: openMaintenanceCount,
        completedMaintenanceRequests: completedMaintenanceCount,
      },
      financials: {
        monthlyRent: activeLeases.reduce((sum, lease) => sum + Number(lease.monthly_rent), 0),
        expectedRent,
        collectedRent,
        pendingRent: Math.max(0, expectedRent - collectedRent),
        overdueRent,
        totalExpenses,
        currency: 'INR',
      },
      occupancyRate: apartmentsCount > 0
        ? Math.round((occupiedApartmentCount / apartmentsCount) * 100)
        : 0,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to fetch dashboard metrics' });
  }
});

export default router;
