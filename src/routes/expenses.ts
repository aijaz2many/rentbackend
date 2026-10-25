import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';

const router = Router();

const optionalId = z.string().uuid().optional().nullable();
const expenseCategorySchema = z.object({
  name: z.string().trim().min(2).max(100),
});
const expenseSchema = z.object({
  propertyId: optionalId,
  buildingId: optionalId,
  apartmentId: optionalId,
  categoryId: optionalId,
  amount: z.number().positive(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expense date must use YYYY-MM-DD format'),
  vendorName: z.string().trim().max(200).optional().nullable(),
  invoiceNumber: z.string().trim().max(100).optional().nullable(),
  description: z.string().trim().optional().nullable(),
});

function dateFromInput(date: string): Date | null {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : parsed;
}

function expenseNumber(): string {
  return `EXP-${new Date().getUTCFullYear()}-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function validateExpenseReferences(
  organizationId: string,
  values: { propertyId?: string | null; buildingId?: string | null; apartmentId?: string | null; categoryId?: string | null }
): Promise<{ error: string | null; propertyId: string | null; buildingId: string | null; apartmentId: string | null }> {
  let propertyId = values.propertyId || null;
  let buildingId = values.buildingId || null;
  const apartmentId = values.apartmentId || null;

  if (propertyId) {
    const property = await prisma.tsmib_properties.findFirst({
      where: { id: propertyId, organization_id: organizationId },
      select: { id: true },
    });
    if (!property) return { error: 'Property not found in your organization', propertyId, buildingId, apartmentId };
  }

  if (buildingId) {
    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: buildingId,
        tsmib_properties: { organization_id: organizationId },
      },
      select: { id: true, property_id: true },
    });
    if (!building) return { error: 'Building not found in your organization', propertyId, buildingId, apartmentId };
    if (propertyId && propertyId !== building.property_id) {
      return { error: 'Building does not belong to the selected property', propertyId, buildingId, apartmentId };
    }
    propertyId = building.property_id;
  }

  if (apartmentId) {
    const apartment = await prisma.tsmib_apartments.findFirst({
      where: {
        id: apartmentId,
        tsmib_buildings: { tsmib_properties: { organization_id: organizationId } },
      },
      select: { building_id: true, tsmib_buildings: { select: { property_id: true } } },
    });
    if (!apartment) return { error: 'Apartment not found in your organization', propertyId, buildingId, apartmentId };
    if (buildingId && buildingId !== apartment.building_id) {
      return { error: 'Apartment does not belong to the selected building', propertyId, buildingId, apartmentId };
    }
    if (propertyId && propertyId !== apartment.tsmib_buildings.property_id) {
      return { error: 'Apartment does not belong to the selected property', propertyId, buildingId, apartmentId };
    }
    buildingId = apartment.building_id;
    propertyId = apartment.tsmib_buildings.property_id;
  }

  if (values.categoryId) {
    const category = await prisma.tsmib_expense_categories.findFirst({
      where: {
        id: values.categoryId,
        is_active: true,
        OR: [{ organization_id: organizationId }, { organization_id: null }],
      },
      select: { id: true },
    });
    if (!category) return { error: 'Expense category not found', propertyId, buildingId, apartmentId };
  }

  return { error: null, propertyId, buildingId, apartmentId };
}

// Expense categories include organization-owned categories and shared defaults.
router.get('/categories', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const categories = await prisma.tsmib_expense_categories.findMany({
      where: {
        is_active: true,
        OR: [{ organization_id: req.user!.organizationId }, { organization_id: null }],
      },
      orderBy: { name: 'asc' },
    });
    return res.json(categories);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to list expense categories' });
  }
});

router.post(
  '/categories',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name } = expenseCategorySchema.parse(req.body);
      const organizationId = req.user!.organizationId;
      const duplicate = await prisma.tsmib_expense_categories.findFirst({
        where: { organization_id: organizationId, name: { equals: name, mode: 'insensitive' } },
      });
      if (duplicate) return res.status(409).json({ error: 'Expense category already exists' });

      const category = await prisma.tsmib_expense_categories.create({
        data: { organization_id: organizationId, name },
      });
      return res.status(201).json(category);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      return res.status(500).json({ error: error.message || 'Failed to create expense category' });
    }
  }
);

router.patch(
  '/categories/:id',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name } = expenseCategorySchema.parse(req.body);
      const organizationId = req.user!.organizationId;
      const existing = await prisma.tsmib_expense_categories.findFirst({
        where: { id: req.params.id, organization_id: organizationId },
      });
      if (!existing) return res.status(404).json({ error: 'Expense category not found' });

      const duplicate = await prisma.tsmib_expense_categories.findFirst({
        where: {
          organization_id: organizationId,
          name: { equals: name, mode: 'insensitive' },
          NOT: { id: existing.id },
        },
      });
      if (duplicate) return res.status(409).json({ error: 'Expense category already exists' });

      const category = await prisma.tsmib_expense_categories.update({
        where: { id: existing.id },
        data: { name },
      });
      return res.json(category);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      return res.status(500).json({ error: error.message || 'Failed to update expense category' });
    }
  }
);

router.delete(
  '/categories/:id',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const category = await prisma.tsmib_expense_categories.findFirst({
        where: { id: req.params.id, organization_id: req.user!.organizationId },
      });
      if (!category) return res.status(404).json({ error: 'Expense category not found' });

      await prisma.tsmib_expense_categories.update({
        where: { id: category.id },
        data: { is_active: false },
      });
      return res.json({ message: 'Expense category deactivated' });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || 'Failed to deactivate expense category' });
    }
  }
);

router.get('/summary', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentMonthStart = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1
    ));
    const query = z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);
    const startDate = query.startDate ? dateFromInput(query.startDate) : currentMonthStart;
    const now = new Date();
    const endDate = query.endDate
      ? dateFromInput(query.endDate)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Date filters must be valid calendar dates' });
    }
    const endExclusive = new Date(endDate);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const rangeDays = (endExclusive.getTime() - startDate.getTime()) / 86_400_000;
    if (rangeDays < 1 || rangeDays > 366) {
      return res.status(400).json({ error: 'Date range must be between 1 and 366 days' });
    }

    const organizationId = req.user!.organizationId;
    const [expenses, maintenanceRequests] = await Promise.all([
      prisma.tsmib_expenses.findMany({
        where: {
          organization_id: organizationId,
          expense_date: { gte: startDate, lt: endExclusive },
        },
        select: {
          amount: true,
          expense_date: true,
          tsmib_properties: { select: { id: true, name: true } },
          tsmib_buildings: { select: { id: true, name: true } },
          tsmib_expense_categories: { select: { id: true, name: true } },
        },
      }),
      prisma.tsmib_maintenance_requests.findMany({
        where: {
          organization_id: organizationId,
          completed_at: { gte: startDate, lt: endExclusive },
          actual_cost: { not: null },
        },
        select: {
          actual_cost: true,
          completed_at: true,
          tsmib_apartments: {
            select: {
              tsmib_buildings: {
                select: {
                  id: true,
                  name: true,
                  tsmib_properties: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const byDimension = (
      rows: Array<{ amount: number; id: string | null; name: string | null }>
    ) => {
      const totals = new Map<string, { id: string | null; name: string; amount: number }>();
      for (const row of rows) {
        const key = row.id || 'unassigned';
        const current = totals.get(key) || { id: row.id, name: row.name || 'Unassigned', amount: 0 };
        current.amount += row.amount;
        totals.set(key, current);
      }
      return [...totals.values()].sort((a, b) => b.amount - a.amount);
    };

    const monthlyTotals = new Map<string, { month: string; expenses: number; maintenance: number }>();
    const addMonthlyTotal = (date: Date, amount: number, field: 'expenses' | 'maintenance') => {
      const month = date.toISOString().slice(0, 7);
      const total = monthlyTotals.get(month) || { month, expenses: 0, maintenance: 0 };
      total[field] += amount;
      monthlyTotals.set(month, total);
    };
    for (const expense of expenses) addMonthlyTotal(expense.expense_date, Number(expense.amount), 'expenses');
    for (const request of maintenanceRequests) {
      if (request.completed_at && request.actual_cost !== null) {
        addMonthlyTotal(request.completed_at, Number(request.actual_cost), 'maintenance');
      }
    }

    const propertyRows: Array<{ amount: number; id: string | null; name: string | null }> = [];
    const buildingRows: Array<{ amount: number; id: string | null; name: string | null }> = [];
    const categoryRows: Array<{ amount: number; id: string | null; name: string | null }> = [];
    const maintenancePropertyRows: Array<{ amount: number; id: string | null; name: string | null }> = [];
    const maintenanceBuildingRows: Array<{ amount: number; id: string | null; name: string | null }> = [];
    for (const expense of expenses) {
      const amount = Number(expense.amount);
      propertyRows.push({
        amount,
        id: expense.tsmib_properties?.id || null,
        name: expense.tsmib_properties?.name || null,
      });
      buildingRows.push({
        amount,
        id: expense.tsmib_buildings?.id || null,
        name: expense.tsmib_buildings?.name || null,
      });
      categoryRows.push({
        amount,
        id: expense.tsmib_expense_categories?.id || null,
        name: expense.tsmib_expense_categories?.name || null,
      });
    }
    for (const request of maintenanceRequests) {
      if (request.actual_cost === null) continue;
      const amount = Number(request.actual_cost);
      const building = request.tsmib_apartments.tsmib_buildings;
      maintenancePropertyRows.push({
        amount,
        id: building.tsmib_properties?.id || null,
        name: building.tsmib_properties?.name || null,
      });
      maintenanceBuildingRows.push({
        amount,
        id: building.id,
        name: building.name,
      });
    }

    const expenseTotal = expenses.reduce((total, expense) => total + Number(expense.amount), 0);
    const maintenanceTotal = maintenanceRequests.reduce(
      (total, request) => total + Number(request.actual_cost || 0),
      0
    );
    return res.json({
      period: { startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) },
      totals: {
        expenses: expenseTotal,
        maintenance: maintenanceTotal,
        combined: expenseTotal + maintenanceTotal,
      },
      monthly: [...monthlyTotals.values()].sort((a, b) => a.month.localeCompare(b.month)),
      byProperty: byDimension(propertyRows),
      byBuilding: byDimension(buildingRows),
      byCategory: byDimension(categoryRows),
      maintenanceByProperty: byDimension(maintenancePropertyRows),
      maintenanceByBuilding: byDimension(maintenanceBuildingRows),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Failed to summarize expenses' });
  }
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const querySchema = z.object({
      propertyId: z.string().uuid().optional(),
      buildingId: z.string().uuid().optional(),
      apartmentId: z.string().uuid().optional(),
      categoryId: z.string().uuid().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(25),
    }).refine((query) => !query.startDate || !query.endDate || query.startDate <= query.endDate, {
      message: 'Start date must be before or equal to end date',
    });
    const query = querySchema.parse(req.query);
    const startDate = query.startDate ? dateFromInput(query.startDate) : undefined;
    const endDate = query.endDate ? dateFromInput(query.endDate) : undefined;
    if ((query.startDate && !startDate) || (query.endDate && !endDate)) {
      return res.status(400).json({ error: 'Date filters must be valid calendar dates' });
    }

    const where = {
      organization_id: req.user!.organizationId,
      ...(query.propertyId ? { property_id: query.propertyId } : {}),
      ...(query.buildingId ? { building_id: query.buildingId } : {}),
      ...(query.apartmentId ? { apartment_id: query.apartmentId } : {}),
      ...(query.categoryId ? { category_id: query.categoryId } : {}),
      ...(startDate || endDate
        ? { expense_date: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } }
        : {}),
    };

    const [expenses, total] = await Promise.all([
      prisma.tsmib_expenses.findMany({
        where,
        include: {
          tsmib_expense_categories: true,
          tsmib_properties: { select: { id: true, name: true } },
          tsmib_buildings: { select: { id: true, name: true } },
          tsmib_apartments: { select: { id: true, apartment_number: true } },
        },
        orderBy: [{ expense_date: 'desc' }, { created_at: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.tsmib_expenses.count({ where }),
    ]);

    return res.json({
      expenses,
      pagination: { total, page: query.page, limit: query.limit, totalPages: Math.ceil(total / query.limit) },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Failed to list expenses' });
  }
});

router.post(
  '/',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = expenseSchema.parse(req.body);
      const expenseDate = dateFromInput(data.expenseDate);
      if (!expenseDate) return res.status(400).json({ error: 'Expense date must be a valid calendar date' });

      const organizationId = req.user!.organizationId;
      const references = await validateExpenseReferences(organizationId, data);
      if (references.error) return res.status(400).json({ error: references.error });

      const expense = await prisma.tsmib_expenses.create({
        data: {
          organization_id: organizationId,
          property_id: references.propertyId,
          building_id: references.buildingId,
          apartment_id: references.apartmentId,
          category_id: data.categoryId || null,
          expense_number: expenseNumber(),
          amount: data.amount,
          expense_date: expenseDate,
          vendor_name: data.vendorName || null,
          invoice_number: data.invoiceNumber || null,
          description: data.description || null,
          created_by: req.user!.userId,
        },
        include: { tsmib_expense_categories: true },
      });
      return res.status(201).json(expense);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      return res.status(500).json({ error: error.message || 'Failed to create expense' });
    }
  }
);

router.patch(
  '/:id',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = expenseSchema.partial().parse(req.body);
      const existing = await prisma.tsmib_expenses.findFirst({
        where: { id: req.params.id, organization_id: req.user!.organizationId },
      });
      if (!existing) return res.status(404).json({ error: 'Expense not found' });

      const referenceValues = {
        propertyId: data.propertyId === undefined ? existing.property_id : data.propertyId,
        buildingId: data.buildingId === undefined ? existing.building_id : data.buildingId,
        apartmentId: data.apartmentId === undefined ? existing.apartment_id : data.apartmentId,
        categoryId: data.categoryId === undefined ? existing.category_id : data.categoryId,
      };
      const references = await validateExpenseReferences(req.user!.organizationId, referenceValues);
      if (references.error) return res.status(400).json({ error: references.error });

      const expenseDate = data.expenseDate ? dateFromInput(data.expenseDate) : undefined;
      if (data.expenseDate && !expenseDate) {
        return res.status(400).json({ error: 'Expense date must be a valid calendar date' });
      }

      const expense = await prisma.tsmib_expenses.update({
        where: { id: existing.id },
        data: {
          property_id: references.propertyId,
          building_id: references.buildingId,
          apartment_id: references.apartmentId,
          ...(data.categoryId !== undefined ? { category_id: data.categoryId } : {}),
          ...(data.amount !== undefined ? { amount: data.amount } : {}),
          ...(expenseDate ? { expense_date: expenseDate } : {}),
          ...(data.vendorName !== undefined ? { vendor_name: data.vendorName } : {}),
          ...(data.invoiceNumber !== undefined ? { invoice_number: data.invoiceNumber } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
        },
        include: { tsmib_expense_categories: true },
      });
      return res.json(expense);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors[0].message });
      }
      return res.status(500).json({ error: error.message || 'Failed to update expense' });
    }
  }
);

router.delete(
  '/:id',
  requireAuth,
  requireRole(['OWNER', 'MANAGER', 'ADMIN']),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await prisma.tsmib_expenses.deleteMany({
        where: { id: req.params.id, organization_id: req.user!.organizationId },
      });
      if (result.count === 0) return res.status(404).json({ error: 'Expense not found' });
      return res.json({ message: 'Expense deleted successfully' });
    } catch (error: any) {
      return res.status(500).json({ error: error.message || 'Failed to delete expense' });
    }
  }
);

export default router;
