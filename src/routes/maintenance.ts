import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';
import {
  notifyOrganizationAfterBusinessEvent,
  notifyTenantAfterBusinessEvent,
} from '../services/notificationService';

const router = Router();

// Validation Schemas
const createMaintenanceRequestSchema = z.object({
  apartmentId: z.string().uuid('Invalid apartment ID'),
  tenantId: z.string().uuid('Invalid tenant ID').optional(),
  categoryId: z.string().uuid('Invalid category ID'),
  priorityCode: z.enum(['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY']).default('MEDIUM'),
  title: z.string().min(3, 'Title is required'),
  description: z.string().min(5, 'Description is required'),
  estimatedCost: z.number().nonnegative().optional(),
});

const updateMaintenanceStatusSchema = z.object({
  statusCode: z.enum(['SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_PARTS', 'COMPLETED', 'CANCELLED']),
  comment: z.string().optional(),
  actualCost: z.number().nonnegative().optional(),
});

const assignWorkerSchema = z.object({
  workerId: z.string().uuid('Invalid worker ID'),
  notes: z.string().optional(),
});

const createWorkerSchema = z.object({
  workerName: z.string().min(2, 'Worker name is required'),
  workerPhone: z.string().min(5, 'Worker phone is required'),
  workerType: z.string().min(2, 'Worker type/trade is required (e.g. Electrician, Plumber)'),
  email: z.string().email().optional().nullable(),
  companyName: z.string().optional().nullable(),
});

// Helper to generate unique request number
function generateRequestNumber(): string {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(100 + Math.random() * 900);
  return `REQ-${ts}-${rand}`;
}

// 1. LOOKUPS: Categories, Priorities, Statuses, Workers
router.get('/meta/lookups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;

    const [categories, priorities, statuses, workers] = await Promise.all([
      prisma.tsmib_maintenance_categories.findMany({
        where: {
          OR: [{ organization_id: orgId }, { organization_id: null }],
          is_active: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.tsmib_maintenance_priority.findMany(),
      prisma.tsmib_maintenance_status.findMany(),
      tenantScope
        ? Promise.resolve([])
        : prisma.tsmib_maintenance_workers.findMany({
            where: { is_active: true },
            orderBy: { worker_name: 'asc' },
          }),
    ]);

    res.json({ categories, priorities, statuses, workers });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch maintenance lookups' });
  }
});

// 2. LIST MAINTENANCE REQUESTS
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { status, priority, apartmentId, page, limit } = req.query;

    const where: any = { organization_id: orgId };

    if (tenantScope) where.tenant_id = tenantScope;
    if (apartmentId) where.apartment_id = String(apartmentId);

    if (status) {
      where.tsmib_maintenance_status = { code: String(status) };
    }

    if (priority) {
      where.tsmib_maintenance_priority = { code: String(priority) };
    }

    const pageNum = page ? Number(page) : 1;
    const limitNum = limit ? Number(limit) : 25;
    const skip = (pageNum - 1) * limitNum;

    const [requests, total] = await Promise.all([
      prisma.tsmib_maintenance_requests.findMany({
        where,
        include: {
          tsmib_apartments: {
            include: { tsmib_buildings: true },
          },
          tsmib_tenants: true,
          tsmib_maintenance_categories: true,
          tsmib_maintenance_priority: true,
          tsmib_maintenance_status: true,
          tsmib_maintenance_assignments: {
            include: { tsmib_maintenance_workers: true },
          },
          tsmib_maintenance_updates: {
            orderBy: { created_at: 'desc' },
            take: 3,
          },
        },
        orderBy: [{ created_at: 'desc' }],
        skip,
        take: limitNum,
      }),
      prisma.tsmib_maintenance_requests.count({ where }),
    ]);

    const formatted = requests.map((r) => {
      const assignedWorker = r.tsmib_maintenance_assignments[0]?.tsmib_maintenance_workers;
      return {
        id: r.id,
        requestNumber: r.request_number,
        title: r.title,
        description: r.description,
        category: r.tsmib_maintenance_categories?.name || 'General',
        priority: r.tsmib_maintenance_priority.code,
        status: r.tsmib_maintenance_status.code,
        statusName: r.tsmib_maintenance_status.name,
        estimatedCost: r.estimated_cost ? Number(r.estimated_cost) : null,
        actualCost: r.actual_cost ? Number(r.actual_cost) : null,
        requestedAt: r.requested_at,
        completedAt: r.completed_at,
        apartmentNumber: r.tsmib_apartments.apartment_number,
        buildingName: r.tsmib_apartments.tsmib_buildings.name,
        tenantName: r.tsmib_tenants ? `${r.tsmib_tenants.first_name} ${r.tsmib_tenants.last_name || ''}`.trim() : 'N/A',
        tenantPhone: r.tsmib_tenants?.phone,
        assignedWorker: assignedWorker
          ? {
              id: assignedWorker.id,
              name: assignedWorker.worker_name,
              phone: assignedWorker.worker_phone,
              trade: assignedWorker.worker_type,
            }
          : null,
      };
    });

    res.json({
      requests: formatted,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list maintenance requests' });
  }
});

