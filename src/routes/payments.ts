import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';
import { PaymentService } from '../services/paymentService';

const router = Router();

// Validation Schemas
const recordPaymentSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
  apartmentId: z.string().uuid('Invalid apartment ID'),
  amount: z.number().positive('Payment amount must be greater than 0'),
  paymentMethodCode: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE', 'OTHER']).default('UPI'),
  paymentDate: z.string().optional(),
  transactionId: z.string().optional().nullable(),
  rentChargeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
  autoAllocate: z.boolean().optional().default(true),
});

// 1. GET ALL PAYMENT METHODS
router.get('/methods', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const methods = await prisma.tsmib_payment_method.findMany({
      orderBy: { name: 'asc' },
    });
    res.json(methods);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch payment methods' });
  }
});

// 2. RECORD A NEW PAYMENT (Phase 9: Intelligent Allocation & Receipts)
router.post('/', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = recordPaymentSchema.parse(req.body);

    const result = await PaymentService.recordPayment({
      organizationId: orgId,
      ...data,
    });

    res.status(201).json({
      message: 'Payment recorded successfully',
      ...result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to record payment' });
  }
});

// 3. GET PAYMENT HISTORY (Filtered & Paginated)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { tenantId, apartmentId, method, startDate, endDate, page, limit } = req.query;

    const result = await PaymentService.getPaymentHistory({
      organizationId: orgId,
      tenantId: tenantScope || (tenantId ? String(tenantId) : undefined),
      apartmentId: apartmentId ? String(apartmentId) : undefined,
      paymentMethodCode: method ? String(method) : undefined,
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list payments' });
  }
});

// 4. GET OUTSTANDING BALANCE FOR APARTMENT / TENANT
router.get('/outstanding', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { apartmentId, tenantId } = req.query;

    const result = await PaymentService.getOutstandingBalance(
      orgId,
      apartmentId ? String(apartmentId) : undefined,
      tenantScope || (tenantId ? String(tenantId) : undefined)
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch outstanding balance' });
  }
});

// 5. GET PAYMENT DETAIL BY ID
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const payment = await PaymentService.getPaymentById(req.params.id, orgId, tenantScope);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json(payment);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch payment' });
  }
});

export default router;
