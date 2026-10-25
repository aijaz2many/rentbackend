import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWTPayload } from '../types/auth';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_property_management_2026_dev';

export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Bearer token required.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload;
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }

    const hasRole = req.user.roles.some((role) => allowedRoles.includes(role));
    if (!hasRole) {
      return res.status(403).json({
        error: `Forbidden. Requires one of the following roles: ${allowedRoles.join(', ')}`,
      });
    }

    next();
  };
}

// Reusable context helpers specified in Phase 3
export function getCurrentUser(req: AuthenticatedRequest): JWTPayload | undefined {
  return req.user;
}

export function getOrganizationId(req: AuthenticatedRequest): string {
  if (!req.user?.organizationId) {
    throw new Error('No authenticated organization context found');
  }
  return req.user.organizationId;
}

export function getTenantScope(req: AuthenticatedRequest, res: Response): string | undefined | null {
  if (!req.user?.roles.includes('TENANT')) return undefined;
  if (!req.user.tenantId) {
    res.status(403).json({ error: 'Tenant account is not linked to a tenant profile.' });
    return null;
  }
  return req.user.tenantId;
}
