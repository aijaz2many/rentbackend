import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// Validation schemas
const createPropertySchema = z.object({
  name: z.string().min(1, 'Property name is required'),
  code: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  country: z.string().default('India'),
  postalCode: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

const createBuildingSchema = z.object({
  name: z.string().min(1, 'Building name is required'),
  code: z.string().optional().nullable(),
  numberOfFloors: z.number().int().positive().optional().nullable(),
  description: z.string().optional().nullable(),
});

// ================= PROPERTIES =================

// 1. List all properties for organization
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const properties = await prisma.tsmib_properties.findMany({
      where: { organization_id: orgId },
      include: {
        tsmib_buildings: {
          include: {
            tsmib_floors: {
              orderBy: { floor_number: 'asc' },
            },
            _count: {
              select: {
                tsmib_apartments: true,
                tsmib_floors: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json(properties);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list properties' });
  }
});

// 2. Create property
router.post('/', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createPropertySchema.parse(req.body);

    const property = await prisma.tsmib_properties.create({
      data: {
        organization_id: orgId,
        name: data.name,
        code: data.code,
        address_line1: data.addressLine1,
        address_line2: data.addressLine2,
        city: data.city,
        state: data.state,
        country: data.country,
        postal_code: data.postalCode,
        description: data.description,
        status: 'ACTIVE',
      },
    });

    res.status(201).json(property);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create property' });
  }
});

// 3. Get single property with its buildings
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const property = await prisma.tsmib_properties.findFirst({
      where: {
        id: req.params.id,
        organization_id: orgId,
      },
      include: {
        tsmib_buildings: {
          include: {
            tsmib_floors: {
              orderBy: { floor_number: 'asc' },
            },
            _count: {
              select: { tsmib_apartments: true },
            },
          },
        },
      },
    });

    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }

    res.json(property);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get property' });
  }
});

// ================= BUILDINGS =================

// 4. Create building inside a property
router.post('/:propertyId/buildings', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { propertyId } = req.params;
    const data = createBuildingSchema.parse(req.body);

    // Verify property belongs to org
    const property = await prisma.tsmib_properties.findFirst({
      where: { id: propertyId, organization_id: orgId },
    });
    if (!property) {
      return res.status(404).json({ error: 'Property not found in this organization' });
    }

    const building = await prisma.tsmib_buildings.create({
      data: {
        property_id: propertyId,
        name: data.name,
        code: data.code,
        number_of_floors: data.numberOfFloors,
        description: data.description,
        status: 'ACTIVE',
      },
    });

    // Optionally auto-create floors if numberOfFloors is given
    if (data.numberOfFloors && data.numberOfFloors > 0) {
      const floorsData = [];
      for (let i = 0; i <= data.numberOfFloors; i++) {
        floorsData.push({
          building_id: building.id,
          floor_number: i,
          name: i === 0 ? 'Ground Floor' : `Floor ${i}`,
        });
      }
      await prisma.tsmib_floors.createMany({
        data: floorsData,
      });
    }

    const fullBuilding = await prisma.tsmib_buildings.findUnique({
      where: { id: building.id },
      include: { tsmib_floors: true },
    });

    res.status(201).json(fullBuilding);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to create building' });
  }
});

// 5. Get building details (floors + apartments summary)
router.get('/buildings/:buildingId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { buildingId } = req.params;

    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: buildingId,
        tsmib_properties: {
          organization_id: orgId,
        },
      },
      include: {
        tsmib_properties: true,
        tsmib_floors: {
          orderBy: { floor_number: 'asc' },
        },
        tsmib_apartments: {
          include: {
            tsmib_floors: true,
          },
          orderBy: { apartment_number: 'asc' },
        },
      },
    });

    if (!building) {
      return res.status(404).json({ error: 'Building not found' });
    }

    res.json(building);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch building' });
  }
});

// 6. Update property
router.put('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createPropertySchema.partial().parse(req.body);

    const existing = await prisma.tsmib_properties.findFirst({
      where: { id: req.params.id, organization_id: orgId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Property not found' });
    }

    const updated = await prisma.tsmib_properties.update({
      where: { id: req.params.id },
      data: {
        name: data.name,
        code: data.code,
        address_line1: data.addressLine1,
        address_line2: data.addressLine2,
        city: data.city,
        state: data.state,
        country: data.country,
        postal_code: data.postalCode,
        description: data.description,
        updated_at: new Date(),
      },
    });

    res.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update property' });
  }
});

