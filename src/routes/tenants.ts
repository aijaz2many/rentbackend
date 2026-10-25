import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';
import { deleteStoredObjectsAfterEntityRemoval } from '../services/documentStorage';

const router = Router();

// Validation
const createTenantSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(5, 'Phone number is required'),
  dateOfBirth: z.string().optional().nullable(),
  emergencyContactName: z.string().optional().nullable(),
  emergencyContactPhone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  governmentIdNumber: z.string().optional().nullable(),
  governmentIdTypeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

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

// ================= TENANTS =================

// Validation for tenant updates (partial)
const updateTenantSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(5).optional(),
  dateOfBirth: z.string().optional().nullable(),
  emergencyContactName: z.string().optional().nullable(),
  emergencyContactPhone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  governmentIdNumber: z.string().optional().nullable(),
  governmentIdTypeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

// Meta: Lookups for Government ID types
router.get('/meta/id-types', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const idTypes = await prisma.tsmib_government_id_type.findMany({
      where: { is_active: true },
      orderBy: { name: 'asc' },
    });
    res.json(idTypes);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list government ID types' });
  }
});

// 1. List tenants with search
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { search, status } = req.query;

    const where: any = {
      organization_id: orgId,
      ...(tenantScope ? { id: tenantScope } : {}),
    };
    if (status) where.status = String(status);
    if (search) {
      where.OR = [
        { first_name: { contains: String(search), mode: 'insensitive' } },
        { last_name: { contains: String(search), mode: 'insensitive' } },
        { phone: { contains: String(search) } },
        { email: { contains: String(search), mode: 'insensitive' } },
      ];
    }

    const tenants = await prisma.tsmib_tenants.findMany({
      where,
      include: {
        tsmib_government_id_type: true,
        tsmib_lease_tenants: {
          include: {
            tsmib_leases: {
              include: {
                tsmib_apartments: {
                  include: { tsmib_buildings: true },
                },
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    const formatted = tenants.map((t) => {
      const activeLeaseTenant = t.tsmib_lease_tenants.find(
        (lt: any) => lt.tsmib_leases && lt.tsmib_leases.status === 'ACTIVE'
      );
      const activeApt = activeLeaseTenant?.tsmib_leases?.tsmib_apartments;

      return {
        id: t.id,
        firstName: t.first_name,
        lastName: t.last_name,
        fullName: `${t.first_name} ${t.last_name || ''}`.trim(),
        email: t.email,
        phone: t.phone,
        dateOfBirth: t.date_of_birth ? t.date_of_birth.toISOString().split('T')[0] : null,
        emergencyContactName: t.emergency_contact_name,
        emergencyContactPhone: t.emergency_contact_phone,
        address: t.address,
        governmentIdTypeId: t.government_id_type_id,
        governmentIdType: t.tsmib_government_id_type?.name || null,
        governmentIdTypeCode: t.tsmib_government_id_type?.code || null,
        governmentIdNumber: t.government_id_number,
        notes: t.notes,
        status: t.status,
        currentApartment: activeApt
          ? {
              id: activeApt.id,
              apartmentNumber: activeApt.apartment_number,
              buildingName: activeApt.tsmib_buildings.name,
              monthlyRent: activeLeaseTenant?.tsmib_leases.monthly_rent,
            }
          : null,
      };
    });

    res.json(formatted);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list tenants' });
  }
});

// Get single tenant details
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const t = await prisma.tsmib_tenants.findFirst({
      where: { id: tenantScope || req.params.id, organization_id: orgId },
      include: {
        tsmib_government_id_type: true,
        tsmib_lease_tenants: {
          include: {
            tsmib_leases: {
              include: {
                tsmib_apartments: {
                  include: { tsmib_buildings: true },
                },
              },
            },
          },
        },
      },
    });

    if (!t) return res.status(404).json({ error: 'Tenant not found' });

    const activeLeaseTenant = t.tsmib_lease_tenants.find(
      (lt: any) => lt.tsmib_leases && lt.tsmib_leases.status === 'ACTIVE'
    );
    const activeApt = activeLeaseTenant?.tsmib_leases?.tsmib_apartments;

    res.json({
      id: t.id,
      firstName: t.first_name,
      lastName: t.last_name,
      fullName: `${t.first_name} ${t.last_name || ''}`.trim(),
      email: t.email,
      phone: t.phone,
      dateOfBirth: t.date_of_birth ? t.date_of_birth.toISOString().split('T')[0] : null,
      emergencyContactName: t.emergency_contact_name,
      emergencyContactPhone: t.emergency_contact_phone,
      address: t.address,
      governmentIdTypeId: t.government_id_type_id,
      governmentIdType: t.tsmib_government_id_type?.name || null,
      governmentIdTypeCode: t.tsmib_government_id_type?.code || null,
      governmentIdNumber: t.government_id_number,
      notes: t.notes,
      status: t.status,
      currentApartment: activeApt
        ? {
            id: activeApt.id,
            apartmentNumber: activeApt.apartment_number,
            buildingName: activeApt.tsmib_buildings.name,
            monthlyRent: activeLeaseTenant?.tsmib_leases.monthly_rent,
          }
        : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch tenant' });
  }
});

// 2. Create tenant
router.post('/', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createTenantSchema.parse(req.body);

    const tenant = await prisma.tsmib_tenants.create({
      data: {
        organization_id: orgId,
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        phone: data.phone,
        date_of_birth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        emergency_contact_name: data.emergencyContactName,
        emergency_contact_phone: data.emergencyContactPhone,
        address: data.address,
        government_id_number: data.governmentIdNumber,
        government_id_type_id: data.governmentIdTypeId,
        notes: data.notes,
        status: (req.body.status && ['ACTIVE', 'INACTIVE'].includes(req.body.status)) ? req.body.status : 'ACTIVE',
      },
    });

    res.status(201).json(tenant);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create tenant' });
  }
});

// ================= LEASES =================

// 4. Update tenant (partial)
router.patch('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = updateTenantSchema.parse(req.body);
    const tenant = await prisma.tsmib_tenants.findFirst({ where: { id: req.params.id, organization_id: orgId } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const updated = await prisma.tsmib_tenants.update({
      where: { id: tenant.id },
      data: {
        ...(data.firstName && { first_name: data.firstName }),
        ...(data.lastName !== undefined && { last_name: data.lastName }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.phone && { phone: data.phone }),
        ...(data.dateOfBirth !== undefined && { date_of_birth: data.dateOfBirth ? new Date(data.dateOfBirth) : null }),
        ...(data.emergencyContactName !== undefined && { emergency_contact_name: data.emergencyContactName }),
        ...(data.emergencyContactPhone !== undefined && { emergency_contact_phone: data.emergencyContactPhone }),
        ...(data.address !== undefined && { address: data.address }),
        ...(data.governmentIdNumber !== undefined && { government_id_number: data.governmentIdNumber }),
        ...(data.governmentIdTypeId !== undefined && { government_id_type_id: data.governmentIdTypeId }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.status && { status: data.status }),
      },
    });
    res.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update tenant' });
  }
});

// 5. Delete tenant (only if no active lease)
router.delete('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenant = await prisma.tsmib_tenants.findFirst({
      where: { id: req.params.id, organization_id: orgId },
      include: { tsmib_lease_tenants: { where: { tsmib_leases: { status: 'ACTIVE' } } } },
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenant.tsmib_lease_tenants.length > 0) {
      return res.status(400).json({ error: 'Cannot delete tenant with an ACTIVE lease. Terminate lease first.' });
    }
    const maintenanceRequestIds = await prisma.tsmib_maintenance_requests.findMany({
      where: { tenant_id: tenant.id },
      select: { id: true },
    });
    const documentWhere = {
      OR: [
        { tenant_id: tenant.id },
        { maintenance_request_id: { in: maintenanceRequestIds.map((request) => request.id) } },
      ],
    };
    const documentKeys = await prisma.tsmib_documents.findMany({
      where: { ...documentWhere, storage_key: { not: null } },
      select: { storage_key: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.tsmib_payments.deleteMany({ where: { tenant_id: tenant.id } });
      await tx.tsmib_lease_tenants.deleteMany({ where: { tenant_id: tenant.id } });
      await tx.tsmib_documents.deleteMany({ where: documentWhere });
      await tx.tsmib_maintenance_requests.deleteMany({ where: { tenant_id: tenant.id } });
      await tx.tsmib_tenants.delete({ where: { id: tenant.id } });
    });
    await deleteStoredObjectsAfterEntityRemoval(
      documentKeys.flatMap((document) => document.storage_key ? [document.storage_key] : []),
      'tenant'
    );
    res.json({ message: 'Tenant deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2003') {
      return res.status(400).json({ error: 'Cannot delete tenant because other records reference this tenant.' });
    }
    res.status(500).json({ error: error.message || 'Failed to delete tenant' });
  }
});

