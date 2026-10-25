import { prisma } from '../lib/prisma';
import { notifyTenantAfterBusinessEvent } from './notificationService';

export interface RecordPaymentInput {
  organizationId: string;
  tenantId: string;
  apartmentId: string;
  amount: number;
  paymentMethodCode: 'CASH' | 'BANK_TRANSFER' | 'UPI' | 'CARD' | 'ONLINE' | 'OTHER';
  paymentDate?: Date | string;
  transactionId?: string | null;
  rentChargeId?: string | null;
  notes?: string | null;
  autoAllocate?: boolean;
}

export interface PaymentAllocationDetail {
  rentChargeId: string;
  billingPeriod: string;
  chargeTotal: number;
  allocatedAmount: number;
  remainingDue: number;
  newStatus: string;
}

export interface RecordPaymentResult {
  payment: {
    id: string;
    paymentReference: string;
    amount: number;
    paymentDate: Date;
    paymentMethod: string;
    transactionId?: string | null;
    status: string;
    notes?: string | null;
  };
  receipt: {
    id: string;
    receiptNumber: string;
    generatedAt: Date;
  };
  allocations: PaymentAllocationDetail[];
  unallocatedAmount: number;
  isPartial: boolean;
  isAdvance: boolean;
}

export interface PaymentFilterOptions {
  organizationId: string;
  tenantId?: string;
  apartmentId?: string;
  paymentMethodCode?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export class PaymentService {
  /**
   * Helper to generate unique references
   */
  static generateReference(prefix: string): string {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(100 + Math.random() * 900);
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Record a payment and intelligently allocate across outstanding rent charges
   */
  static async recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
    const {
      organizationId,
      tenantId,
      apartmentId,
      amount,
      paymentMethodCode,
      paymentDate = new Date(),
      transactionId,
      rentChargeId,
      notes,
      autoAllocate = true,
    } = input;

    if (amount <= 0) {
      throw new Error('Payment amount must be greater than zero.');
    }

    // 1. Resolve payment method
    const paymentMethod = await prisma.tsmib_payment_method.findFirst({
      where: { code: paymentMethodCode },
    });
    if (!paymentMethod) {
      throw new Error(`Invalid payment method: ${paymentMethodCode}`);
    }

    // 2. Resolve rent statuses
    const [paidStatus, partiallyPaidStatus] = await Promise.all([
      prisma.tsmib_rent_status.findFirst({ where: { code: 'PAID' } }),
      prisma.tsmib_rent_status.findFirst({ where: { code: 'PARTIALLY_PAID' } }),
    ]);

    if (!paidStatus || !partiallyPaidStatus) {
      throw new Error('System configuration error: Rent statuses (PAID/PARTIALLY_PAID) not found.');
    }

    const paymentReference = this.generateReference('PAY');
    const receiptNumber = this.generateReference('RCP');

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create Payment record
      const payment = await tx.tsmib_payments.create({
        data: {
          organization_id: organizationId,
          tenant_id: tenantId,
          apartment_id: apartmentId,
          payment_reference: paymentReference,
          payment_method_id: paymentMethod.id,
          amount: amount as any,
          payment_date: typeof paymentDate === 'string' ? new Date(paymentDate) : paymentDate,
          transaction_id: transactionId || null,
          notes: notes || null,
          status: 'SUCCESS',
        },
      });

      // 2. Determine target rent charges for allocation
      let targetCharges: any[] = [];
      if (rentChargeId) {
        // Specific charge targeted
        const singleCharge = await tx.tsmib_rent_charges.findFirst({
          where: { id: rentChargeId, organization_id: organizationId },
          include: { tsmib_payment_allocations: true, tsmib_rent_status: true },
        });
        if (singleCharge) targetCharges = [singleCharge];
      } else if (autoAllocate) {
        // Chronological allocation (oldest unpaid charges first)
        targetCharges = await tx.tsmib_rent_charges.findMany({
          where: {
            organization_id: organizationId,
            apartment_id: apartmentId,
            tsmib_rent_status: {
              code: { in: ['PENDING', 'OVERDUE', 'PARTIALLY_PAID'] },
            },
          },
          include: { tsmib_payment_allocations: true, tsmib_rent_status: true },
          orderBy: [{ billing_year: 'asc' }, { billing_month: 'asc' }, { due_date: 'asc' }],
        });
      }

      let remainingPayment = amount;
      const allocationDetails: PaymentAllocationDetail[] = [];

      for (const charge of targetCharges) {
        if (remainingPayment <= 0) break;

        const currentPaid = charge.tsmib_payment_allocations.reduce(
          (sum: number, a: any) => sum + Number(a.amount),
          0
        );
        const chargeTotal = Number(charge.total_amount || (Number(charge.rent_amount) + Number(charge.late_fee || 0)));
        const outstanding = Math.max(0, chargeTotal - currentPaid);

        if (outstanding <= 0) continue;

        const allocAmount = Math.min(remainingPayment, outstanding);

        // Record allocation
        await tx.tsmib_payment_allocations.create({
          data: {
            payment_id: payment.id,
            rent_charge_id: charge.id,
            amount: allocAmount as any,
          },
        });

        const newPaidTotal = currentPaid + allocAmount;
        const isChargeFullyPaid = newPaidTotal >= chargeTotal;
        const newStatus = isChargeFullyPaid ? paidStatus : partiallyPaidStatus;

        await tx.tsmib_rent_charges.update({
          where: { id: charge.id },
          data: {
            rent_status_id: newStatus.id,
            updated_at: new Date(),
          },
        });

        allocationDetails.push({
          rentChargeId: charge.id,
          billingPeriod: `${charge.billing_month}/${charge.billing_year}`,
          chargeTotal,
          allocatedAmount: allocAmount,
          remainingDue: Math.max(0, chargeTotal - newPaidTotal),
          newStatus: newStatus.code,
        });

        remainingPayment -= allocAmount;
      }

      // 3. Create Receipt
      const receipt = await tx.tsmib_payment_receipts.create({
        data: {
          organization_id: organizationId,
          payment_id: payment.id,
          receipt_number: receiptNumber,
          generated_at: new Date(),
        },
      });

      const totalAllocated = amount - remainingPayment;
      const isPartial = allocationDetails.some((a) => a.remainingDue > 0);
      const isAdvance = remainingPayment > 0;

      return {
        payment: {
          id: payment.id,
          paymentReference: payment.payment_reference || paymentReference,
          amount: Number(payment.amount),
          paymentDate: payment.payment_date,
          paymentMethod: paymentMethod.name,
          transactionId: payment.transaction_id,
          status: payment.status,
          notes: payment.notes,
        },
        receipt: {
          id: receipt.id,
          receiptNumber: receipt.receipt_number,
          generatedAt: receipt.generated_at,
        },
        allocations: allocationDetails,
        unallocatedAmount: remainingPayment,
        isPartial,
        isAdvance,
      };
    });

