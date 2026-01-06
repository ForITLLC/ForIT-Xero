import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { voidInvoices } from '../services/xero';

interface VoidRequest {
  invoiceIds: string[];
}

async function voidInvoicesHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('VoidInvoices function triggered');

  try {
    const body = (await request.json()) as VoidRequest;

    if (!body.invoiceIds || !Array.isArray(body.invoiceIds)) {
      return {
        status: 400,
        jsonBody: { error: 'invoiceIds array is required' },
      };
    }

    context.log(`Voiding ${body.invoiceIds.length} invoices...`);

    const result = await voidInvoices(body.invoiceIds);

    context.log(`Voided: ${result.voided.length}, Failed: ${result.failed.length}`);

    return {
      status: 200,
      jsonBody: {
        success: true,
        voidedCount: result.voided.length,
        failedCount: result.failed.length,
        voided: result.voided,
        failed: result.failed,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('VoidInvoices error:', errorMessage);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('VoidInvoices', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'void-invoices',
  handler: voidInvoicesHandler,
});