// 3. CREATE MAINTENANCE REQUEST
router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const data = createMaintenanceRequestSchema.parse(req.body);
    if (tenantScope) {
      if (data.tenantId && data.tenantId !== tenantScope) {
        return res.status(403).json({ error: 'You can only create requests for your tenant profile.' });
      }
      const activeLease = await prisma.tsmib_lease_tenants.findFirst({
        where: {
          tenant_id: tenantScope,
          tsmib_leases: {
            organization_id: orgId,
            apartment_id: data.apartmentId,
            status: 'ACTIVE',
          },
        },
        select: { lease_id: true },
      });
      if (!activeLease) {
        return res.status(403).json({ error: 'Maintenance requests are only available for your active apartment.' });
      }
    }

    const [priority, defaultStatus] = await Promise.all([
      prisma.tsmib_maintenance_priority.findFirst({ where: { code: data.priorityCode } }),
      prisma.tsmib_maintenance_status.findFirst({ where: { code: 'SUBMITTED' } }),
    ]);

    if (!priority || !defaultStatus) {
      return res.status(500).json({ error: 'Maintenance status/priority configuration missing' });
    }

    const requestNumber = generateRequestNumber();

    const request = await prisma.tsmib_maintenance_requests.create({
      data: {
        organization_id: orgId,
        apartment_id: data.apartmentId,
        tenant_id: tenantScope || data.tenantId || null,
        category_id: data.categoryId,
        request_number: requestNumber,
        title: data.title,
        description: data.description,
        priority_id: priority.id,
        status_id: defaultStatus.id,
        estimated_cost: (data.estimatedCost || 0) as any,
        requested_at: new Date(),
      },
    });

    await notifyOrganizationAfterBusinessEvent({
      organizationId: orgId,
      title: 'New maintenance request',
      message: `${data.title} was submitted for apartment ${request.apartment_id}.`,
      type: 'MAINTENANCE_CREATED',
    }, ['OWNER', 'MANAGER', 'ADMIN']);

    res.status(201).json({
      message: 'Maintenance request created successfully',
      request,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create maintenance request' });
  }
});