    await notifyTenantAfterBusinessEvent(tenantId, {
      organizationId,
      title: 'Payment received',
      message: `Your payment of ₹${amount.toLocaleString('en-IN')} has been recorded. Receipt: ${result.receipt.receiptNumber}.`,
      type: 'PAYMENT_RECEIVED',
    });
    return result;
  }

  /**
   * Get payment history with filters
   */
  static async getPaymentHistory(options: PaymentFilterOptions) {
    const { organizationId, tenantId, apartmentId, paymentMethodCode, startDate, endDate, page = 1, limit = 20 } = options;

    const where: any = { organization_id: organizationId };
    if (tenantId) where.tenant_id = tenantId;
    if (apartmentId) where.apartment_id = apartmentId;
    if (paymentMethodCode) {
      where.tsmib_payment_method = { code: paymentMethodCode };
    }
    if (startDate || endDate) {
      where.payment_date = {};
      if (startDate) where.payment_date.gte = new Date(startDate);
      if (endDate) where.payment_date.lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;

    const [payments, totalCount] = await Promise.all([
      prisma.tsmib_payments.findMany({
        where,
        include: {
          tsmib_tenants: true,
          tsmib_apartments: {
            include: { tsmib_buildings: true },
          },
          tsmib_payment_method: true,
          tsmib_payment_receipts: true,
          tsmib_payment_allocations: {
            include: {
              tsmib_rent_charges: {
                include: { tsmib_rent_status: true },
              },
            },
          },
        },
        orderBy: { payment_date: 'desc' },
        skip,
        take: limit,
      }),
      prisma.tsmib_payments.count({ where }),
    ]);

    const formatted = payments.map((p) => {
      const tenant = p.tsmib_tenants;
      const apartment = p.tsmib_apartments;
      const receipt = p.tsmib_payment_receipts[0];

      return {
        id: p.id,
        paymentReference: p.payment_reference,
        amount: Number(p.amount),
        paymentDate: p.payment_date,
        methodCode: p.tsmib_payment_method.code,
        methodName: p.tsmib_payment_method.name,
        transactionId: p.transaction_id,
        status: p.status,
        notes: p.notes,
        receiptNumber: receipt?.receipt_number || null,
        tenant: tenant
          ? {
              id: tenant.id,
              name: `${tenant.first_name} ${tenant.last_name || ''}`.trim(),
              phone: tenant.phone,
            }
          : null,
        apartment: apartment
          ? {
              id: apartment.id,
              apartmentNumber: apartment.apartment_number,
              buildingName: apartment.tsmib_buildings.name,
            }
          : null,
        allocations: p.tsmib_payment_allocations.map((a) => ({
          id: a.id,
          amount: Number(a.amount),
          rentChargeId: a.rent_charge_id,
          period: `${a.tsmib_rent_charges.billing_month}/${a.tsmib_rent_charges.billing_year}`,
          chargeStatus: a.tsmib_rent_charges.tsmib_rent_status.code,
        })),
      };
    });

    return {
      payments: formatted,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  }

  /**
   * Get single payment detail with full receipt and allocation breakdown
   */
  static async getPaymentById(paymentId: string, organizationId: string, tenantId?: string) {
    const payment = await prisma.tsmib_payments.findFirst({
      where: {
        id: paymentId,
        organization_id: organizationId,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      },
      include: {
        tsmib_tenants: true,
        tsmib_apartments: {
          include: { tsmib_buildings: true },
        },
        tsmib_payment_method: true,
        tsmib_payment_receipts: true,
        tsmib_payment_allocations: {
          include: {
            tsmib_rent_charges: {
              include: { tsmib_rent_status: true },
            },
          },
        },
      },
    });

    if (!payment) return null;

    const receipt = payment.tsmib_payment_receipts[0];
    const tenant = payment.tsmib_tenants;
    const apartment = payment.tsmib_apartments;

    return {
      id: payment.id,
      paymentReference: payment.payment_reference,
      amount: Number(payment.amount),
      paymentDate: payment.payment_date,
      paymentMethod: {
        code: payment.tsmib_payment_method.code,
        name: payment.tsmib_payment_method.name,
      },
      transactionId: payment.transaction_id,
      status: payment.status,
      notes: payment.notes,
      receipt: receipt
        ? {
            id: receipt.id,
            receiptNumber: receipt.receipt_number,
            receiptUrl: receipt.receipt_url,
            generatedAt: receipt.generated_at,
          }
        : null,
      tenant: tenant
        ? {
            id: tenant.id,
            name: `${tenant.first_name} ${tenant.last_name || ''}`.trim(),
            email: tenant.email,
            phone: tenant.phone,
          }
        : null,
      apartment: apartment
        ? {
            id: apartment.id,
            apartmentNumber: apartment.apartment_number,
            buildingName: apartment.tsmib_buildings.name,
          }
        : null,
      allocations: payment.tsmib_payment_allocations.map((a) => {
        const rc = a.tsmib_rent_charges;
        return {
          id: a.id,
          amountAllocated: Number(a.amount),
          rentChargeId: a.rent_charge_id,
          period: `${rc.billing_month}/${rc.billing_year}`,
          rentAmount: Number(rc.rent_amount),
          lateFee: Number(rc.late_fee),
          totalAmount: Number(rc.total_amount || (Number(rc.rent_amount) + Number(rc.late_fee))),
          status: rc.tsmib_rent_status.code,
        };
      }),
    };
  }

  /**
   * Get outstanding balance and unpaid charges for an apartment or tenant
   */
  static async getOutstandingBalance(organizationId: string, apartmentId?: string, tenantId?: string) {
    const where: any = {
      organization_id: organizationId,
      tsmib_rent_status: {
        code: { in: ['PENDING', 'OVERDUE', 'PARTIALLY_PAID'] },
      },
    };

    if (apartmentId) where.apartment_id = apartmentId;
    if (tenantId) {
      where.tsmib_leases = {
        tsmib_lease_tenants: { some: { tenant_id: tenantId } },
      };
    }

    const charges = await prisma.tsmib_rent_charges.findMany({
      where,
      include: {
        tsmib_apartments: {
          include: { tsmib_buildings: true },
        },
        tsmib_rent_status: true,
        tsmib_payment_allocations: true,
      },
      orderBy: [{ billing_year: 'asc' }, { billing_month: 'asc' }],
    });

    let totalDue = 0;
    let totalPaid = 0;

    const items = charges.map((c) => {
      const chargeTotal = Number(c.total_amount || (Number(c.rent_amount) + Number(c.late_fee || 0)));
      const paid = c.tsmib_payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);
      const pending = Math.max(0, chargeTotal - paid);

      totalDue += chargeTotal;
      totalPaid += paid;

      return {
        id: c.id,
        apartmentId: c.apartment_id,
        apartmentNumber: c.tsmib_apartments.apartment_number,
        buildingName: c.tsmib_apartments.tsmib_buildings.name,
        period: `${c.billing_month}/${c.billing_year}`,
        dueDate: c.due_date,
        rentAmount: Number(c.rent_amount),
        lateFee: Number(c.late_fee),
        totalAmount: chargeTotal,
        paidAmount: paid,
        pendingAmount: pending,
        status: c.tsmib_rent_status.code,
      };
    });

    return {
      totalOutstanding: Math.max(0, totalDue - totalPaid),
      unpaidChargesCount: items.length,
      charges: items,
    };
  }
}
