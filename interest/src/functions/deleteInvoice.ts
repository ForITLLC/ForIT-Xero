import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { deleteInvoice, getInvoice } from '../services/xero';

async function deleteInvoiceHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const invoiceId = request.query.get('invoiceId');

  if (!invoiceId) {
    return { status: 400, jsonBody: { error: 'invoiceId required' } };
  }

  try {
    // Check current status
    const invoice = await getInvoice(invoiceId);
    if (!invoice) {
      return { status: 404, jsonBody: { error: 'Invoice not found' } };
    }

    if (invoice.status !== 'DRAFT') {
      return {
        status: 400,
        jsonBody: {
          error: `Cannot delete invoice with status ${invoice.status}. Only DRAFT invoices can be deleted.`,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
        },
      };
    }

    await deleteInvoice(invoiceId);

    return {
      status: 200,
      jsonBody: {
        success: true,
        invoiceNumber: invoice.invoiceNumber,
        message: 'Invoice deleted successfully',
      },
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

app.http('DeleteInvoice', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'delete-invoice',
  handler: deleteInvoiceHandler,
});
