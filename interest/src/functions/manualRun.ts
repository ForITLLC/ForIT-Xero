import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConfigByContactId } from '../services/database';
import { runAccrualForClient } from '../services/accrual';
import { createLogger } from '../utils/logger';
import { ManualRunRequest } from '../types';

/**
 * Manual Run - Trigger Interest Accrual for a Specific Client
 *
 * POST /api/manualrun
 * Body: { "contactId": "xxx", "force": false }
 *
 * Uses the SAME calculation logic as the scheduled daily accrual:
 * - Timeline-based interest calculation (accounts for payment dates)
 * - ONE consolidated interest invoice per client
 * - Self-correcting (recalculates and updates if payments are backdated)
 */
async function manualRun(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'ManualRun');

  try {
    const body = await request.json() as ManualRunRequest;
    const { contactId, force = false } = body;

    if (!contactId) {
      return {
        status: 400,
        jsonBody: { error: 'contactId is required' },
      };
    }

    logger.info('Starting interest accrual', { contactId, force });

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

    // Check if already ran today (skip if force=true)
    const today = new Date();
    if (!force && config.lastRunDate) {
      const lastRun = new Date(config.lastRunDate);
      if (
        lastRun.getFullYear() === today.getFullYear() &&
        lastRun.getMonth() === today.getMonth() &&
        lastRun.getDate() === today.getDate()
      ) {
        return {
          status: 400,
          jsonBody: {
            error: `Already ran for ${config.contactName} today. Use force=true to override.`,
            lastRunDate: config.lastRunDate.toISOString(),
          },
        };
      }
    }

    // Run accrual using the SAME service as the scheduled function
    const result = await runAccrualForClient(config, logger, false, today);

    return {
      status: 200,
      jsonBody: {
        success: true,
        contactName: config.contactName,
        totalInterest: result.totalInterest,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        invoicesProcessed: result.calculations.length,
        skipped: result.skipped,
        errors: result.errors,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Manual run failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('ManualRun', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'manualrun',
  handler: manualRun,
});
