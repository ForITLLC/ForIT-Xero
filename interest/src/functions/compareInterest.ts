import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getXeroClient, getTenantId, getOverdueInvoices } from '../services/xero';
import { getConfigByContactId } from '../services/database';

/**
 * Compare our interest calculation vs Paidnice charges per source invoice
 */
async function compareInterest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const contactId = request.query.get('contactId');
  if (!contactId) {
    return { status: 400, jsonBody: { error: 'contactId required' } };
  }

  try {
    const client = await getXeroClient();
    const tenantId = await getTenantId();
    const config = await getConfigByContactId(contactId);

    if (!config) {
      return { status: 404, jsonBody: { error: 'Config not found' } };
    }

    // Get all interest invoices from Paidnice
    const paidniceWhere = `Contact.ContactID==Guid("${contactId}") AND Reference.Contains("Interest") AND Status=="AUTHORISED"`;
    const paidniceResponse = await client.accountingApi.getInvoices(
      tenantId, undefined, paidniceWhere, 'Date DESC',
      undefined, undefined, undefined, undefined, undefined, false, false, undefined, false
    );
    const paidniceInvoices = (paidniceResponse.body.invoices || []) as any[];

    // Group Paidnice charges by source invoice number
    const paidniceBySource: Record<string, { total: number; count: number; invoices: string[] }> = {};
    for (const inv of paidniceInvoices) {
      // Extract source invoice from reference like "2% Monthly Simple Interest Late Fee for Invoice #WM31 (accrued from due date)"
      const match = inv.reference?.match(/Invoice #([^\s(]+)/);
      if (match) {
        const sourceNum = match[1];
        if (!paidniceBySource[sourceNum]) {
          paidniceBySource[sourceNum] = { total: 0, count: 0, invoices: [] };
        }
        paidniceBySource[sourceNum].total += inv.total || 0;
        paidniceBySource[sourceNum].count++;
        paidniceBySource[sourceNum].invoices.push(inv.invoiceNumber);
      }
    }

    // Get overdue invoices and calculate our interest
    const overdueInvoices = await getOverdueInvoices(contactId, config.minDaysOverdue, config.currencyCode);

    const asOfDate = new Date();
    const rate = config.annualRate / 100;
    const dailyRate = rate / 365;
    const gracePeriod = config.minDaysOverdue;

    // Calculate our interest per source invoice
    const comparison: Array<{
      sourceInvoice: string;
      principal: number;
      daysOverdue: number;
      effectiveDays: number;
      ourInterest: number;
      paidniceTotal: number;
      paidniceCount: number;
      difference: number;
    }> = [];

    let totalOurs = 0;
    let totalPaidnice = 0;

    for (const inv of overdueInvoices as any[]) {
      const dueDate = new Date(inv.dueDate);
      const daysOverdue = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      const effectiveDays = Math.max(0, daysOverdue - gracePeriod);
      const principal = inv.amountDue || 0;
      const ourInterest = principal * dailyRate * effectiveDays;

      const paidniceData = paidniceBySource[inv.invoiceNumber] || { total: 0, count: 0 };

      totalOurs += ourInterest;
      totalPaidnice += paidniceData.total;

      comparison.push({
        sourceInvoice: inv.invoiceNumber,
        principal: Math.round(principal * 100) / 100,
        daysOverdue,
        effectiveDays,
        ourInterest: Math.round(ourInterest * 100) / 100,
        paidniceTotal: Math.round(paidniceData.total * 100) / 100,
        paidniceCount: paidniceData.count,
        difference: Math.round((paidniceData.total - ourInterest) * 100) / 100,
      });
    }

    // Sort by difference descending to find biggest discrepancies
    comparison.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    // Find Paidnice charges for invoices we don't have (paid/voided sources)
    const ourInvoiceNumbers = new Set(overdueInvoices.map((i: any) => i.invoiceNumber));
    const paidniceOnly: Array<{ sourceInvoice: string; paidniceTotal: number; paidniceCount: number }> = [];

    for (const [sourceNum, data] of Object.entries(paidniceBySource)) {
      if (!ourInvoiceNumbers.has(sourceNum)) {
        paidniceOnly.push({
          sourceInvoice: sourceNum,
          paidniceTotal: Math.round(data.total * 100) / 100,
          paidniceCount: data.count,
        });
        totalPaidnice += 0; // Already counted above
      }
    }

    return {
      status: 200,
      jsonBody: {
        summary: {
          ourTotal: Math.round(totalOurs * 100) / 100,
          paidniceTotal: Math.round(totalPaidnice * 100) / 100,
          difference: Math.round((totalPaidnice - totalOurs) * 100) / 100,
          invoicesCompared: comparison.length,
          paidniceOnlyCount: paidniceOnly.length,
        },
        topDiscrepancies: comparison.slice(0, 20),
        paidniceOnlyInvoices: paidniceOnly,
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('CompareInterest', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'debug/compare',
  handler: compareInterest,
});