// Delete a property only after all child records have been removed.
router.delete('/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const property = await prisma.tsmib_properties.findFirst({
      where: { id: req.params.id, organization_id: orgId },
    });
    if (!property) return res.status(404).json({ error: 'Property not found' });

    const [buildingCount, documentCount, expenseCount] = await Promise.all([
      prisma.tsmib_buildings.count({ where: { property_id: property.id } }),
      prisma.tsmib_documents.count({ where: { property_id: property.id } }),
      prisma.tsmib_expenses.count({ where: { property_id: property.id } }),
    ]);
    if (buildingCount || documentCount || expenseCount) {
      return res.status(409).json({
        error: 'Cannot delete a property while it has buildings, documents, or expenses. Remove those records first.',
      });
    }

    await prisma.tsmib_properties.delete({ where: { id: property.id } });
    res.json({ message: 'Property deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2003') {
      return res.status(409).json({ error: 'Cannot delete property because other records reference it.' });
    }
    res.status(500).json({ error: error.message || 'Failed to delete property' });
  }
});

// 7. Update building
router.put('/buildings/:buildingId', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = createBuildingSchema.partial().parse(req.body);

    const existing = await prisma.tsmib_buildings.findFirst({
      where: {
        id: req.params.buildingId,
        tsmib_properties: { organization_id: orgId },
      },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Building not found' });
    }

    const updated = await prisma.tsmib_buildings.update({
      where: { id: req.params.buildingId },
      data: {
        name: data.name,
        code: data.code,
        number_of_floors: data.numberOfFloors,
        description: data.description,
        updated_at: new Date(),
      },
    });

    res.json(updated);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update building' });
  }
});

// Delete a building only when it has no apartments or expenses. Floors are cascaded by the database.
router.delete('/buildings/:buildingId', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: req.params.buildingId,
        tsmib_properties: { organization_id: orgId },
      },
    });
    if (!building) return res.status(404).json({ error: 'Building not found' });

    const [apartmentCount, expenseCount] = await Promise.all([
      prisma.tsmib_apartments.count({ where: { building_id: building.id } }),
      prisma.tsmib_expenses.count({ where: { building_id: building.id } }),
    ]);
    if (apartmentCount || expenseCount) {
      return res.status(409).json({
        error: 'Cannot delete a building while it has apartments or expenses. Remove those records first.',
      });
    }

    await prisma.tsmib_buildings.delete({ where: { id: building.id } });
    res.json({ message: 'Building deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2003') {
      return res.status(409).json({ error: 'Cannot delete building because other records reference it.' });
    }
    res.status(500).json({ error: error.message || 'Failed to delete building' });
  }
});

// ================= FLOORS =================

// 8. List all floors for organization (or optionally filtered by buildingId query param)
router.get('/floors', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { buildingId } = req.query;

    const floors = await prisma.tsmib_floors.findMany({
      where: {
        tsmib_buildings: {
          tsmib_properties: {
            organization_id: orgId,
          },
          ...(buildingId ? { id: String(buildingId) } : {}),
        },
      },
      include: {
        tsmib_buildings: {
          select: { id: true, name: true, property_id: true },
        },
      },
      orderBy: [{ building_id: 'asc' }, { floor_number: 'asc' }],
    });

    const mapped = floors.map((f) => ({
      id: f.id,
      buildingId: f.building_id,
      floorNumber: f.floor_number,
      name: f.name || `Floor ${f.floor_number === 0 ? 'G' : f.floor_number}`,
      buildingName: f.tsmib_buildings?.name,
    }));

    res.json(mapped);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch floors' });
  }
});

// 9. List floors for a specific building
router.get('/buildings/:buildingId/floors', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { buildingId } = req.params;

    const building = await prisma.tsmib_buildings.findFirst({
      where: {
        id: buildingId,
        tsmib_properties: {
          organization_id: orgId,
        },
      },
    });

    if (!building) {
      return res.status(404).json({ error: 'Building not found' });
    }

    const floors = await prisma.tsmib_floors.findMany({
      where: { building_id: buildingId },
      orderBy: { floor_number: 'asc' },
    });

    const mapped = floors.map((f) => ({
      id: f.id,
      buildingId: f.building_id,
      floorNumber: f.floor_number,
      name: f.name || `Floor ${f.floor_number === 0 ? 'G' : f.floor_number}`,
    }));

    res.json(mapped);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch building floors' });
  }
});

export default router;
