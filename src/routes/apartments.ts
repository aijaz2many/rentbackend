import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';
import { deleteStoredObjectsAfterEntityRemoval } from '../services/documentStorage';

const router = Router();

// Validation
const createApartmentSchema = z.object({
  buildingId: z.string().uuid(),
  floorId: z.string().uuid().optional().nullable(),
  apartmentNumber: z.string().min(1, 'Apartment number is required'),
  block: z.string().optional().nullable(),
  apartmentTypeId: z.string().uuid().optional().nullable(),
  bedrooms: z.number().int().optional().nullable(),
  bathrooms: z.number().int().optional().nullable(),
  areaSqft: z.number().positive().optional().nullable(),
  defaultRent: z.number().nonnegative().default(0),
  securityDeposit: z.number().nonnegative().optional().nullable(),
  statusId: z.string().uuid().optional(),
  notes: z.string().optional().nullable(),
});

const bulkCreateApartmentSchema = z.object({
  buildingId: z.string().uuid(),
  floorsCount: z.number().int().positive().max(100),
  apartmentsPerFloor: z.number().int().positive().max(100),
  startingFloor: z.number().int().default(1),
  prefix: z.string().default(''), // e.g. "A-"
  defaultRent: z.number().nonnegative().default(15000),
  securityDeposit: z.number().nonnegative().default(30000),
  apartmentTypeId: z.string().uuid().optional().nullable(),
});

// 1. GET metadata lookups (apartment types & statuses)
router.get('/meta/lookups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [types, statuses] = await Promise.all([
      prisma.tsmib_apartment_type.findMany({ where: { is_active: true } }),
      prisma.tsmib_apartment_status.findMany({ where: { is_active: true } }),
    ]);
    res.json({ types, statuses });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch lookups' });
  }
});

// 2. LIST apartments with search & filters
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { buildingId, floorId, statusId, search } = req.query;

    const where: any = {
      tsmib_buildings: {
        tsmib_properties: {
          organization_id: orgId,
        },
      },
    };

    if (buildingId) where.building_id = String(buildingId);
    if (floorId) where.floor_id = String(floorId);
    if (statusId) where.status_id = String(statusId);
    if (search) {
      where.apartment_number = {
        contains: String(search),
        mode: 'insensitive',
      };
    }

    const apartments = await prisma.tsmib_apartments.findMany({
      where,
      include: {
        tsmib_buildings: {
          select: { id: true, name: true, code: true },
        },
        tsmib_floors: {
          select: { id: true, floor_number: true, name: true },
        },
        tsmib_leases: {
          where: { status: 'ACTIVE' },
          include: {
            tsmib_lease_tenants: {
              where: { is_primary: true },
              include: {
                tsmib_tenants: true,
              },
            },
          },
          take: 1,
        },
      },
      orderBy: [{ building_id: 'asc' }, { apartment_number: 'asc' }],
    });

    // Attach human readable status and primary tenant info
    const [statuses, types] = await Promise.all([
      prisma.tsmib_apartment_status.findMany(),
      prisma.tsmib_apartment_type.findMany(),
    ]);
    const statusMap = new Map(statuses.map((s) => [s.id, s]));
    const typeMap = new Map(types.map((t) => [t.id, t]));

    const response = apartments.map((apt) => {
      const activeLease = apt.tsmib_leases[0];
      const primaryTenant = activeLease?.tsmib_lease_tenants[0]?.tsmib_tenants;
      const statusObj = statusMap.get(apt.status_id);
      const typeObj = apt.apartment_type_id ? typeMap.get(apt.apartment_type_id) : null;

      return {
        id: apt.id,
        buildingId: apt.building_id,
        buildingName: apt.tsmib_buildings.name,
        floorId: apt.floor_id,
        floorNumber: apt.tsmib_floors?.floor_number,
        floorName: apt.tsmib_floors?.name,
        apartmentNumber: apt.apartment_number,
        block: apt.block,
        apartmentTypeId: apt.apartment_type_id,
        apartmentTypeName: typeObj?.name || null,
        apartmentTypeCode: typeObj?.code || null,
        bedrooms: apt.bedrooms,
        bathrooms: apt.bathrooms,
        areaSqft: apt.area_sqft,
        defaultRent: apt.default_rent,
        securityDeposit: apt.security_deposit,
        statusId: apt.status_id,
        status: statusObj?.code || 'UNKNOWN',
        statusName: statusObj?.name || 'Unknown',
        notes: apt.notes,
        currentTenant: primaryTenant
          ? {
              id: primaryTenant.id,
              name: `${primaryTenant.first_name} ${primaryTenant.last_name || ''}`.trim(),
              phone: primaryTenant.phone,
              email: primaryTenant.email,
            }
          : null,
      };
    });

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list apartments' });
  }
});

