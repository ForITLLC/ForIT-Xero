import { app, InvocationContext, Timer } from '@azure/functions';
import { getActiveConfigs } from '../services/database';
import { runAccrualForAllClients, summarizeResults } from '../services/accrual';
import { createLogger } from '../utils/logger';

/**
 * Daily Interest Accrual
 *
 * Runs daily at 8:00 AM CST.
 * Processes all active clients, calculates interest on overdue invoices,
 * and creates consolidated interest invoices in Xero.
 *
 * Interest is calculated daily: Principal × (AnnualRate / 365) × DaysOverdue
 * The ledger tracks what's been charged to avoid double-billing.
 */
async function dailyAccrual(timer: Timer, context: InvocationContext): Promise<void> {
  const logger = createLogger(context, 'DailyAccrual');

  logger.info('Starting daily interest accrual', {
    scheduledTime: timer.scheduleStatus?.last,
    isPastDue: timer.isPastDue,
  });

  try {
    // Get all active client configurations
    const configs = await getActiveConfigs();
    logger.info(`Found ${configs.length} active clients`);

    if (configs.length === 0) {
      logger.info('No active clients to process');
      return;
    }

    // Run accrual for all clients
    const results = await runAccrualForAllClients(configs, logger, false);

    // Summarize results
    const summary = summarizeResults(results);

    logger.info('Daily accrual complete', {
      clientsProcessed: summary.clientsProcessed,
      invoicesCreated: summary.invoicesCreated,
      totalInterest: summary.totalInterest,
      errors: summary.errors.length,
    });

    // Log any errors
    if (summary.errors.length > 0) {
      logger.warn('Some clients had errors', { errors: summary.errors });
    }

  } catch (error) {
    logger.error('Daily accrual failed', error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

app.timer('DailyAccrual', {
  // Run daily at 8:00 AM CST
  // Note: Azure uses UTC, CST is UTC-6
  schedule: '0 0 14 * * *', // 14:00 UTC = 8:00 CST, every day
  handler: dailyAccrual,
  runOnStartup: false,
});
