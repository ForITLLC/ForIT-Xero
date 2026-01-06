import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getInvoice, isInvoiceVoided } from '../services/xero';
import { getLatestLedgerEntryForInvoice } from '../services/database';

async function debugVoided(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const invoiceId = request.query.get('invoiceId') || '90e88c01-5e7d-4e42-b98d-34b129b67ed9';
  const sourceInvoiceId = request.query.get('sourceInvoiceId') || '8c67f661-10a1-439d-928d-ece27438c079';

  try {
    // Get invoice directly
    const invoice = await getInvoice(invoiceId);

    // Check voided
    const voided = await isInvoiceVoided(invoiceId);

    // Get ledger entry
    const ledgerEntry = await getLatestLedgerEntryForInvoice(sourceInvoiceId);

    return {
      status: 200,
      jsonBody: {
        invoiceId,
        invoiceFound: !!invoice,
        invoiceStatus: invoice?.status,
        isVoided: voided,
        ledgerEntry: ledgerEntry ? {
          interestInvoiceId: ledgerEntry.interestInvoiceId,
          interestInvoiceNumber: ledgerEntry.interestInvoiceNumber,
          delta: ledgerEntry.delta,
        } : null,
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('DebugVoided', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'debug/voided',
  handler: debugVoided,
});
