import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import {
  cleanupExpiredDocumentUploads,
  copyStoredObject,
  createDownloadUrl,
  createUploadUrl,
  deleteStoredObject,
  getStorageUri,
  inspectStoredObject,
} from '../services/documentStorage';

const router = Router();
const managementRoles = ['OWNER', 'MANAGER', 'ADMIN'];
const documentTypes = ['PROPERTY', 'TENANT', 'LEASE', 'APARTMENT', 'MAINTENANCE_REQUEST'] as const;
const allowedMimeTypes = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const maxFileSize = 25 * 1024 * 1024;

const uploadSchema = z.object({
  entityType: z.enum(documentTypes),
  entityId: z.string().uuid(),
  documentType: z.string().trim().min(1).max(50),
  fileName: z.string().trim().min(1).max(255).refine(
    (name) => !/[\\/\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..',
    'File name must not contain path separators or control characters'
  ),
  mimeType: z.string().trim().max(100),
  fileSize: z.number().int().positive().max(maxFileSize),
});

const listSchema = z.object({
  entityType: z.enum(documentTypes).optional(),
  entityId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
}).refine((query) => Boolean(query.entityType) === Boolean(query.entityId), {
  message: 'entityType and entityId must be provided together',
});

function tenantDocumentAccess(tenantId: string) {
  return {
    OR: [
      { tenant_id: tenantId },
      { tsmib_leases: { tsmib_lease_tenants: { some: { tenant_id: tenantId } } } },
      {
        tsmib_apartments: {
          tsmib_leases: {
            some: {
              status: 'ACTIVE',
              tsmib_lease_tenants: { some: { tenant_id: tenantId } },
            },
          },
        },
      },
      { tsmib_maintenance_requests: { tenant_id: tenantId } },
    ],
  };
}

function isManager(req: AuthenticatedRequest): boolean {
  return req.user!.roles.some((role) => managementRoles.includes(role));
}

function canReadDocuments(req: AuthenticatedRequest): boolean {
  return isManager(req) || req.user!.roles.includes('TENANT');
}

async function validateDocumentTarget(
  organizationId: string,
  entityType: typeof documentTypes[number],
  entityId: string
): Promise<boolean> {
  switch (entityType) {
    case 'PROPERTY':
      return Boolean(await prisma.tsmib_properties.findFirst({
        where: { id: entityId, organization_id: organizationId },
        select: { id: true },
      }));
    case 'TENANT':
      return Boolean(await prisma.tsmib_tenants.findFirst({
        where: { id: entityId, organization_id: organizationId },
        select: { id: true },
      }));
    case 'APARTMENT':
      return Boolean(await prisma.tsmib_apartments.findFirst({
        where: {
          id: entityId,
          tsmib_buildings: { tsmib_properties: { organization_id: organizationId } },
        },
        select: { id: true },
      }));
    case 'LEASE':
      return Boolean(await prisma.tsmib_leases.findFirst({
        where: { id: entityId, organization_id: organizationId },
        select: { id: true },
      }));
    case 'MAINTENANCE_REQUEST':
      return Boolean(await prisma.tsmib_maintenance_requests.findFirst({
        where: { id: entityId, organization_id: organizationId },
        select: { id: true },
      }));
  }
}

function documentTargetFilter(entityType: typeof documentTypes[number], entityId: string) {
  switch (entityType) {
    case 'PROPERTY': return { property_id: entityId };
    case 'TENANT': return { tenant_id: entityId };
    case 'APARTMENT': return { apartment_id: entityId };
    case 'LEASE': return { lease_id: entityId };
    case 'MAINTENANCE_REQUEST': return { maintenance_request_id: entityId };
  }
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const query = listSchema.parse(req.query);
    if (!canReadDocuments(req)) {
      return res.status(403).json({ error: 'You are not allowed to view documents' });
    }
    const where: Record<string, any> = { organization_id: req.user!.organizationId };

    if (!isManager(req)) {
      if (!req.user!.tenantId) return res.status(403).json({ error: 'Tenant profile is not linked to this account' });
      Object.assign(where, tenantDocumentAccess(req.user!.tenantId));
    }
    if (query.entityType && query.entityId) {
      Object.assign(where, documentTargetFilter(query.entityType, query.entityId));
    }

    const [documents, total] = await Promise.all([
      prisma.tsmib_documents.findMany({
        where,
        select: {
          id: true,
          property_id: true,
          tenant_id: true,
          lease_id: true,
          apartment_id: true,
          maintenance_request_id: true,
          document_type: true,
          file_name: true,
          file_url: true,
          mime_type: true,
          file_size: true,
          upload_status: true,
          uploaded_by: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.tsmib_documents.count({ where }),
    ]);
    return res.json({
      documents: documents.map((document) => ({
        id: document.id,
        propertyId: document.property_id,
        tenantId: document.tenant_id,
        leaseId: document.lease_id,
        apartmentId: document.apartment_id,
        maintenanceRequestId: document.maintenance_request_id,
        documentType: document.document_type,
        fileName: document.file_name,
        storageUrl: document.file_url,
        mimeType: document.mime_type,
        fileSize: document.file_size?.toString() || null,
        uploadStatus: document.upload_status,
        uploadedBy: document.uploaded_by,
        createdAt: document.created_at,
      })),
      pagination: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to list documents' });
  }
});

router.post('/upload-url', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = uploadSchema.parse(req.body);
    if (!allowedMimeTypes.has(data.mimeType)) {
      return res.status(400).json({ error: 'File type is not supported' });
    }

    const manager = isManager(req);
    if (!manager) {
      if (!req.user!.roles.includes('TENANT') || !req.user!.tenantId) {
        return res.status(403).json({ error: 'You are not allowed to upload documents' });
      }
      if (data.entityType !== 'TENANT' || data.entityId !== req.user!.tenantId) {
        return res.status(403).json({ error: 'Tenant accounts may upload only to their own tenant profile' });
      }
    }

    const organizationId = req.user!.organizationId;
    if (!await validateDocumentTarget(organizationId, data.entityType, data.entityId)) {
      return res.status(404).json({ error: 'Document target not found in your organization' });
    }

    const storageKey = `${organizationId}/pending/${randomUUID()}`;
    const uploadUrl = await createUploadUrl(storageKey, data.mimeType, data.fileSize);
    const storageUri = getStorageUri(storageKey);
    const relation = documentTargetFilter(data.entityType, data.entityId);
    const document = await prisma.tsmib_documents.create({
      data: {
        organization_id: organizationId,
        document_type: data.documentType,
        file_name: data.fileName,
        file_url: storageUri,
        storage_key: storageKey,
        upload_status: 'PENDING',
        mime_type: data.mimeType,
        file_size: BigInt(data.fileSize),
        uploaded_by: req.user!.userId,
        ...relation,
      },
      select: { id: true },
    });
    return res.status(201).json({
      documentId: document.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': data.mimeType },
      expiresInSeconds: 900,
      maxFileSizeBytes: maxFileSize,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors[0].message });
    return res.status(500).json({ error: error.message || 'Failed to create document upload URL' });
  }
});

router.post('/:id/complete', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const documentWhere: Record<string, any> = {
      id: req.params.id,
      organization_id: req.user!.organizationId,
    };
    if (!canReadDocuments(req)) {
      return res.status(403).json({ error: 'You are not allowed to complete document uploads' });
    }
    if (!isManager(req)) {
      if (!req.user!.tenantId) return res.status(403).json({ error: 'Tenant profile is not linked to this account' });
      Object.assign(documentWhere, tenantDocumentAccess(req.user!.tenantId));
      documentWhere.uploaded_by = req.user!.userId;
    }

    const document = await prisma.tsmib_documents.findFirst({ where: documentWhere });
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (document.upload_status === 'COMPLETE') return res.json({ message: 'Document upload is already complete' });
    if (!document.storage_key || !document.file_size || !document.mime_type) {
      return res.status(400).json({ error: 'Document upload metadata is incomplete' });
    }

    const storedObject = await inspectStoredObject(document.storage_key);
    if (storedObject.ContentLength !== Number(document.file_size) || storedObject.ContentType !== document.mime_type) {
      await deleteStoredObject(document.storage_key);
      return res.status(400).json({ error: 'Uploaded file size or content type does not match the requested upload' });
    }

    const permanentKey = `${document.organization_id}/documents/${randomUUID()}`;
    await copyStoredObject(document.storage_key, permanentKey);
    let finalized;
    try {
      finalized = await prisma.tsmib_documents.updateMany({
        where: {
          id: document.id,
          upload_status: 'PENDING',
          storage_key: document.storage_key,
        },
        data: {
          storage_key: permanentKey,
          file_url: getStorageUri(permanentKey),
          upload_status: 'COMPLETE',
        },
      });
    } catch (error) {
      try {
        await deleteStoredObject(permanentKey);
      } catch (cleanupError) {
        console.error(`Failed to clean permanent object after document ${document.id} could not be finalized:`, cleanupError);
      }
      throw error;
    }
    if (finalized.count === 0) {
      try {
        await deleteStoredObject(permanentKey);
      } catch (error) {
        console.error(`Failed to clean duplicate permanent object for document ${document.id}:`, error);
      }
      return res.status(409).json({ error: 'Document upload was already finalized' });
    }
    try {
      await deleteStoredObject(document.storage_key);
    } catch (error) {
      console.error(`Failed to remove staging object for document ${document.id}:`, error);
    }
    return res.json({ message: 'Document upload completed' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to complete document upload' });
  }
});

router.get('/:id/download-url', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const documentWhere: Record<string, any> = {
      id: req.params.id,
      organization_id: req.user!.organizationId,
      upload_status: 'COMPLETE',
    };
    if (!canReadDocuments(req)) {
      return res.status(403).json({ error: 'You are not allowed to download documents' });
    }
    if (!isManager(req)) {
      if (!req.user!.tenantId) return res.status(403).json({ error: 'Tenant profile is not linked to this account' });
      Object.assign(documentWhere, tenantDocumentAccess(req.user!.tenantId));
    }

    const document = await prisma.tsmib_documents.findFirst({ where: documentWhere });
    if (!document) return res.status(404).json({ error: 'Document not found' });
    const downloadUrl = document.storage_key
      ? await createDownloadUrl(document.storage_key, document.file_name)
      : document.file_url;
    return res.json({ downloadUrl, expiresInSeconds: document.storage_key ? 300 : null });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to create document download URL' });
  }
});

router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const manager = isManager(req);
    const documentWhere: Record<string, any> = {
      id: req.params.id,
      organization_id: req.user!.organizationId,
    };
    if (!manager) {
      if (!req.user!.roles.includes('TENANT') || !req.user!.tenantId) {
        return res.status(403).json({ error: 'You are not allowed to delete documents' });
      }
      Object.assign(documentWhere, {
        tenant_id: req.user!.tenantId,
        uploaded_by: req.user!.userId,
      });
    }

    const document = await prisma.tsmib_documents.findFirst({ where: documentWhere });
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (document.storage_key) await deleteStoredObject(document.storage_key);
    await prisma.tsmib_documents.delete({ where: { id: document.id } });
    return res.json({ message: 'Document deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to delete document' });
  }
});

export default router;
