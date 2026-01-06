import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createLedgerEntry } from '../services/database';
import { getInvoiceByNumber } from '../services/xero';
import { InterestLedgerEntry } from '../types';

interface PaidniceInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Reference: string;
  Status: string;
  Total: number;
  AmountDue: number;
  AmountPaid: number;
  DueDate: string;
  InvoiceDate: string;
}

interface PaidniceExport {
  exported_at: string;
  contact: string;
  total_invoices: number;
  total_amount: number;
  invoices: PaidniceInvoice[];
}

/**
 * Parse the source invoice number from Paidnice reference
 * Format: "2% Monthly Simple Interest Late Fee for Invoice #INV-0001 (accrued from due date)"
 */
function parseSourceInvoiceNumber(reference: string): string | null {
  const match = reference.match(/Invoice #([A-Za-z0-9-]+)/);
  if (!match) return null;

  let invoiceNumber = match[1];

  // Normalize: "WMA30" -> "WMA-30", "30" -> "WMA-30"
  if (invoiceNumber === '30') {
    invoiceNumber = 'WMA-30';
  } else if (invoiceNumber.match(/^WMA\d+$/)) {
    // WMA30 -> WMA-30 (add hyphen)
    invoiceNumber = invoiceNumber.replace(/^WMA(\d+)$/, 'WMA-$1');
  }

  return invoiceNumber;
}

/**
 * Migration endpoint to import Paidnice charges into our ledger
 * This creates baseline entries so our system knows what's already been charged
 *
 * POST /api/migrate/paidnice
 * Body: { paidniceExport: PaidniceExport, contactId: string, dryRun?: boolean }
 */
async function migratePaidnice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json() as {
      paidniceExport: PaidniceExport;
      contactId: string;
      dryRun?: boolean;
    };

    const { paidniceExport, contactId, dryRun = true } = body;

    if (!paidniceExport || !contactId) {
      return { status: 400, jsonBody: { error: 'paidniceExport and contactId required' } };
    }

    context.log(`Migrating ${paidniceExport.invoices.length} Paidnice invoices for ${paidniceExport.contact}`);

    // Group charges by source invoice number
    const chargesBySource = new Map<string, {
      totalCharged: number;
      interestInvoices: Array<{ number: string; amount: number; date: string }>;
    }>();

    for (const invoice of paidniceExport.invoices) {
      const sourceNumber = parseSourceInvoiceNumber(invoice.Reference);
      if (!sourceNumber) {
        context.warn(`Could not parse source invoice from: ${invoice.Reference}`);
        continue;
      }

      const existing = chargesBySource.get(sourceNumber) || { totalCharged: 0, interestInvoices: [] };
      existing.totalCharged += invoice.Total;
      existing.interestInvoices.push({
        number: invoice.InvoiceNumber,
        amount: invoice.Total,
        date: invoice.InvoiceDate,
      });
      chargesBySource.set(sourceNumber, existing);
    }

    context.log(`Found ${chargesBySource.size} unique source invoices with interest charges`);

    // For each source invoice, look up the ID and create ledger entry
    const results: Array<{
      sourceNumber: string;
      sourceId: string | null;
      totalCharged: number;
      interestInvoiceCount: number;
      status: string;
      error?: string;
    }> = [];

    for (const [sourceNumber, data] of chargesBySource) {
      try {
        // Look up source invoice in Xero
        const sourceInvoice = await getInvoiceByNumber(sourceNumber);

        if (!sourceInvoice) {
          results.push({
            sourceNumber,
            sourceId: null,
            totalCharged: data.totalCharged,
            interestInvoiceCount: data.interestInvoices.length,
            status: 'NOT_FOUND',
            error: `Source invoice ${sourceNumber} not found in Xero`,
          });
          continue;
        }

        if (!dryRun) {
          // Create a "baseline" ledger entry
          const entry: Omit<InterestLedgerEntry, 'id' | 'created'> = {
            sourceInvoiceId: sourceInvoice.invoiceID,
            sourceInvoiceNumber: sourceNumber,
            interestInvoiceId: 'PAIDNICE_MIGRATION',
            interestInvoiceNumber: 'PAIDNICE',
            chargeMonth: 'MIGRATION',
            action: 'Created',
            previousAmount: 0,
            newAmount: data.totalCharged,
            delta: data.totalCharged,
            reason: 'Initial',
            sourceDueDate: new Date(sourceInvoice.dueDate),
            sourceAmountDue: sourceInvoice.amountDue,
            daysOverdue: 0, // Historical, not current
            rate: 0.24, // 24% annual = 2% monthly
            contactId: contactId,
            contactName: paidniceExport.contact,
            notes: `Migrated from Paidnice. ${data.interestInvoices.length} interest invoices totaling $${data.totalCharged.toFixed(2)}`,
          };

          await createLedgerEntry(entry);
        }

        results.push({
          sourceNumber,
          sourceId: sourceInvoice.invoiceID,
          totalCharged: data.totalCharged,
          interestInvoiceCount: data.interestInvoices.length,
          status: dryRun ? 'DRY_RUN' : 'MIGRATED',
        });

      } catch (error) {
        results.push({
          sourceNumber,
          sourceId: null,
          totalCharged: data.totalCharged,
          interestInvoiceCount: data.interestInvoices.length,
          status: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Summary
    const migrated = results.filter(r => r.status === 'MIGRATED' || r.status === 'DRY_RUN').length;
    const notFound = results.filter(r => r.status === 'NOT_FOUND').length;
    const errors = results.filter(r => r.status === 'ERROR').length;
    const totalMigrated = results
      .filter(r => r.status === 'MIGRATED' || r.status === 'DRY_RUN')
      .reduce((sum, r) => sum + r.totalCharged, 0);

    return {
      status: 200,
      jsonBody: {
        dryRun,
        summary: {
          sourceInvoicesProcessed: chargesBySource.size,
          migrated,
          notFound,
          errors,
          totalAmountMigrated: totalMigrated,
          originalPaidniceTotal: paidniceExport.total_amount,
        },
        results,
      },
    };

  } catch (error) {
    context.error('Migration failed', error);
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('MigratePaidnice', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'migrate/paidnice',
  handler: migratePaidnice,
});
