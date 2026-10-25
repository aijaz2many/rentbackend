import { prisma } from '../lib/prisma';

export interface ReceiptData {
  receiptNumber: string;
  generatedAt: Date;
  organization: {
    name: string;
    email?: string | null;
    phone?: string | null;
  };
  tenant: {
    name: string;
    email?: string | null;
    phone?: string | null;
  };
  apartment: {
    apartmentNumber: string;
    buildingName: string;
    propertyName: string;
  };
  payment: {
    reference: string;
    amount: number;
    paymentDate: Date;
    method: string;
    transactionId?: string | null;
    notes?: string | null;
  };
  allocations: {
    period: string;
    allocatedAmount: number;
    status: string;
  }[];
  outstandingBalance: number;
}

export class ReceiptService {
  /**
   * Get rich receipt data by receipt number or payment ID
   */
  static async getReceiptDetails(identifier: { receiptNumber?: string; paymentId?: string }, organizationId: string): Promise<ReceiptData | null> {
    const whereClause: any = { organization_id: organizationId };
    if (identifier.receiptNumber) {
      whereClause.receipt_number = identifier.receiptNumber;
    } else if (identifier.paymentId) {
      whereClause.payment_id = identifier.paymentId;
    }

    const receipt = await prisma.tsmib_payment_receipts.findFirst({
      where: whereClause,
      include: {
        tsmib_organizations: true,
        tsmib_payments: {
          include: {
            tsmib_tenants: true,
            tsmib_apartments: {
              include: {
                tsmib_buildings: {
                  include: {
                    tsmib_properties: true,
                  },
                },
              },
            },
            tsmib_payment_method: true,
            tsmib_payment_allocations: {
              include: {
                tsmib_rent_charges: {
                  include: { tsmib_rent_status: true },
                },
              },
            },
          },
        },
      },
    });

    if (!receipt || !receipt.tsmib_payments) return null;

    const payment = receipt.tsmib_payments;
    const tenant = payment.tsmib_tenants;
    const apt = payment.tsmib_apartments;
    const bldg = apt?.tsmib_buildings;
    const prop = bldg?.tsmib_properties;
    const org = receipt.tsmib_organizations;

    // Calculate current remaining outstanding balance for the apartment
    let outstandingBalance = 0;
    if (apt) {
      const pendingCharges = await prisma.tsmib_rent_charges.findMany({
        where: {
          organization_id: organizationId,
          apartment_id: apt.id,
          tsmib_rent_status: {
            code: { in: ['PENDING', 'OVERDUE', 'PARTIALLY_PAID'] },
          },
        },
        include: { tsmib_payment_allocations: true },
      });

      for (const c of pendingCharges) {
        const total = Number(c.total_amount || (Number(c.rent_amount) + Number(c.late_fee || 0)));
        const paid = c.tsmib_payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);
        outstandingBalance += Math.max(0, total - paid);
      }
    }

    return {
      receiptNumber: receipt.receipt_number,
      generatedAt: receipt.generated_at,
      organization: {
        name: org.name,
        email: org.email,
        phone: org.phone,
      },
      tenant: {
        name: tenant ? `${tenant.first_name} ${tenant.last_name || ''}`.trim() : 'Unknown Tenant',
        email: tenant?.email,
        phone: tenant?.phone,
      },
      apartment: {
        apartmentNumber: apt?.apartment_number || 'N/A',
        buildingName: bldg?.name || 'N/A',
        propertyName: prop?.name || 'N/A',
      },
      payment: {
        reference: payment.payment_reference || receipt.payment_id,
        amount: Number(payment.amount),
        paymentDate: payment.payment_date,
        method: payment.tsmib_payment_method?.name || 'Payment',
        transactionId: payment.transaction_id,
        notes: payment.notes,
      },
      allocations: payment.tsmib_payment_allocations.map((a) => ({
        period: `${a.tsmib_rent_charges.billing_month}/${a.tsmib_rent_charges.billing_year}`,
        allocatedAmount: Number(a.amount),
        status: a.tsmib_rent_charges.tsmib_rent_status.code,
      })),
      outstandingBalance,
    };
  }

  /**
   * Generate lightweight HTML invoice/receipt document for preview or printing
   */
  static renderReceiptHtml(data: ReceiptData): string {
    const formattedDate = new Date(data.payment.paymentDate).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    const allocRows = data.allocations
      .map(
        (a) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">Rent for Period: ${a.period}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;"><span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: bold;">${a.status}</span></td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: bold;">₹${a.allocatedAmount.toLocaleString()}</td>
      </tr>`
      )
      .join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Receipt ${data.receiptNumber}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; padding: 40px; color: #1e293b; }
    .receipt-box { max-width: 650px; margin: auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 36px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #6366f1; padding-bottom: 20px; }
    .badge { background: #e0e7ff; color: #4338ca; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: bold; }
    .details { display: flex; justify-content: space-between; margin: 24px 0; font-size: 14px; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
    th { text-align: left; padding: 10px; background: #f1f5f9; color: #475569; }
    .total-row { display: flex; justify-content: space-between; font-size: 18px; font-weight: bold; padding: 16px 0; border-top: 2px solid #e2e8f0; margin-top: 20px; }
    .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="receipt-box">
    <div class="header">
      <div>
        <h2 style="margin: 0; color: #4338ca;">${data.organization.name}</h2>
        <div style="font-size: 13px; color: #64748b;">${data.organization.email || ''} ${data.organization.phone ? '• ' + data.organization.phone : ''}</div>
      </div>
      <div style="text-align: right;">
        <span class="badge">OFFICIAL RENT RECEIPT</span>
        <div style="font-size: 12px; color: #64748b; margin-top: 6px;">Receipt #: <strong>${data.receiptNumber}</strong></div>
        <div style="font-size: 12px; color: #64748b;">Date: ${formattedDate}</div>
      </div>
    </div>

    <div class="details">
      <div>
        <strong style="color: #64748b; text-transform: uppercase; font-size: 11px;">Tenant Details</strong>
        <div style="font-weight: bold; font-size: 15px; margin-top: 4px;">${data.tenant.name}</div>
        <div>Phone: ${data.tenant.phone || 'N/A'}</div>
      </div>
      <div style="text-align: right;">
        <strong style="color: #64748b; text-transform: uppercase; font-size: 11px;">Property Details</strong>
        <div style="font-weight: bold; font-size: 15px; margin-top: 4px;">Unit ${data.apartment.apartmentNumber}</div>
        <div>${data.apartment.buildingName}, ${data.apartment.propertyName}</div>
      </div>
    </div>

    <div style="margin: 20px 0; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 13px; display: flex; justify-content: space-between;">
      <div>Payment Mode: <strong>${data.payment.method}</strong></div>
      <div>Transaction Ref: <strong>${data.payment.transactionId || data.payment.reference}</strong></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align: center;">Status</th>
          <th style="text-align: right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${allocRows}
      </tbody>
    </table>

    <div class="total-row">
      <span>Amount Paid:</span>
      <span style="color: #16a34a;">₹${data.payment.amount.toLocaleString()}</span>
    </div>

    <div style="display: flex; justify-content: space-between; font-size: 13px; color: #64748b; padding-top: 8px;">
      <span>Remaining Outstanding Balance:</span>
      <span style="font-weight: bold; color: ${data.outstandingBalance > 0 ? '#dc2626' : '#16a34a'};">₹${data.outstandingBalance.toLocaleString()}</span>
    </div>

    <div class="footer">
      <p>This is a computer-generated receipt issued by ${data.organization.name}.</p>
    </div>
  </div>
</body>
</html>
`;
  }
}
