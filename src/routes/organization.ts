import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// Validation
const updateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
});

// GET current organization details
router.get('/my', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const org = await prisma.tsmib_organizations.findUnique({
      where: { id: orgId },
      include: {
        _count: {
          select: {
            tsmib_properties: true,
            tsmib_users: true,
            tsmib_tenants: true,
          },
        },
      },
    });

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json(org);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch organization' });
  }
});

// UPDATE current organization (Owner/Admin only)
router.patch('/my', requireAuth, requireRole(['OWNER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = updateOrgSchema.parse(req.body);

    const updated = await prisma.tsmib_organizations.update({
      where: { id: orgId },
      data: {
        ...data,
        updated_at: new Date(),
      },
    });

    res.json({ message: 'Organization updated successfully', organization: updated });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update organization' });
  }
});

export default router;
