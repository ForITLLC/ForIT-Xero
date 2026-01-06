import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getOverdueInvoices } from '../services/xero';
import { getLedgerEntriesByContact, getConfigByContactId, getCurrentChargedAmount } from '../services/database';
import { parseXeroDate, daysOverdue } from '../utils/dates';
import { calculateShouldOwe } from '../services/reconciliation';

/**
 * Debug endpoint to see raw invoice data and calculation details
 */
async function debugInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const contactId = request.query.get('contactId');
  if (!contactId) {
    return { status: 400, jsonBody: { error: 'contactId required' } };
  }

  try {
    // Get config
    const config = await getConfigByContactId(contactId);
    if (!config) {
      return { status: 404, jsonBody: { error: 'Config not found' } };
    }

    // Get invoices
    const invoices = await getOverdueInvoices(contactId, config.minDaysOverdue, config.currencyCode);

    // Get ledger entries
    const ledgerEntries = await getLedgerEntriesByContact(contactId);

    // Debug each invoice - show raw object structure first
    const asOfDate = new Date();

    // Show raw first invoice to see actual property names
    const rawSample = invoices.length > 0 ? JSON.stringify(invoices[0], null, 2) : null;

    const debugInfo = await Promise.all(invoices.slice(0, 10).map(async (invoice: any) => {
      // Try both camelCase and PascalCase
      const rawDueDate = invoice.DueDate || invoice.dueDate;
      const invoiceNumber = invoice.InvoiceNumber || invoice.invoiceNumber;
      const invoiceId = invoice.InvoiceID || invoice.invoiceID || invoice.invoiceId;
      const status = invoice.Status || invoice.status;
      const amountDue = invoice.AmountDue || invoice.amountDue;

      const dueDate = parseXeroDate(rawDueDate);
      const totalDaysOverdue = daysOverdue(dueDate, asOfDate);
      const effectiveDaysOverdue = totalDaysOverdue - config.minDaysOverdue;

      // Get current charged amount from ledger
      const currentlyCharged = await getCurrentChargedAmount(invoiceId);

      // Calculate what should be owed
      const { shouldOwe } = calculateShouldOwe(invoice, config, asOfDate);

      // Ledger entries for this invoice (count by action)
      const invoiceLedgerEntries = ledgerEntries.filter(
        (e) => e.sourceInvoiceId === invoiceId
      );

      return {
        invoiceNumber,
        invoiceId,
        status,
        amountDue,
        rawDueDate: String(rawDueDate),
        parsedDueDate: dueDate.toISOString(),
        asOfDate: asOfDate.toISOString(),
        totalDaysOverdue,
        minDaysOverdue: config.minDaysOverdue,
        effectiveDaysOverdue,
        ledgerEntriesCount: invoiceLedgerEntries.length,
        currentlyCharged,
        shouldOwe,
        delta: shouldOwe - currentlyCharged,
        needsReconciliation: Math.abs(shouldOwe - currentlyCharged) > 0.01,
      };
    }));

    return {
      status: 200,
      jsonBody: {
        config: {
          contactName: config.contactName,
          annualRate: config.annualRate,
          minDaysOverdue: config.minDaysOverdue,
          minChargeAmount: config.minChargeAmount,
        },
        totalInvoicesFound: invoices.length,
        totalLedgerEntries: ledgerEntries.length,
        rawSampleInvoice: rawSample,
        debugInfo,
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('DebugInvoices', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'debug/invoices',
  handler: debugInvoices,
});
