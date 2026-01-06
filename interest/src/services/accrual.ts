import {
  InterestConfig,
  AccrualResult,
} from '../types';
import { runReconciliation, ReconciliationResult } from './reconciliation';
import { updateConfigLastRun } from './database';
import { roundMoney } from '../utils/calculations';
import { Logger } from '../utils/logger';

/**
 * Run interest accrual for a single client using reconciliation approach
 *
 * This is a self-correcting system that:
 * 1. Calculates what SHOULD be owed based on current invoice state
 * 2. Compares to what HAS been charged
 * 3. Updates the interest invoice to match reality
 */
export async function runAccrualForClient(
  config: InterestConfig,
  logger: Logger,
  dryRun: boolean = false,
  asOfDate: Date = new Date()
): Promise<AccrualResult> {
  const result: AccrualResult = {
    config,
    calculations: [],
    totalInterest: 0,
    invoiceCreated: false,
    errors: [],
    skipped: [],
  };

  const clientLogger = logger.withContact(config.xeroContactId);

  try {
    clientLogger.info('Starting reconciliation', {
      minDaysOverdue: config.minDaysOverdue,
      currencyCode: config.currencyCode,
      dryRun,
    });

    if (dryRun) {
      // For dry run, we still run reconciliation but don't persist changes
      // The reconciliation service handles this internally
      clientLogger.info('DRY RUN - calculating what would be charged');
    }

    // Run the reconciliation (pass dryRun flag)
    const reconcileResult = await runReconciliation(config, clientLogger, asOfDate, dryRun);

    // Map reconciliation results to AccrualResult format for backwards compatibility
    result.totalInterest = reconcileResult.totalShouldOwe;
    result.invoiceId = reconcileResult.interestInvoiceId;
    result.invoiceNumber = reconcileResult.interestInvoiceNumber;
    result.invoiceCreated = reconcileResult.results.some(r => r.action === 'Created');

    // Build calculations array from reconciliation results
    result.calculations = reconcileResult.results
      .filter(r => r.shouldOwe > 0)
      .map(r => ({
        sourceInvoice: {
          invoiceID: r.sourceInvoiceId,
          invoiceNumber: r.sourceInvoiceNumber,
          amountDue: 0, // Not available in reconciliation result
          dueDate: '',
          type: 'ACCREC' as const,
          contact: { contactID: config.xeroContactId, name: config.contactName },
          status: 'AUTHORISED' as const,
          date: '',
          amountPaid: 0,
          total: 0,
          currencyCode: config.currencyCode || 'USD',
        },
        principal: 0,
        daysOverdue: 0,
        daysToCharge: 0,
        rate: config.annualRate / 100,
        interestAmount: r.shouldOwe,
        periodStart: asOfDate,
        periodEnd: asOfDate,
        alreadyCharged: r.previouslyCharged,
        netInterest: r.delta,
      }));

    // Track skipped/no-change items
    result.skipped = reconcileResult.results
      .filter(r => r.action === 'NoChange')
      .map(r => ({
        invoiceNumber: r.sourceInvoiceNumber,
        reason: 'No change needed - already reconciled',
      }));

    // Log summary
    clientLogger.info('Reconciliation complete', {
      totalShouldOwe: reconcileResult.totalShouldOwe,
      totalPreviouslyCharged: reconcileResult.totalPreviouslyCharged,
      netChange: reconcileResult.netChange,
      invoicesProcessed: reconcileResult.results.length,
      invoicesWithChanges: reconcileResult.results.filter(r => r.action !== 'NoChange').length,
    });

    // Update the config with last run info (if not dry run)
    if (!dryRun && reconcileResult.interestInvoiceId) {
      await updateConfigLastRun(config.id, asOfDate, reconcileResult.interestInvoiceId);
    }

    clientLogger.accrualComplete(config.contactName, result.totalInterest, result.calculations.length);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    clientLogger.error('Accrual failed', error instanceof Error ? error : new Error(errorMessage));
  }

  return result;
}

/**
 * Run accrual for all active clients
 */
export async function runAccrualForAllClients(
  configs: InterestConfig[],
  logger: Logger,
  dryRun: boolean = false,
  asOfDate: Date = new Date()
): Promise<AccrualResult[]> {
  const results: AccrualResult[] = [];

  for (const config of configs) {
    logger.info(`Processing client: ${config.contactName}`);
    const result = await runAccrualForClient(config, logger, dryRun, asOfDate);
    results.push(result);
  }

  return results;
}

/**
 * Summarize accrual results
 */
export function summarizeResults(results: AccrualResult[]): {
  clientsProcessed: number;
  invoicesCreated: number;
  totalInterest: number;
  errors: string[];
} {
  return {
    clientsProcessed: results.length,
    invoicesCreated: results.filter((r) => r.invoiceCreated).length,
    totalInterest: roundMoney(results.reduce((sum, r) => sum + r.totalInterest, 0)),
    errors: results.flatMap((r) => r.errors),
  };
}