// 3. CREATE single apartment
router.post('/', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createApartmentSchema.parse(req.body);

    // Verify building belongs to org
    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: data.buildingId,
        tsmib_properties: { organization_id: orgId },
      },
    });
    if (!building) {
      return res.status(404).json({ error: 'Building not found in your organization' });
    }

    // Default status to VACANT if not provided
    let statusId = data.statusId;
    if (!statusId) {
      const vacantStatus = await prisma.tsmib_apartment_status.findFirst({
        where: { code: 'VACANT' },
      });
      if (vacantStatus) statusId = vacantStatus.id;
      else {
        const anyStatus = await prisma.tsmib_apartment_status.findFirst();
        statusId = anyStatus!.id;
      }
    }

    const apartment = await prisma.tsmib_apartments.create({
      data: {
        building_id: data.buildingId,
        floor_id: data.floorId,
        apartment_number: data.apartmentNumber,
        block: data.block,
        apartment_type_id: data.apartmentTypeId,
        bedrooms: data.bedrooms,
        bathrooms: data.bathrooms,
        area_sqft: data.areaSqft as any,
        default_rent: data.defaultRent as any,
        security_deposit: data.securityDeposit as any,
        status_id: statusId!,
        notes: data.notes,
      },
    });

    res.status(201).json(apartment);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create apartment' });
  }
});

// 4. BULK CREATE APARTMENTS (Key Phase 5 requirement for 100+ apartments)
router.post('/bulk-generate', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = bulkCreateApartmentSchema.parse(req.body);

    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: data.buildingId,
        tsmib_properties: { organization_id: orgId },
      },
      include: {
        tsmib_floors: true,
      },
    });

    if (!building) {
      return res.status(404).json({ error: 'Building not found in your organization' });
    }

    const vacantStatus = await prisma.tsmib_apartment_status.findFirst({
      where: { code: 'VACANT' },
    });
    if (!vacantStatus) {
      return res.status(500).json({ error: 'VACANT apartment status not configured' });
    }

    // Ensure floor records exist
    let floors = building.tsmib_floors;
    const neededFloorNumbers = Array.from(
      { length: data.floorsCount },
      (_, i) => data.startingFloor + i
    );

    const existingFloorNumbers = new Set(floors.map((f) => f.floor_number));
    const missingFloors = neededFloorNumbers.filter((num) => !existingFloorNumbers.has(num));

    if (missingFloors.length > 0) {
      await prisma.tsmib_floors.createMany({
        data: missingFloors.map((fn) => ({
          building_id: building.id,
          floor_number: fn,
          name: `Floor ${fn}`,
        })),
      });
      floors = await prisma.tsmib_floors.findMany({
        where: { building_id: building.id },
      });
    }

    const floorMap = new Map(floors.map((f) => [f.floor_number, f.id]));

    // Generate apartments list
    const apartmentsToCreate: any[] = [];
    for (let f = 0; f < data.floorsCount; f++) {
      const floorNum = data.startingFloor + f;
      const floorId = floorMap.get(floorNum);

      for (let unit = 1; unit <= data.apartmentsPerFloor; unit++) {
        const unitFormatted = unit < 10 ? `0${unit}` : `${unit}`;
        const aptNumber = `${data.prefix}${floorNum}${unitFormatted}`;

        apartmentsToCreate.push({
          building_id: building.id,
          floor_id: floorId,
          apartment_number: aptNumber,
          default_rent: data.defaultRent,
          security_deposit: data.securityDeposit,
          apartment_type_id: data.apartmentTypeId || null,
          status_id: vacantStatus.id,
        });
      }
    }

    // Use transaction with skipDuplicates
    const result = await prisma.tsmib_apartments.createMany({
      data: apartmentsToCreate,
      skipDuplicates: true,
    });

    res.status(201).json({
      message: `Bulk creation completed! Created ${result.count} apartments.`,
      requested: apartmentsToCreate.length,
      created: result.count,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to bulk generate apartments' });
  }
});

// 5. GET single apartment details
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const apartment = await prisma.tsmib_apartments.findFirst({
      where: {
        id: req.params.id,
        tsmib_buildings: {
          tsmib_properties: {
            organization_id: orgId,
          },
        },
      },
      include: {
        tsmib_buildings: true,
        tsmib_floors: true,
        tsmib_leases: {
          include: {
            tsmib_lease_tenants: {
              include: { tsmib_tenants: true },
            },
          },
          orderBy: { start_date: 'desc' },
        },
        tsmib_maintenance_requests: {
          orderBy: { created_at: 'desc' },
          take: 5,
        },
      },
    });

    if (!apartment) {
      return res.status(404).json({ error: 'Apartment not found' });
    }

    res.json(apartment);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get apartment' });
  }
});