// 3. Create Lease (Assigns Tenant to Apartment and updates Apartment status to OCCUPIED)
router.post('/leases', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createLeaseSchema.parse(req.body);

    // Verify apartment belongs to org
    const apartment = await prisma.tsmib_apartments.findFirst({
      where: {
        id: data.apartmentId,
        tsmib_buildings: { tsmib_properties: { organization_id: orgId } },
      },
    });
    if (!apartment) {
      return res.status(404).json({ error: 'Apartment not found' });
    }

    // Verify tenant belongs to org
    const tenant = await prisma.tsmib_tenants.findFirst({
      where: { id: data.tenantId, organization_id: orgId },
    });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Get OCCUPIED status ID
    const occupiedStatus = await prisma.tsmib_apartment_status.findFirst({
      where: { code: 'OCCUPIED' },
    });

    const leaseNumber = `LSE-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    // Run transaction
    const lease = await prisma.$transaction(async (tx) => {
      // Create lease
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

      // Link tenant to lease
      await tx.tsmib_lease_tenants.create({
        data: {
          lease_id: newLease.id,
          tenant_id: data.tenantId,
          is_primary: true,
        },
      });

      // Update apartment status to OCCUPIED
      if (occupiedStatus) {
        await tx.tsmib_apartments.update({
          where: { id: data.apartmentId },
          data: { status_id: occupiedStatus.id },
        });
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

export default router;
