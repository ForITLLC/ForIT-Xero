import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getOverdueInvoices } from '../services/xero';
import { getConfigByContactId } from '../services/database';

/**
 * Export all overdue invoices as CSV
 * GET /api/export/invoices?contactId=xxx
 */
async function exportInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const contactId = request.query.get('contactId');
  if (!contactId) {
    return { status: 400, jsonBody: { error: 'contactId required' } };
  }

  try {
    const config = await getConfigByContactId(contactId);
    if (!config) {
      return { status: 404, jsonBody: { error: 'Config not found' } };
    }

    const invoices = await getOverdueInvoices(contactId, config.minDaysOverdue, config.currencyCode);

    // Build CSV
    const headers = ['Invoice Number', 'Status', 'Due Date', 'Reference/Memo', 'Original Total', 'Amount Due', 'Amount Paid', 'Payments Count'];
    const rows = invoices.map((inv: any) => {
      // Handle dueDate being either a string or Date object
      let dueDateStr = '';
      if (inv.dueDate) {
        if (typeof inv.dueDate === 'string') {
          dueDateStr = inv.dueDate.split('T')[0];
        } else if (inv.dueDate instanceof Date) {
          dueDateStr = inv.dueDate.toISOString().split('T')[0];
        } else {
          dueDateStr = String(inv.dueDate).split('T')[0];
        }
      }
      // Escape reference field for CSV (handle commas, quotes)
      const reference = (inv.reference || '').replace(/"/g, '""');
      return [
        inv.invoiceNumber,
        inv.status,
        dueDateStr,
        `"${reference}"`,
        inv.total,
        inv.amountDue,
        inv.amountPaid || 0,
        inv.payments?.length || 0,
      ];
    });

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    return {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="WMA-invoices-${new Date().toISOString().split('T')[0]}.csv"`,
      },
      body: csv,
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('ExportInvoices', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'export/invoices',
  handler: exportInvoices,
});
