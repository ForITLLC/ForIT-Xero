/**
 * Legacy reconcile service - now delegates to reconciliation.ts
 * Kept for backwards compatibility with existing code
 */

import { InterestLedgerEntry, ReconcileResult } from '../types';
import { Logger } from '../utils/logger';

// Re-export from new reconciliation service
export { runReconciliation, reconcileInvoice, calculateShouldOwe } from './reconciliation';

/**
 * Legacy function - reconcile voided invoices
 * Now handled automatically by the self-correcting reconciliation system
 */
export async function reconcileVoidedInvoices(logger: Logger): Promise<ReconcileResult> {
  logger.info('reconcileVoidedInvoices is deprecated - voided invoices are now handled automatically by the reconciliation system');

  return {
    voidedSourceInvoices: [],
    creditNotesCreated: [],
    ledgerEntriesUpdated: 0,
    errors: [],
  };
}

/**
 * Legacy function - credit a single ledger entry
 * Now handled automatically by the self-correcting reconciliation system
 */
export async function creditLedgerEntry(
  entryId: string,
  reason: string,
  logger: Logger
): Promise<{ creditNoteId: string; creditNoteNumber?: string }> {
  logger.info('creditLedgerEntry is deprecated - credits are now handled automatically by the reconciliation system');

  throw new Error('creditLedgerEntry is deprecated. Use the reconciliation system instead.');
}
