import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getLedgerEntriesByContact, getActiveConfigs } from '../services/database';
import { createLogger } from '../utils/logger';
import { roundMoney } from '../utils/calculations';

/**
 * Reconciliation Report - Get Interest Activity Summary
 *
 * GET /api/report
 * GET /api/report?contactId=xxx
 *
 * Returns a summary of interest activity from the ledger.
 * The ledger now tracks reconciliation actions (Created, Updated, Credited, AdditionalCharge).
 */
async function reconcileReport(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'ReconcileReport');

  try {
    const contactId = request.query.get('contactId');

    logger.info('Generating reconciliation report', { contactId });

    // Get configs to iterate through clients
    const configs = await getActiveConfigs();

    // Build report by client
    const clients = await Promise.all(
      configs
        .filter(c => !contactId || c.xeroContactId === contactId)
        .map(async (config) => {
          const entries = await getLedgerEntriesByContact(config.xeroContactId);

          // Calculate totals from ledger entries
          // newAmount represents current should-owe, delta represents changes
          const totalDelta = entries.reduce((sum, e) => sum + e.delta, 0);
          const latestAmounts = new Map<string, number>();

          // Get latest newAmount for each source invoice
          for (const entry of entries) {
            latestAmounts.set(entry.sourceInvoiceId, entry.newAmount);
          }

          const currentOwed = Array.from(latestAmounts.values()).reduce((sum, amt) => sum + amt, 0);

          // Count by action type
          const actionCounts = entries.reduce((acc, e) => {
            acc[e.action] = (acc[e.action] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);

          // Sum credits (negative deltas from Credited actions)
          const totalCredited = entries
            .filter(e => e.action === 'Credited')
            .reduce((sum, e) => sum + Math.abs(e.delta), 0);

          return {
            contactId: config.xeroContactId,
            contactName: config.contactName,
            entries: entries.length,
            currentOwed: roundMoney(currentOwed),
            totalCredited: roundMoney(totalCredited),
            netChange: roundMoney(totalDelta),
            actionCounts,
            recentActivity: entries
              .sort((a, b) => b.created.getTime() - a.created.getTime())
              .slice(0, 5)
              .map(e => ({
                date: e.created.toISOString(),
                action: e.action,
                sourceInvoice: e.sourceInvoiceNumber,
                delta: e.delta,
                reason: e.reason,
              })),
          };
        })
    );

    const totals = clients.reduce(
      (acc, c) => ({
        entries: acc.entries + c.entries,
        currentOwed: roundMoney(acc.currentOwed + c.currentOwed),
        totalCredited: roundMoney(acc.totalCredited + c.totalCredited),
        netChange: roundMoney(acc.netChange + c.netChange),
      }),
      { entries: 0, currentOwed: 0, totalCredited: 0, netChange: 0 }
    );

    return {
      status: 200,
      jsonBody: {
        generatedAt: new Date().toISOString(),
        clients,
        totals,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Report generation failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

app.http('ReconcileReport', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'report',
  handler: reconcileReport,
});
