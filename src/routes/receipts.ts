import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth } from '../middleware/auth';
import { ReceiptService } from '../services/receiptService';

const router = Router();

// 1. LIST RECEIPTS (Filtered & Paginated)
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { receiptNumber, page, limit } = req.query;

    const where: any = { organization_id: orgId };
    if (tenantScope) {
      const tenantPayments = await prisma.tsmib_payments.findMany({
        where: { organization_id: orgId, tenant_id: tenantScope },
        select: { id: true },
      });
      where.payment_id = { in: tenantPayments.map((payment) => payment.id) };
    }
    if (receiptNumber) {
      where.receipt_number = { contains: String(receiptNumber), mode: 'insensitive' };
    }

    const pageNum = page ? Number(page) : 1;
    const limitNum = limit ? Number(limit) : 20;
    const skip = (pageNum - 1) * limitNum;

    const [receipts, total] = await Promise.all([
      prisma.tsmib_payment_receipts.findMany({
        where,
        include: {
          tsmib_payments: {
            include: {
              tsmib_tenants: true,
              tsmib_apartments: {
                include: { tsmib_buildings: true },
              },
              tsmib_payment_method: true,
            },
          },
        },
        orderBy: { generated_at: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.tsmib_payment_receipts.count({ where }),
    ]);

    const formatted = receipts.map((r) => {
      const p = r.tsmib_payments;
      return {
        id: r.id,
        receiptNumber: r.receipt_number,
        generatedAt: r.generated_at,
        receiptUrl: r.receipt_url,
        paymentId: r.payment_id,
        amount: p ? Number(p.amount) : 0,
        paymentDate: p?.payment_date,
        method: p?.tsmib_payment_method?.name,
        tenantName: p?.tsmib_tenants ? `${p.tsmib_tenants.first_name} ${p.tsmib_tenants.last_name || ''}`.trim() : 'N/A',
        apartmentNumber: p?.tsmib_apartments?.apartment_number || 'N/A',
        buildingName: p?.tsmib_apartments?.tsmib_buildings?.name || 'N/A',
      };
    });

    res.json({
      receipts: formatted,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list receipts' });
  }
});

// 2. GET RECEIPT DETAILS BY RECEIPT NUMBER
router.get('/:receiptNumber', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    if (tenantScope) {
      const accessibleReceipt = await prisma.tsmib_payment_receipts.findFirst({
        where: {
          organization_id: orgId,
          receipt_number: req.params.receiptNumber,
          tsmib_payments: { tenant_id: tenantScope },
        },
        select: { id: true },
      });
      if (!accessibleReceipt) return res.status(404).json({ error: 'Receipt not found' });
    }
    const data = await ReceiptService.getReceiptDetails({ receiptNumber: req.params.receiptNumber }, orgId);

    if (!data) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch receipt' });
  }
});

// 3. RENDER / DOWNLOAD HTML RECEIPT (For printing, viewing, or exporting to PDF)
router.get('/:receiptNumber/html', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    if (tenantScope) {
      const accessibleReceipt = await prisma.tsmib_payment_receipts.findFirst({
        where: {
          organization_id: orgId,
          receipt_number: req.params.receiptNumber,
          tsmib_payments: { tenant_id: tenantScope },
        },
        select: { id: true },
      });
      if (!accessibleReceipt) return res.status(404).send('<h2>Receipt not found</h2>');
    }
    const data = await ReceiptService.getReceiptDetails({ receiptNumber: req.params.receiptNumber }, orgId);

    if (!data) {
      return res.status(404).send('<h2>Receipt not found</h2>');
    }

    const html = ReceiptService.renderReceiptHtml(data);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h2>Error rendering receipt: ${error.message}</h2>`);
  }
});

export default router;
