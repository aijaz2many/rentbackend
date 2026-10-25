import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';

const router = Router();
const reportAccess = [requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN'])];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const dateRangeSchema = z.object({
  startDate: z.string().regex(datePattern).optional(),
  endDate: z.string().regex(datePattern).optional(),
});

function parseCalendarDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function readDateRange(query: z.infer<typeof dateRangeSchema>) {
  const now = new Date();
  const start = query.startDate
    ? parseCalendarDate(query.startDate)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = query.endDate
    ? parseCalendarDate(query.endDate)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!start || !end) return null;

  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const days = (endExclusive.getTime() - start.getTime()) / 86_400_000;
  if (days < 1 || days > 366) return null;
  return { start, end, endExclusive };
}

router.get('/rent', ...reportAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const range = readDateRange(query);
    if (!range) return res.status(400).json({ error: 'Provide a valid date range of 1 to 366 days' });

    const charges = await prisma.tsmib_rent_charges.findMany({
      where: {
        organization_id: req.user!.organizationId,
        due_date: { gte: range.start, lt: range.endExclusive },
      },
      include: {
        tsmib_rent_status: { select: { code: true, name: true } },
        tsmib_apartments: {
          select: {
            apartment_number: true,
            tsmib_buildings: {
              select: {
                name: true,
                tsmib_properties: { select: { name: true } },
              },
            },
          },
        },
        tsmib_leases: {
          include: {
            tsmib_lease_tenants: {
              where: { is_primary: true },
              include: { tsmib_tenants: { select: { id: true, first_name: true, last_name: true } } },
            },
          },
        },
        tsmib_payment_allocations: { select: { amount: true } },
      },
      orderBy: [{ due_date: 'asc' }, { created_at: 'asc' }],
    });

    const records = charges.map((charge) => {
      const paid = charge.tsmib_payment_allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0);
      const total = Number(charge.total_amount || Number(charge.rent_amount) + Number(charge.late_fee || 0));
      const primaryTenant = charge.tsmib_leases.tsmib_lease_tenants[0]?.tsmib_tenants;
      return {
        id: charge.id,
        dueDate: charge.due_date,
        billingPeriod: `${charge.billing_year}-${String(charge.billing_month).padStart(2, '0')}`,
        property: charge.tsmib_apartments.tsmib_buildings.tsmib_properties.name,
        building: charge.tsmib_apartments.tsmib_buildings.name,
        apartment: charge.tsmib_apartments.apartment_number,
        tenant: primaryTenant
          ? { id: primaryTenant.id, name: `${primaryTenant.first_name} ${primaryTenant.last_name || ''}`.trim() }
          : null,
        expected: total,
        collected: paid,
        outstanding: Math.max(0, total - paid),
        status: charge.tsmib_rent_status.code,
      };
    });
    const summary = records.reduce((totals, record) => {
      totals.expected += record.expected;
      totals.collected += record.collected;
      totals.outstanding += record.outstanding;
      if (record.status === 'OVERDUE') totals.overdue += record.outstanding;
      return totals;
    }, { expected: 0, collected: 0, outstanding: 0, overdue: 0 });

    return res.json({
      period: { startDate: range.start.toISOString().slice(0, 10), endDate: range.end.toISOString().slice(0, 10) },
      summary,
      charges: records,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to generate rent report' });
  }
});

router.get('/tenant-payments', ...reportAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = dateRangeSchema.extend({
      tenantId: z.string().uuid().optional(),
    }).parse(req.query);
    const range = readDateRange(query);
    if (!range) return res.status(400).json({ error: 'Provide a valid date range of 1 to 366 days' });

    const payments = await prisma.tsmib_payments.findMany({
      where: {
        organization_id: req.user!.organizationId,
        payment_date: { gte: range.start, lt: range.endExclusive },
        status: 'SUCCESS',
        ...(query.tenantId ? { tenant_id: query.tenantId } : {}),
      },
      include: {
        tsmib_tenants: { select: { id: true, first_name: true, last_name: true, phone: true, email: true } },
        tsmib_apartments: {
          select: {
            apartment_number: true,
            tsmib_buildings: { select: { name: true } },
          },
        },
        tsmib_payment_method: { select: { code: true, name: true } },
        tsmib_payment_receipts: { select: { receipt_number: true } },
        tsmib_payment_allocations: {
          include: {
            tsmib_rent_charges: {
              select: { billing_year: true, billing_month: true },
            },
          },
        },
      },
      orderBy: { payment_date: 'desc' },
    });

    const paymentsReport = payments.map((payment) => ({
      id: payment.id,
      reference: payment.payment_reference,
      date: payment.payment_date,
      tenant: payment.tsmib_tenants
        ? {
            id: payment.tsmib_tenants.id,
            name: `${payment.tsmib_tenants.first_name} ${payment.tsmib_tenants.last_name || ''}`.trim(),
            phone: payment.tsmib_tenants.phone,
            email: payment.tsmib_tenants.email,
          }
        : null,
      apartment: payment.tsmib_apartments?.apartment_number || null,
      building: payment.tsmib_apartments?.tsmib_buildings.name || null,
      amount: Number(payment.amount),
      method: payment.tsmib_payment_method.name,
      status: payment.status,
      receipts: payment.tsmib_payment_receipts.map((receipt) => receipt.receipt_number),
      allocations: payment.tsmib_payment_allocations.map((allocation) => ({
        amount: Number(allocation.amount),
        billingPeriod: `${allocation.tsmib_rent_charges.billing_year}-${String(allocation.tsmib_rent_charges.billing_month).padStart(2, '0')}`,
      })),
    }));

    return res.json({
      period: { startDate: range.start.toISOString().slice(0, 10), endDate: range.end.toISOString().slice(0, 10) },
      totalCollected: paymentsReport.reduce((total, payment) => total + payment.amount, 0),
      count: paymentsReport.length,
      payments: paymentsReport,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to generate tenant payment report' });
  }
});

