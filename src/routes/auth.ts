import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import { JWTPayload } from '../types/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_property_management_2026_dev';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Validation schemas
const registerSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  organizationName: z.string().min(2, 'Organization name is required').optional(),
  organizationCode: z.string().min(2, 'Organization code is required').optional(),
});

const loginSchema = z.object({
  emailOrPhone: z.string().min(1, 'Email or Phone is required'),
  password: z.string().min(1, 'Password is required'),
});

// Helper to generate JWT
function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as any);
}

async function resolveTenantId(user: { organization_id: string; email: string | null; phone: string | null }, roles: string[]) {
  if (!roles.includes('TENANT')) return undefined;
  const tenantContact = user.email ? { email: user.email } : user.phone ? { phone: user.phone } : null;
  if (!tenantContact) return undefined;

  const tenants = await prisma.tsmib_tenants.findMany({
    where: { organization_id: user.organization_id, ...tenantContact },
    select: { id: true },
    take: 2,
  });
  return tenants.length === 1 ? tenants[0].id : undefined;
}

// 1. REGISTER (Initial Owner & Organization)
router.post('/register', async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    // Check existing email
    const existing = await prisma.tsmib_users.findFirst({
      where: { email: data.email },
    });
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Fetch or create OWNER role
    let ownerRole = await prisma.tsmib_roles.findFirst({
      where: { role: 'OWNER' },
    });
    if (!ownerRole) {
      ownerRole = await prisma.tsmib_roles.create({
        data: { role: 'OWNER' },
      });
    }

    // Check organization or create new one
    let organizationId: string;
    if (data.organizationName) {
      const orgCode = (data.organizationCode || data.organizationName.substring(0, 4).toUpperCase()).replace(/\s+/g, '');
      const org = await prisma.tsmib_organizations.create({
        data: {
          name: data.organizationName,
          code: orgCode + Math.floor(100 + Math.random() * 900),
          email: data.email,
          phone: data.phone,
          status: 'ACTIVE',
        },
      });
      organizationId = org.id;
    } else {
      // Connect to default active organization if not provided
      const defaultOrg = await prisma.tsmib_organizations.findFirst({
        where: { status: 'ACTIVE' },
      });
      if (!defaultOrg) {
        return res.status(400).json({ error: 'Organization name is required to register.' });
      }
      organizationId = defaultOrg.id;
    }

    // Create user in database
    const user = await prisma.tsmib_users.create({
      data: {
        organization_id: organizationId,
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        phone: data.phone,
        password_hash: hashedPassword,
        status: 'ACTIVE',
      },
    });

    // Assign OWNER role
    await prisma.tsmib_user_roles.create({
      data: {
        user_id: user.id,
        role_id: ownerRole.id,
      },
    });

    const token = generateToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      roles: ['OWNER'],
    });

    return res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        organizationId: user.organization_id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        roles: ['OWNER'],
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

// 2. LOGIN (Email or Phone)
router.post('/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = loginSchema.parse(req.body);

    const user = await prisma.tsmib_users.findFirst({
      where: {
        OR: [{ email: emailOrPhone }, { phone: emailOrPhone }],
      },
      include: {
        tsmib_user_roles: {
          include: {
            tsmib_roles: true,
          },
        },
        tsmib_organizations: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email/phone or password' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'Account password not set. Please contact administrator.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email/phone or password' });
    }

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Your account is currently inactive.' });
    }

    // Update last login
    await prisma.tsmib_users.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });

    const userRoles = user.tsmib_user_roles.map((ur) => ur.tsmib_roles.role);
    const tenantId = await resolveTenantId(user, userRoles);

    const token = generateToken({
      userId: user.id,
      organizationId: user.organization_id,
      email: user.email,
      roles: userRoles,
      ...(tenantId ? { tenantId } : {}),
    });

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        organizationId: user.organization_id,
        organizationName: user.tsmib_organizations?.name,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        roles: userRoles,
        ...(tenantId ? { tenantId } : {}),
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    return res.status(500).json({ error: error.message || 'Login failed' });
  }
});

// 3. ME (Get current authenticated user profile)
router.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await prisma.tsmib_users.findUnique({
      where: { id: req.user.userId },
      include: {
        tsmib_user_roles: {
          include: {
            tsmib_roles: true,
          },
        },
        tsmib_organizations: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const roles = user.tsmib_user_roles.map((ur) => ur.tsmib_roles.role);

    return res.json({
      id: user.id,
      organizationId: user.organization_id,
      organizationName: user.tsmib_organizations.name,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      phone: user.phone,
      roles,
      ...(req.user!.tenantId ? { tenantId: req.user!.tenantId } : {}),
      status: user.status,
      profileImageUrl: user.profile_image_url,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to fetch user' });
  }
});

// 4. LOGOUT
router.post('/logout', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  // Stateless JWT: mobile client removes token from storage
  res.json({ message: 'Logged out successfully' });
});

// 5. CHANGE / RESET PASSWORD
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

router.post('/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const user = await prisma.tsmib_users.findUnique({
      where: { id: req.user!.userId },
    });

    if (!user || !user.password_hash) {
      return res.status(404).json({ error: 'User not found or password not set' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Incorrect current password' });
    }

    const newHashed = await bcrypt.hash(newPassword, 10);
    await prisma.tsmib_users.update({
      where: { id: user.id },
      data: { password_hash: newHashed, updated_at: new Date() },
    });

    res.json({ message: 'Password updated successfully' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to change password' });
  }
});

// 6. ACCOUNT ACTIVATION / DEACTIVATION (Owner / Admin only)
router.patch('/users/:userId/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const isOwnerOrAdmin = req.user!.roles.some((r) => ['OWNER', 'ADMIN'].includes(r));
    if (!isOwnerOrAdmin) {
      return res.status(403).json({ error: 'Forbidden. Owner or Admin required.' });
    }

    const { status } = req.body;
    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be ACTIVE, INACTIVE, or SUSPENDED.' });
    }

    const user = await prisma.tsmib_users.findFirst({
      where: {
        id: req.params.userId,
        organization_id: req.user!.organizationId,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found in your organization' });
    }

    const updated = await prisma.tsmib_users.update({
      where: { id: user.id },
      data: { status, updated_at: new Date() },
    });

    res.json({ message: `User status updated to ${status}`, user: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update user status' });
  }
});

export default router;
