import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { creditLedgerEntry } from '../services/reconcile';
import { createLogger } from '../utils/logger';
import { CreditInterestRequest } from '../types';

/**
 * Credit Interest - Manually Reverse an Interest Charge
 *
 * POST /api/creditinterest
 * Body: { "ledgerEntryId": "xxx", "reason": "Customer dispute" }
 *
 * Creates a credit note to reverse a specific interest charge.
 */
async function creditInterest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'CreditInterest');

  try {
    // Parse request body
    const body = await request.json() as CreditInterestRequest;
    const { ledgerEntryId, reason } = body;

    if (!ledgerEntryId) {
      return {
        status: 400,
        jsonBody: { error: 'ledgerEntryId is required' },
      };
    }

    if (!reason) {
      return {
        status: 400,
        jsonBody: { error: 'reason is required' },
      };
    }

    logger.info('Processing credit request', { ledgerEntryId, reason });

    const result = await creditLedgerEntry(ledgerEntryId, reason, logger);

    return {
      status: 200,
      jsonBody: {
        success: true,
        creditNoteId: result.creditNoteId,
        creditNoteNumber: result.creditNoteNumber,
        reason,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Credit interest failed', error instanceof Error ? error : new Error(errorMessage));

    // Handle specific errors
    if (errorMessage.includes('not found')) {
      return {
        status: 404,
        jsonBody: { error: errorMessage },
      };
    }

    if (errorMessage.includes('already')) {
      return {
        status: 400,
        jsonBody: { error: errorMessage },
      };
    }

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('CreditInterest', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'creditinterest',
  handler: creditInterest,
});
