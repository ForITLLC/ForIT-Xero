import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { authorizeInvoice } from '../services/xero';

/**
 * Approve a draft invoice (change DRAFT to AUTHORISED)
 * POST /api/approve-invoice
 * Body: { invoiceId: string }
 */
async function approveInvoiceHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('ApproveInvoice function triggered');

  try {
    const body = (await request.json()) as { invoiceId: string };

    if (!body.invoiceId) {
      return {
        status: 400,
        jsonBody: { error: 'invoiceId is required' },
      };
    }

    context.log(`Approving invoice: ${body.invoiceId}`);

    await authorizeInvoice(body.invoiceId);

    context.log(`Invoice ${body.invoiceId} approved successfully`);

    return {
      status: 200,
      jsonBody: {
        success: true,
        invoiceId: body.invoiceId,
        message: 'Invoice approved (changed to AUTHORISED)',
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('ApproveInvoice error:', errorMessage);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('ApproveInvoice', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'approve-invoice',
  handler: approveInvoiceHandler,
});
