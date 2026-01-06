import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getInvoiceByNumber } from '../services/xero';
import { calculateTimelineInterest, formatTimeline } from '../utils/paymentTimeline';
import { getConfigByContactId } from '../services/database';

/**
 * Debug endpoint to check a specific invoice and its interest calculation
 * GET /api/debug/check-invoice?invoiceNumber=WM31
 */
async function checkInvoice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const invoiceNumber = request.query.get('invoiceNumber');
  if (!invoiceNumber) {
    return { status: 400, jsonBody: { error: 'invoiceNumber required' } };
  }

  try {
    const invoice = await getInvoiceByNumber(invoiceNumber);
    if (!invoice) {
      return { status: 404, jsonBody: { error: `Invoice ${invoiceNumber} not found` } };
    }

    // Get config for WMA
    const config = await getConfigByContactId('ee71a08a-bae0-41eb-88d6-67117967e82f');
    if (!config) {
      return { status: 404, jsonBody: { error: 'Config not found' } };
    }

    // Calculate timeline interest
    const timelineResult = calculateTimelineInterest(invoice, config);

    return {
      status: 200,
      jsonBody: {
        invoice: {
          invoiceNumber: invoice.invoiceNumber,
          invoiceID: invoice.invoiceID,
          status: invoice.status,
          total: invoice.total,
          amountDue: invoice.amountDue,
          amountPaid: invoice.amountPaid,
          dueDate: invoice.dueDate,
          date: invoice.date,
          reference: (invoice as any).reference,
          paymentsCount: invoice.payments?.length || 0,
          creditNotesCount: invoice.creditNotes?.length || 0,
        },
        payments: invoice.payments?.map((p: any) => ({
          date: p.date || p.Date,
          amount: p.amount || p.Amount,
          paymentID: p.paymentID || p.PaymentID,
        })),
        creditNotes: invoice.creditNotes?.map((cn: any) => ({
          date: cn.date || cn.Date,
          appliedAmount: cn.appliedAmount || cn.AppliedAmount,
          creditNoteNumber: cn.creditNoteNumber || cn.CreditNoteNumber,
        })),
        interestCalculation: {
          totalInterest: timelineResult.totalInterest,
          totalDaysOverdue: timelineResult.totalDaysOverdue,
          effectiveDaysCharged: timelineResult.effectiveDaysCharged,
          periodsCount: timelineResult.periods.length,
        },
        timeline: formatTimeline(timelineResult),
        rawPeriods: timelineResult.periods.map(p => ({
          startDate: p.startDate.toISOString(),
          endDate: p.endDate.toISOString(),
          balance: p.balance,
          daysInPeriod: p.daysInPeriod,
          daysAfterGrace: p.daysAfterGrace,
          interestForPeriod: p.interestForPeriod,
        })),
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('CheckInvoice', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'debug/check-invoice',
  handler: checkInvoice,
});
