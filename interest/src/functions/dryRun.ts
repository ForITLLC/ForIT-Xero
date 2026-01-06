import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getActiveConfigs, getConfigByContactId } from '../services/database';
import { runAccrualForAllClients, runAccrualForClient, summarizeResults } from '../services/accrual';
import { createLogger } from '../utils/logger';
import { DryRunRequest, DryRunResponse } from '../types';

/**
 * Dry Run - Preview Interest Calculations
 *
 * GET /api/dryrun
 * GET /api/dryrun?contactId=xxx
 * GET /api/dryrun?asOfDate=2026-01-15
 *
 * Returns what would be charged without actually creating invoices.
 */
async function dryRun(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'DryRun');

  try {
    // Parse query parameters
    const contactId = request.query.get('contactId') || undefined;
    const asOfDateStr = request.query.get('asOfDate');
    const asOfDate = asOfDateStr ? new Date(asOfDateStr) : new Date();

    logger.info('Starting dry run', { contactId, asOfDate: asOfDate.toISOString() });

    let results;

    if (contactId) {
      // Single client
      const config = await getConfigByContactId(contactId);
      if (!config) {
        return {
          status: 404,
          jsonBody: { error: `Client with contact ID ${contactId} not found` },
        };
      }
      const result = await runAccrualForClient(config, logger, true, asOfDate);
      results = [result];
    } else {
      // All active clients
      const configs = await getActiveConfigs();
      logger.info(`Found ${configs.length} active clients`);
      results = await runAccrualForAllClients(configs, logger, true, asOfDate);
    }

    const summary = summarizeResults(results);

    const response: DryRunResponse = {
      results: results.map((r) => ({
        ...r,
        // Convert dates to strings for JSON
        calculations: r.calculations.map((c) => ({
          ...c,
          periodStart: c.periodStart,
          periodEnd: c.periodEnd,
          sourceInvoice: {
            invoiceID: c.sourceInvoice.invoiceID,
            invoiceNumber: c.sourceInvoice.invoiceNumber,
            amountDue: c.sourceInvoice.amountDue,
            dueDate: c.sourceInvoice.dueDate,
          } as any,
        })),
      })),
      totalInterest: summary.totalInterest,
      invoicesWouldCreate: results.filter((r) => r.calculations.length > 0).length,
      timestamp: new Date().toISOString(),
    };

    logger.info('Dry run complete', {
      clientsProcessed: summary.clientsProcessed,
      invoicesWouldCreate: response.invoicesWouldCreate,
      totalInterest: summary.totalInterest,
    });

    return {
      status: 200,
      jsonBody: response,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Dry run failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('DryRun', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'dryrun',
  handler: dryRun,
});