// 6. PREVIEW BULK GENERATION (Phase 5 Wizard Step 5)
router.post('/bulk-preview', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = bulkCreateApartmentSchema.parse(req.body);

    const previewList: Array<{ floor: number; apartmentNumber: string; defaultRent: number; securityDeposit: number }> = [];

    for (let f = 0; f < data.floorsCount; f++) {
      const floorNum = data.startingFloor + f;
      for (let unit = 1; unit <= data.apartmentsPerFloor; unit++) {
        const unitFormatted = unit < 10 ? `0${unit}` : `${unit}`;
        const aptNumber = `${data.prefix}${floorNum}${unitFormatted}`;
        previewList.push({
          floor: floorNum,
          apartmentNumber: aptNumber,
          defaultRent: data.defaultRent,
          securityDeposit: data.securityDeposit,
        });
      }
    }

    res.json({
      totalUnits: previewList.length,
      floorsCount: data.floorsCount,
      apartmentsPerFloor: data.apartmentsPerFloor,
      units: previewList,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to preview bulk apartments' });
  }
});

// 7. UPDATE apartment
router.put('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createApartmentSchema.partial().parse(req.body);

    const existing = await prisma.tsmib_apartments.findFirst({
      where: {
        id: req.params.id,
        tsmib_buildings: {
          tsmib_properties: { organization_id: orgId },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Apartment not found' });
    }

    const updated = await prisma.tsmib_apartments.update({
      where: { id: req.params.id },
      data: {
        apartment_number: data.apartmentNumber,
        block: data.block,
        floor_id: data.floorId,
        apartment_type_id: data.apartmentTypeId,
        bedrooms: data.bedrooms,
        bathrooms: data.bathrooms,
        area_sqft: data.areaSqft as any,
        default_rent: data.defaultRent as any,
        security_deposit: data.securityDeposit as any,
        status_id: data.statusId,
        notes: data.notes,
        updated_at: new Date(),
      },
    });

    res.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update apartment' });
  }
});

// 8. DELETE apartment (if not under active lease)
router.delete('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;

    const existing = await prisma.tsmib_apartments.findFirst({
      where: {
        id: req.params.id,
        tsmib_buildings: {
          tsmib_properties: { organization_id: orgId },
        },
      },
      include: {
        tsmib_leases: {
          where: { status: 'ACTIVE' },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Apartment not found' });
    }

    if (existing.tsmib_leases.length > 0) {
      return res.status(400).json({
        error: 'Cannot delete an apartment that has an ACTIVE lease. Terminate or transfer lease first.',
      });
    }

    const [leaseIds, maintenanceRequestIds] = await Promise.all([
      prisma.tsmib_leases.findMany({
        where: { apartment_id: req.params.id },
        select: { id: true },
      }),
      prisma.tsmib_maintenance_requests.findMany({
        where: { apartment_id: req.params.id },
        select: { id: true },
      }),
    ]);
    const documentWhere = {
      OR: [
        { apartment_id: req.params.id },
        { lease_id: { in: leaseIds.map((lease) => lease.id) } },
        { maintenance_request_id: { in: maintenanceRequestIds.map((request) => request.id) } },
      ],
    };
    const documentKeys = await prisma.tsmib_documents.findMany({
      where: { ...documentWhere, storage_key: { not: null } },
      select: { storage_key: true },
    });

    // Safely cleanup associated historical rent charges, maintenance or inactive records if any
    await prisma.$transaction(async (tx) => {
      await tx.tsmib_rent_charges.deleteMany({ where: { apartment_id: req.params.id } });
      await tx.tsmib_payments.deleteMany({ where: { apartment_id: req.params.id } });
      await tx.tsmib_documents.deleteMany({ where: documentWhere });
      await tx.tsmib_maintenance_requests.deleteMany({ where: { apartment_id: req.params.id } });
      await tx.tsmib_expenses.deleteMany({ where: { apartment_id: req.params.id } });
      await tx.tsmib_leases.deleteMany({ where: { apartment_id: req.params.id } });
      await tx.tsmib_apartments.delete({ where: { id: req.params.id } });
    });
    await deleteStoredObjectsAfterEntityRemoval(
      documentKeys.flatMap((document) => document.storage_key ? [document.storage_key] : []),
      'apartment'
    );

    res.json({ message: 'Apartment deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2003') {
      return res.status(400).json({
        error: 'Cannot delete apartment because other historical records are referencing it.',
      });
    }
    res.status(500).json({ error: error.message || 'Failed to delete apartment' });
  }
});

export default router;
