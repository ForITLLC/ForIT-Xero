import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConfigByContactId } from '../services/database';
import { runMonthlyReconciliation } from '../services/monthlyReconciliation';
import { createLogger } from '../utils/logger';

/**
 * Monthly Run - Trigger Monthly Interest Reconciliation for a Specific Client
 *
 * POST /api/monthly-run
 * Body: { "contactId": "xxx", "dryRun": false }
 *
 * Creates MONTHLY interest invoices (one per month), NOT a single consolidated invoice.
 * This is the CORRECT approach for WMA interest billing.
 */
async function monthlyRun(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'MonthlyRun');

  try {
    const body = await request.json() as { contactId?: string; dryRun?: boolean };
    const { contactId, dryRun = false } = body;

    if (!contactId) {
      return {
        status: 400,
        jsonBody: { error: 'contactId is required' },
      };
    }

    logger.info('Starting monthly interest reconciliation', { contactId, dryRun });

    const config = await getConfigByContactId(contactId);
    if (!config) {
      return {
        status: 404,
        jsonBody: { error: `Client with contact ID ${contactId} not found` },
      };
    }

    if (!config.isActive) {
      return {
        status: 400,
        jsonBody: { error: `Client ${config.contactName} is not active` },
      };
    }

    // Run monthly reconciliation - creates one invoice per month
    const result = await runMonthlyReconciliation(config, logger, new Date(), dryRun);

    return {
      status: 200,
      jsonBody: {
        success: true,
        dryRun,
        contactName: config.contactName,
        monthsProcessed: result.monthlyResults.length,
        totalInterest: result.totalInterest,
        monthlyResults: result.monthlyResults,
        detailedResults: result.detailedResults,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Monthly run failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('MonthlyRun', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'monthly-run',
  handler: monthlyRun,
});