router.get('/occupancy', ...reportAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = dateRangeSchema.extend({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(50),
    }).parse(req.query);
    const range = readDateRange(query);
    if (!range) return res.status(400).json({ error: 'Provide a valid date range of 1 to 366 days' });

    const organizationId = req.user!.organizationId;
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [totalApartments, activeLeases, turnovers] = await Promise.all([
      prisma.tsmib_apartments.count({
        where: { tsmib_buildings: { tsmib_properties: { organization_id: organizationId } } },
      }),
      prisma.tsmib_leases.findMany({
        where: {
          organization_id: organizationId,
          status: 'ACTIVE',
          start_date: { lte: today },
          OR: [{ end_date: null }, { end_date: { gte: today } }],
        },
        select: { apartment_id: true },
      }),
      prisma.tsmib_leases.count({
        where: {
          organization_id: organizationId,
          OR: [
            { terminated_at: { gte: range.start, lt: range.endExclusive } },
            {
              status: { not: 'ACTIVE' },
              end_date: { gte: range.start, lt: range.endExclusive },
            },
          ],
        },
      }),
    ]);

    const occupiedIds = [...new Set(activeLeases.map((lease) => lease.apartment_id))];
    const vacantWhere = {
      tsmib_buildings: { tsmib_properties: { organization_id: organizationId } },
      ...(occupiedIds.length > 0 ? { id: { notIn: occupiedIds } } : {}),
    };
    const [vacantApartments, vacantCount] = await Promise.all([
      prisma.tsmib_apartments.findMany({
        where: vacantWhere,
        select: {
          id: true,
          apartment_number: true,
          tsmib_buildings: {
            select: {
              name: true,
              tsmib_properties: { select: { name: true } },
            },
          },
        },
        orderBy: [{ tsmib_buildings: { name: 'asc' } }, { apartment_number: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.tsmib_apartments.count({ where: vacantWhere }),
    ]);
    const occupiedCount = Math.min(totalApartments, occupiedIds.length);

    return res.json({
      period: { startDate: range.start.toISOString().slice(0, 10), endDate: range.end.toISOString().slice(0, 10) },
      summary: {
        totalApartments,
        occupiedApartments: occupiedCount,
        vacantApartments: vacantCount,
        occupancyPercentage: totalApartments > 0 ? Math.round((occupiedCount / totalApartments) * 10000) / 100 : 0,
        tenantTurnover: turnovers,
      },
      vacantApartments: vacantApartments.map((apartment) => ({
        id: apartment.id,
        apartmentNumber: apartment.apartment_number,
        building: apartment.tsmib_buildings.name,
        property: apartment.tsmib_buildings.tsmib_properties.name,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: vacantCount,
        totalPages: Math.ceil(vacantCount / query.limit),
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to generate occupancy report' });
  }
});

router.get('/expenses', ...reportAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const range = readDateRange(query);
    if (!range) return res.status(400).json({ error: 'Provide a valid date range of 1 to 366 days' });

    const [expenses, maintenance] = await Promise.all([
      prisma.tsmib_expenses.findMany({
        where: {
          organization_id: req.user!.organizationId,
          expense_date: { gte: range.start, lt: range.endExclusive },
        },
        include: {
          tsmib_expense_categories: { select: { id: true, name: true } },
          tsmib_properties: { select: { id: true, name: true } },
          tsmib_buildings: {
            select: {
              id: true,
              name: true,
              tsmib_properties: { select: { id: true, name: true } },
            },
          },
          tsmib_apartments: {
            select: {
              tsmib_buildings: {
                select: { name: true, tsmib_properties: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: [{ expense_date: 'desc' }, { created_at: 'desc' }],
      }),
      prisma.tsmib_maintenance_requests.findMany({
        where: {
          organization_id: req.user!.organizationId,
          completed_at: { gte: range.start, lt: range.endExclusive },
          actual_cost: { not: null },
        },
        select: { actual_cost: true, completed_at: true },
      }),
    ]);
    const groupTotals = (items: Array<{ name: string | null; amount: number }>) => {
      const totals = new Map<string, number>();
      for (const item of items) {
        const key = item.name || 'Unassigned';
        totals.set(key, (totals.get(key) || 0) + item.amount);
      }
      return [...totals.entries()]
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount);
    };

    const reportExpenses = expenses.map((expense) => ({
      id: expense.id,
      expenseNumber: expense.expense_number,
      date: expense.expense_date,
      amount: Number(expense.amount),
      category: expense.tsmib_expense_categories?.name || 'Unassigned',
      property: expense.tsmib_properties?.name
        || expense.tsmib_buildings?.tsmib_properties.name
        || expense.tsmib_apartments?.tsmib_buildings.tsmib_properties.name
        || 'Unassigned',
      building: expense.tsmib_buildings?.name || expense.tsmib_apartments?.tsmib_buildings.name || 'Unassigned',
      vendor: expense.vendor_name,
      description: expense.description,
    }));
    const maintenanceCost = maintenance.reduce((sum, request) => sum + Number(request.actual_cost || 0), 0);
    const monthlyTotals = new Map<string, { month: string; expenses: number; maintenance: number }>();
    const addMonthlyTotal = (date: Date, amount: number, kind: 'expenses' | 'maintenance') => {
      const month = date.toISOString().slice(0, 7);
      const totals = monthlyTotals.get(month) || { month, expenses: 0, maintenance: 0 };
      totals[kind] += amount;
      monthlyTotals.set(month, totals);
    };
    for (const expense of expenses) addMonthlyTotal(expense.expense_date, Number(expense.amount), 'expenses');
    for (const request of maintenance) {
      if (request.completed_at) addMonthlyTotal(request.completed_at, Number(request.actual_cost || 0), 'maintenance');
    }

    return res.json({
      period: { startDate: range.start.toISOString().slice(0, 10), endDate: range.end.toISOString().slice(0, 10) },
      summary: {
        expenses: reportExpenses.reduce((sum, expense) => sum + expense.amount, 0),
        maintenance: maintenanceCost,
        combined: reportExpenses.reduce((sum, expense) => sum + expense.amount, maintenanceCost),
      },
      byCategory: groupTotals(reportExpenses.map((expense) => ({ name: expense.category, amount: expense.amount }))),
      byProperty: groupTotals(reportExpenses.map((expense) => ({ name: expense.property, amount: expense.amount }))),
      monthly: [...monthlyTotals.values()].sort((a, b) => a.month.localeCompare(b.month)),
      expenses: reportExpenses,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to generate expense report' });
  }
});

router.get('/maintenance', ...reportAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = dateRangeSchema.parse(req.query);
    const range = readDateRange(query);
    if (!range) return res.status(400).json({ error: 'Provide a valid date range of 1 to 366 days' });

    const [openCount, completed] = await Promise.all([
      prisma.tsmib_maintenance_requests.count({
        where: {
          organization_id: req.user!.organizationId,
          tsmib_maintenance_status: { code: { notIn: ['COMPLETED', 'CANCELLED'] } },
        },
      }),
      prisma.tsmib_maintenance_requests.findMany({
        where: {
          organization_id: req.user!.organizationId,
          tsmib_maintenance_status: { code: 'COMPLETED' },
          completed_at: { gte: range.start, lt: range.endExclusive },
        },
        select: { id: true, request_number: true, title: true, requested_at: true, completed_at: true, actual_cost: true },
        orderBy: { completed_at: 'desc' },
      }),
    ]);

    const completionDurations = completed
      .filter((request) => request.completed_at)
      .map((request) => (request.completed_at!.getTime() - request.requested_at.getTime()) / 86_400_000);
    const maintenanceCost = completed.reduce((sum, request) => sum + Number(request.actual_cost || 0), 0);

    return res.json({
      period: { startDate: range.start.toISOString().slice(0, 10), endDate: range.end.toISOString().slice(0, 10) },
      summary: {
        openRequests: openCount,
        completedRequests: completed.length,
        maintenanceCost,
        averageCompletionDays: completionDurations.length > 0
          ? Math.round((completionDurations.reduce((sum, duration) => sum + duration, 0) / completionDurations.length) * 100) / 100
          : 0,
      },
      completedRequests: completed.map((request) => ({
        id: request.id,
        requestNumber: request.request_number,
        title: request.title,
        requestedAt: request.requested_at,
        completedAt: request.completed_at,
        actualCost: Number(request.actual_cost || 0),
      })),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to generate maintenance report' });
  }
});

export default router;
