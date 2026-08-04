import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { voidInvoices } from '../services/xero';

/**
 * POST /api/void-invoices
 *
 * Voids invoices in the client's Xero organisation. This is destructive and
 * irreversible from this app's side.
 *
 * `deleteInvoice` has always refused anything that is not a DRAFT. This route
 * had no equivalent: one POST with a list of ids voided every one of them,
 * gated by nothing but a shared function key — a bearer secret anyone holding
 * can present, from anywhere (ipSecurityRestrictions is Allow-Any), which until
 * WO#1155 did not even travel over enforced TLS. That asymmetry was the defect.
 *
 * Three gates now, matching what a destructive route should cost:
 *   1. DRY RUN BY DEFAULT — omit `dryRun` and nothing is voided. The old call
 *      shape, which is exactly what a leaked key would send, is now a preview.
 *   2. AN EXPLICIT, NON-DEFAULT CONFIRMATION — `confirm: "VOID"`. Nothing that
 *      could be sent by accident, replayed from a log, or produced by a client
 *      library's defaults will satisfy it.
 *   3. A SCOPE BOUND — at most MAX_BATCH ids per call, so no single request can
 *      sweep an organisation's ledger.
 *
 * Established before the default was changed: Application Insights shows ZERO
 * VoidInvoices requests in 90 days, so no live caller is broken by this.
 */

const MAX_BATCH = 25;
const CONFIRMATION = 'VOID';

interface VoidRequest {
  invoiceIds?: string[];
  dryRun?: boolean;
  confirm?: string;
}

async function voidInvoicesHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log('VoidInvoices function triggered');

  try {
    const body = (await request.json().catch(() => ({}))) as VoidRequest;
    const { invoiceIds, confirm } = body;

    if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return {
        status: 400,
        jsonBody: { error: 'invoiceIds must be a non-empty array' },
      };
    }

    if (invoiceIds.length > MAX_BATCH) {
      return {
        status: 400,
        jsonBody: {
          error: `Too many invoices in one call: ${invoiceIds.length}. The limit is ${MAX_BATCH}, ` +
            'so that no single request can sweep the ledger. Split the work.',
        },
      };
    }

    // Destructive unless explicitly told otherwise, both ways.
    const dryRun = body.dryRun !== false;

    if (dryRun) {
      context.log(`Dry run: ${invoiceIds.length} invoice(s) would be voided, none were`);
      return {
        status: 200,
        jsonBody: {
          dryRun: true,
          wouldVoidCount: invoiceIds.length,
          invoiceIds,
          message:
            `Nothing was voided. To void these ${invoiceIds.length} invoice(s), send ` +
            `dryRun: false together with confirm: "${CONFIRMATION}".`,
        },
      };
    }

    if (confirm !== CONFIRMATION) {
      context.warn('VoidInvoices refused: dryRun was false but the confirmation was absent or wrong', {
        invoiceCount: invoiceIds.length,
      });
      return {
        status: 400,
        jsonBody: {
          error:
            `Refusing to void ${invoiceIds.length} invoice(s): dryRun is false but confirm is not ` +
            `"${CONFIRMATION}". This is deliberate — voiding is irreversible from here.`,
        },
      };
    }

    context.warn('VoidInvoices CONFIRMED — voiding invoices', { invoiceCount: invoiceIds.length, invoiceIds });

    const result = await voidInvoices(invoiceIds);

    context.warn('VoidInvoices complete', { voided: result.voided.length, failed: result.failed.length });

    return {
      status: 200,
      jsonBody: {
        dryRun: false,
        success: true,
        voidedCount: result.voided.length,
        failedCount: result.failed.length,
        voided: result.voided,
        failed: result.failed,
      },
    };
  } catch (error) {
    // The detail goes to the logs, not to whoever presented the key.
    context.error('VoidInvoices failed', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      status: 500,
      jsonBody: { error: 'Internal server error' },
    };
  }
}

app.http('VoidInvoices', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'void-invoices',
  handler: voidInvoicesHandler,
});
