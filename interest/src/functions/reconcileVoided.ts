import { app, InvocationContext, Timer } from '@azure/functions';
import { reconcileVoidedInvoices } from '../services/reconcile';
import { createLogger } from '../utils/logger';

/**
 * Reconcile Voided Invoices
 *
 * Runs daily at 6:00 AM CST.
 * Checks all active ledger entries to see if the source invoice
 * has been voided, and creates credit notes to reverse the interest.
 */
async function reconcileVoided(timer: Timer, context: InvocationContext): Promise<void> {
  const logger = createLogger(context, 'ReconcileVoided');

  logger.info('Starting voided invoice reconciliation', {
    scheduledTime: timer.scheduleStatus?.last,
    isPastDue: timer.isPastDue,
  });

  try {
    const result = await reconcileVoidedInvoices(logger);

    logger.info('Reconciliation complete', {
      voidedSourceInvoices: result.voidedSourceInvoices.length,
      creditNotesCreated: result.creditNotesCreated.length,
      ledgerEntriesUpdated: result.ledgerEntriesUpdated,
      errors: result.errors.length,
    });

    if (result.errors.length > 0) {
      logger.warn('Some reconciliations had errors', { errors: result.errors });
    }

  } catch (error) {
    logger.error('Reconciliation failed', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

app.timer('ReconcileVoided', {
  // Run at 6:00 AM CST daily (12:00 UTC)
  schedule: '0 0 12 * * *',
  handler: reconcileVoided,
  runOnStartup: false,
});
