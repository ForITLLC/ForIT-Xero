import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getXeroClient, getTenantId } from '../services/xero';

/**
 * List existing interest invoices for a contact (e.g., from Paidnice)
 */
async function listInterestInvoices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const contactId = request.query.get('contactId');
  if (!contactId) {
    return { status: 400, jsonBody: { error: 'contactId required' } };
  }

  try {
    const client = await getXeroClient();
    const tenantId = await getTenantId();

    // Query for invoices with "Interest" in reference for this contact
    const where = `Contact.ContactID==Guid("${contactId}") AND Reference.Contains("Interest")`;

    const response = await client.accountingApi.getInvoices(
      tenantId,
      undefined,
      where,
      'Date DESC',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      false
    );

    const invoices = (response.body.invoices || []).map((inv: any) => ({
      invoiceId: inv.invoiceID,
      invoiceNumber: inv.invoiceNumber,
      reference: inv.reference,
      date: inv.date,
      dueDate: inv.dueDate,
      status: inv.status,
      total: inv.total,
      amountDue: inv.amountDue,
      amountPaid: inv.amountPaid,
    }));

    const totalCharged = invoices.reduce((sum: number, inv: any) => sum + (inv.total || 0), 0);
    const totalPaid = invoices.reduce((sum: number, inv: any) => sum + (inv.amountPaid || 0), 0);

    return {
      status: 200,
      jsonBody: {
        count: invoices.length,
        totalCharged,
        totalPaid,
        invoices,
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('ListInterestInvoices', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'debug/interest-invoices',
  handler: listInterestInvoices,
});
