// Lease Management Routes
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// Validation schemas
const createLeaseSchema = z.object({
  apartmentId: z.string().uuid(),
  tenantId: z.string().uuid(),
  startDate: z.string(), // YYYY-MM-DD
  endDate: z.string().optional().nullable(), // YYYY-MM-DD
  monthlyRent: z.number().positive(),
  securityDeposit: z.number().nonnegative().default(0),
  rentDueDay: z.number().int().min(1).max(31).default(5),
  lateFee: z.number().nonnegative().default(0),
});

const updateLeaseSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
  monthlyRent: z.number().positive().optional(),
  securityDeposit: z.number().nonnegative().optional(),
  rentDueDay: z.number().int().min(1).max(31).optional(),
  lateFee: z.number().nonnegative().optional(),
  status: z.enum(['ACTIVE', 'EXPIRED', 'TERMINATED']).optional(),
});

// 1. List leases for the organization (search & filter)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { status, apartmentId, tenantId, search } = req.query;
    const where: any = { organization_id: orgId };
    if (status) where.status = String(status);
    if (apartmentId) where.apartment_id = String(apartmentId);
    if (tenantScope || tenantId) {
      where.tsmib_lease_tenants = { some: { tenant_id: tenantScope || String(tenantId) } };
    }
    // Simple text search across lease number and tenant name
    if (search) {
      where.OR = [
        { lease_number: { contains: String(search), mode: 'insensitive' } },
      ];
    }
    const leases = await prisma.tsmib_leases.findMany({
      where,
      include: {
        tsmib_apartments: { include: { tsmib_buildings: true } },
        tsmib_lease_tenants: { include: { tsmib_tenants: true } },
      },
      orderBy: { start_date: 'desc' },
    });
    res.json(leases);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list leases' });
  }
});

// 2. Get single lease details
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const lease = await prisma.tsmib_leases.findFirst({
      where: {
        id: req.params.id,
        organization_id: orgId,
        ...(tenantScope ? { tsmib_lease_tenants: { some: { tenant_id: tenantScope } } } : {}),
      },
      include: {
        tsmib_apartments: { include: { tsmib_buildings: true } },
        tsmib_lease_tenants: { include: { tsmib_tenants: true } },
      },
    });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    res.json(lease);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get lease' });
  }
});

// 3. Create lease (similar to tenants.ts but here as dedicated endpoint)
router.post('/', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createLeaseSchema.parse(req.body);
    // Verify apartment belongs to org
    const apartment = await prisma.tsmib_apartments.findFirst({
      where: { id: data.apartmentId, tsmib_buildings: { tsmib_properties: { organization_id: orgId } } },
    });
    if (!apartment) return res.status(404).json({ error: 'Apartment not found' });
    // Verify tenant belongs to org
    const tenant = await prisma.tsmib_tenants.findFirst({ where: { id: data.tenantId, organization_id: orgId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const occupiedStatus = await prisma.tsmib_apartment_status.findFirst({ where: { code: 'OCCUPIED' } });
    const leaseNumber = `LSE-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const lease = await prisma.$transaction(async (tx) => {
      const newLease = await tx.tsmib_leases.create({
        data: {
          organization_id: orgId,
          lease_number: leaseNumber,
          apartment_id: data.apartmentId,
          start_date: new Date(data.startDate),
          end_date: data.endDate ? new Date(data.endDate) : null,
          monthly_rent: data.monthlyRent as any,
          security_deposit: data.securityDeposit as any,
          rent_due_day: data.rentDueDay,
          late_fee: data.lateFee as any,
          status: 'ACTIVE',
        },
      });
      await tx.tsmib_lease_tenants.create({
        data: { lease_id: newLease.id, tenant_id: data.tenantId, is_primary: true },
      });
      if (occupiedStatus) {
        await tx.tsmib_apartments.update({ where: { id: data.apartmentId }, data: { status_id: occupiedStatus.id } });
      }
      return newLease;
    });
    res.status(201).json(lease);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create lease' });
  }
});

// 4. Update lease (partial)
router.patch('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = updateLeaseSchema.parse(req.body);
    const lease = await prisma.tsmib_leases.findFirst({ where: { id: req.params.id, organization_id: orgId } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    const updated = await prisma.tsmib_leases.update({
      where: { id: lease.id },
      data: {
        ...(data.startDate && { start_date: new Date(data.startDate) }),
        ...(data.endDate !== undefined && { end_date: data.endDate ? new Date(data.endDate) : null }),
        ...(data.monthlyRent && { monthly_rent: data.monthlyRent as any }),
        ...(data.securityDeposit && { security_deposit: data.securityDeposit as any }),
        ...(data.rentDueDay && { rent_due_day: data.rentDueDay }),
        ...(data.lateFee && { late_fee: data.lateFee as any }),
        ...(data.status && { status: data.status }),
      },
    });
    res.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update lease' });
  }
});

// 5. Terminate lease (set status to TERMINATED and free apartment)
router.delete('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const lease = await prisma.tsmib_leases.findFirst({ where: { id: req.params.id, organization_id: orgId } });
    if (!lease) return res.status(404).json({ error: 'Lease not found' });
    // Update status
    await prisma.tsmib_leases.update({ where: { id: lease.id }, data: { status: 'TERMINATED' } });
    // Set apartment status back to VACANT (if such status exists)
    const vacantStatus = await prisma.tsmib_apartment_status.findFirst({ where: { code: 'VACANT' } });
    if (vacantStatus) {
      await prisma.tsmib_apartments.update({ where: { id: lease.apartment_id }, data: { status_id: vacantStatus.id } });
    }
    res.json({ message: 'Lease terminated and apartment set to vacant' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to terminate lease' });
  }
});

export default router;