// 4. ASSIGN WORKER TO MAINTENANCE REQUEST
router.post('/:id/assign', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { workerId, notes } = assignWorkerSchema.parse(req.body);

    const request = await prisma.tsmib_maintenance_requests.findFirst({
      where: { id: req.params.id, organization_id: orgId },
      select: { id: true, tenant_id: true, title: true, request_number: true },
    });
    if (!request) {
      return res.status(404).json({ error: 'Maintenance request not found' });
    }

    const assignedStatus = await prisma.tsmib_maintenance_status.findFirst({
      where: { code: 'ASSIGNED' },
    });

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create or update assignment
      const assignment = await tx.tsmib_maintenance_assignments.create({
        data: {
          maintenance_request_id: request.id,
          worker_id: workerId,
          notes: notes || null,
        },
        include: { tsmib_maintenance_workers: true },
      });

      // 2. Update status to ASSIGNED
      if (assignedStatus) {
        await tx.tsmib_maintenance_requests.update({
          where: { id: request.id },
          data: { status_id: assignedStatus.id, updated_at: new Date() },
        });
      }

      // 3. Log update
      await tx.tsmib_maintenance_updates.create({
        data: {
          maintenance_request_id: request.id,
          status: 'ASSIGNED',
          comment: `Assigned to worker ${assignment.tsmib_maintenance_workers.worker_name} (${assignment.tsmib_maintenance_workers.worker_phone})`,
          created_by: req.user!.userId,
        },
      });

      return assignment;
    });

    if (request.tenant_id) {
      await notifyTenantAfterBusinessEvent(request.tenant_id, {
        organizationId: orgId,
        title: 'Maintenance worker assigned',
        message: `A worker has been assigned to maintenance request ${request.request_number}: ${request.title}.`,
        type: 'MAINTENANCE_ASSIGNED',
      });
    }

    res.json({
      message: 'Worker assigned successfully',
      assignment: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to assign worker' });
  }
});

// 5. UPDATE MAINTENANCE STATUS (IN_PROGRESS, WAITING_FOR_PARTS, COMPLETED, CANCELLED)
router.patch('/:id/status', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { statusCode, comment, actualCost } = updateMaintenanceStatusSchema.parse(req.body);

    const request = await prisma.tsmib_maintenance_requests.findFirst({
      where: { id: req.params.id, organization_id: orgId },
      select: { id: true, tenant_id: true, title: true, request_number: true },
    });
    if (!request) {
      return res.status(404).json({ error: 'Maintenance request not found' });
    }

    const newStatus = await prisma.tsmib_maintenance_status.findFirst({
      where: { code: statusCode },
    });
    if (!newStatus) {
      return res.status(400).json({ error: `Invalid status code: ${statusCode}` });
    }

    const updateData: any = {
      status_id: newStatus.id,
      updated_at: new Date(),
    };

    if (statusCode === 'COMPLETED') {
      updateData.completed_at = new Date();
    }
    if (actualCost !== undefined) {
      updateData.actual_cost = actualCost as any;
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.tsmib_maintenance_requests.update({
        where: { id: request.id },
        data: updateData,
        include: { tsmib_maintenance_status: true },
      });

      if (comment) {
        await tx.tsmib_maintenance_updates.create({
          data: {
            maintenance_request_id: request.id,
            status: statusCode,
            comment,
            created_by: req.user!.userId,
          },
        });
      }

      return updated;
    });

    if (request.tenant_id && statusCode !== 'CANCELLED') {
      await notifyTenantAfterBusinessEvent(request.tenant_id, {
        organizationId: orgId,
        title: statusCode === 'COMPLETED' ? 'Maintenance request completed' : 'Maintenance request updated',
        message: `Maintenance request ${request.request_number} (${request.title}) is now ${statusCode.toLowerCase().replaceAll('_', ' ')}.`,
        type: statusCode === 'COMPLETED' ? 'MAINTENANCE_COMPLETED' : 'MAINTENANCE_STATUS_UPDATED',
      });
    }

    res.json({
      message: `Maintenance request updated to ${statusCode}`,
      request: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update maintenance status' });
  }
});

// 6. CREATE MAINTENANCE WORKER
router.post('/workers', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createWorkerSchema.parse(req.body);

    const worker = await prisma.tsmib_maintenance_workers.create({
      data: {
        worker_name: data.workerName,
        worker_phone: data.workerPhone,
        worker_type: data.workerType,
        email: data.email || null,
        company_name: data.companyName || null,
        is_active: true,
      },
    });

    res.status(201).json({
      message: 'Maintenance worker added successfully',
      worker,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create worker' });
  }
});

export default router;
