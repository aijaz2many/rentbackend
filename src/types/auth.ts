export interface AuthUser {
  id: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string | null;
  roles: string[];
}

export interface JWTPayload {
  userId: string;
  organizationId: string;
  tenantId?: string;
  email: string | null;
  roles: string[];
}
