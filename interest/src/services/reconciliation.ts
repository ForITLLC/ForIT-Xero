import {
  InterestConfig,
  InterestLedgerEntry,
  XeroInvoice,
  ReconcileAction,
  ReconcileReason,
} from '../types';
import {
  getOverdueInvoices,
  getOrCreateInterestInvoice,
  moveToDraft,
  updateInvoiceLineItems,
  authorizeInvoice,
  canModifyInvoice,
  createCreditNote,
  createInvoice,
  isInvoiceVoided,
  addInvoiceHistoryNote,
  addCreditNoteHistoryNote,
} from './xero';
import {
  createLedgerEntry,
  getLatestLedgerEntryForInvoice,
  getCurrentChargedAmount,
} from './database';
import { parseXeroDate, daysOverdue, formatXeroDate } from '../utils/dates';
import { roundMoney } from '../utils/calculations';
import { calculateTimelineInterest } from '../utils/paymentTimeline';
import { Logger } from '../utils/logger';

export interface ReconciliationResult {
  sourceInvoiceId: string;
  sourceInvoiceNumber: string;
  shouldOwe: number;
  previouslyCharged: number;
  delta: number;
  action: ReconcileAction | 'NoChange';
  reason: ReconcileReason;
  interestInvoiceId?: string;
  creditNoteId?: string;
  error?: string;
}

/**
 * Calculate what SHOULD be owed for a single invoice based on PAYMENT TIMELINE
 *
 * CRITICAL: This uses historical payment dates, not current balance!
 * Interest is calculated for each period between payments at the balance during that period.
 *
 * Example: $100k invoice, $50k paid on Jul 1, $50k paid on Dec 1
 * - Period 1: Full $100k balance from due date to Jul 1
 * - Period 2: $50k balance from Jul 1 to Dec 1
 * - Period 3: $0 balance from Dec 1 to now
 */
export function calculateShouldOwe(
  invoice: XeroInvoice,
  config: InterestConfig,
  asOfDate: Date = new Date()
): { shouldOwe: number; daysOverdue: number; effectiveDays: number } {
  const dueDate = parseXeroDate(invoice.dueDate);
  const totalDaysOverdue = daysOverdue(dueDate, asOfDate);

  // Not overdue enough (within grace period)
  if (totalDaysOverdue < config.minDaysOverdue) {
    return { shouldOwe: 0, daysOverdue: totalDaysOverdue, effectiveDays: 0 };
  }

  // Use timeline-based calculation that accounts for payment dates
  const timelineResult = calculateTimelineInterest(invoice, config, asOfDate);

  return {
    shouldOwe: timelineResult.totalInterest,
    daysOverdue: timelineResult.totalDaysOverdue,
    effectiveDays: timelineResult.effectiveDaysCharged
  };
}

/**
 * Determine why the amount changed (for audit trail)
 */
function determineReason(
  previousEntry: InterestLedgerEntry | null,
  currentInvoice: XeroInvoice,
  shouldOwe: number,
  previouslyCharged: number
): ReconcileReason {
  if (!previousEntry) {
    return 'Initial';
  }

  const currentDueDate = parseXeroDate(currentInvoice.dueDate);
  const previousDueDate = previousEntry.sourceDueDate;

  // Check if due date changed
  if (currentDueDate.getTime() !== previousDueDate.getTime()) {
    return 'DueDateChanged';
  }

  // Check if principal changed (partial payment or invoice edit)
  if (Math.abs(currentInvoice.amountDue - previousEntry.sourceAmountDue) > 0.01) {
    // If amount decreased, likely a payment
    if (currentInvoice.amountDue < previousEntry.sourceAmountDue) {
      return 'PartialPayment';
    }
    return 'PrincipalChanged';
  }

  // Check if invoice was voided
  if (currentInvoice.status === 'VOIDED' || currentInvoice.status === 'DELETED') {
    return 'SourceVoided';
  }

  // Default - just daily accrual
  return 'DailyAccrual';
}

/**
 * Reconcile a single source invoice
 * Calculates what should be owed vs what has been charged, and fixes any discrepancy
 */
export async function reconcileInvoice(
  invoice: XeroInvoice,
  config: InterestConfig,
  interestInvoiceId: string,
  interestInvoiceNumber: string,
  logger: Logger,
  asOfDate: Date = new Date()
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    sourceInvoiceId: invoice.invoiceID,
    sourceInvoiceNumber: invoice.invoiceNumber,
    shouldOwe: 0,
    previouslyCharged: 0,
    delta: 0,
    action: 'NoChange',
    reason: 'Initial',
  };

  try {
    // Calculate what SHOULD be owed
    const { shouldOwe, daysOverdue: totalDaysOverdue } = calculateShouldOwe(invoice, config, asOfDate);
    result.shouldOwe = shouldOwe;

    // Get what HAS been charged
    const previouslyCharged = await getCurrentChargedAmount(invoice.invoiceID);
    result.previouslyCharged = previouslyCharged;

    // Calculate difference
    const delta = roundMoney(shouldOwe - previouslyCharged);
    result.delta = delta;

    // Get latest entry for reason detection
    const previousEntry = await getLatestLedgerEntryForInvoice(invoice.invoiceID);
    result.reason = determineReason(previousEntry, invoice, shouldOwe, previouslyCharged);

    // If source invoice is voided, shouldOwe becomes 0
    if (invoice.status === 'VOIDED' || invoice.status === 'DELETED') {
      result.shouldOwe = 0;
      result.delta = -previouslyCharged;
      result.reason = 'SourceVoided';
    }

    // No change needed
    if (Math.abs(delta) < 0.01) {
      result.action = 'NoChange';
      return result;
    }

    // Create ledger entry for this reconciliation
    const periodMonth = `${asOfDate.getFullYear()}-${String(asOfDate.getMonth() + 1).padStart(2, '0')}`;
    const ledgerEntry: Omit<InterestLedgerEntry, 'id' | 'created'> = {
      sourceInvoiceId: invoice.invoiceID,
      sourceInvoiceNumber: invoice.invoiceNumber,
      interestInvoiceId: interestInvoiceId,
      interestInvoiceNumber: interestInvoiceNumber,
      chargeMonth: periodMonth,
      action: 'Updated', // Will be set properly below
      previousAmount: previouslyCharged,
      newAmount: shouldOwe,
      delta: delta,
      reason: result.reason,
      sourceDueDate: parseXeroDate(invoice.dueDate),
      sourceAmountDue: invoice.amountDue,
      daysOverdue: totalDaysOverdue,
      rate: config.annualRate / 100,
      contactId: config.xeroContactId,
      contactName: config.contactName,
    };

    if (delta > 0) {
      // Need to charge MORE
      ledgerEntry.action = previouslyCharged === 0 ? 'Created' : 'Updated';
      result.action = ledgerEntry.action;
      result.interestInvoiceId = interestInvoiceId;
    } else {
      // Need to charge LESS (credit)
      ledgerEntry.action = shouldOwe === 0 ? 'Credited' : 'Updated';
      result.action = ledgerEntry.action;
    }

    // Log the entry
    await createLedgerEntry(ledgerEntry);

    logger.info(`Reconciled ${invoice.invoiceNumber}`, {
      action: result.action,
      previouslyCharged,
      shouldOwe,
      delta,
      reason: result.reason,
    });

    return result;

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to reconcile ${invoice.invoiceNumber}`, error instanceof Error ? error : new Error(result.error));
    return result;
  }
}

/**
 * Build line items for interest invoice from reconciliation results
 */
export function buildLineItems(
  results: ReconciliationResult[],
  config: InterestConfig
): Array<{
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
}> {
  // Include ALL items with shouldOwe > 0 - we're replacing the entire invoice
  // The ledger tracks changes, but the invoice itself needs full amounts
  // Note: Xero API expects lowercase property names
  const lineItems = results
    .filter(r => r.shouldOwe > 0)
    .map(r => ({
      description: `Interest on ${r.sourceInvoiceNumber} @ ${config.annualRate}% p.a.`,
      quantity: 1,
      unitAmount: r.shouldOwe,
      accountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
      taxType: 'NONE',
    }));

  // If no line items, add a zero placeholder
  if (lineItems.length === 0) {
    return [{
      description: 'No interest charges this period',
      quantity: 1,
      unitAmount: 0,
      accountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
      taxType: 'NONE',
    }];
  }

  return lineItems;
}

/**
 * Run full reconciliation for a client
 * This is the main entry point for the self-correcting system
 *
 * @param dryRun If true, calculates what would happen without making changes
 */
export async function runReconciliation(
  config: InterestConfig,
  logger: Logger,
  asOfDate: Date = new Date(),
  dryRun: boolean = false
): Promise<{
  results: ReconciliationResult[];
  interestInvoiceId: string;
  interestInvoiceNumber: string;
  totalShouldOwe: number;
  totalPreviouslyCharged: number;
  netChange: number;
  creditNoteId?: string;
  creditNoteNumber?: string;
}> {
  // Get current month for invoice grouping
  const periodMonth = `${asOfDate.getFullYear()}-${String(asOfDate.getMonth() + 1).padStart(2, '0')}`;

  logger.info(`Running reconciliation for ${config.contactName}`, { periodMonth, dryRun });

  // Get all overdue invoices (always needed for calculations)
  const overdueInvoices = await getOverdueInvoices(
    config.xeroContactId,
    config.minDaysOverdue,
    config.currencyCode
  );

  logger.info(`Found ${overdueInvoices.length} overdue invoices`);

  // Calculate what should be owed for each invoice
  // NOTE: getOverdueInvoices now returns full invoice details WITH payments (optimized batch fetch)
  const results: ReconciliationResult[] = [];
  for (const invoice of overdueInvoices) {
    logger.info(`Processing ${invoice.invoiceNumber}`, {
      total: invoice.total,
      amountDue: invoice.amountDue,
      paymentsCount: invoice.payments?.length || 0,
      creditNotesCount: invoice.creditNotes?.length || 0,
    });

    const { shouldOwe, daysOverdue: totalDaysOverdue } = calculateShouldOwe(invoice, config, asOfDate);

    // Get what the ledger says we charged
    let previouslyCharged = await getCurrentChargedAmount(invoice.invoiceID);

    // CRITICAL: Verify the interest invoice still exists and isn't voided
    // If the interest invoice was voided, treat as if nothing was charged
    const previousEntry = await getLatestLedgerEntryForInvoice(invoice.invoiceID);
    logger.info(`Checking voided status for ${invoice.invoiceNumber}`, {
      hasPreviousEntry: !!previousEntry,
      interestInvoiceId: previousEntry?.interestInvoiceId,
    });
    if (previousEntry && previousEntry.interestInvoiceId) {
      const interestInvoiceVoided = await isInvoiceVoided(previousEntry.interestInvoiceId);
      logger.info(`Voided check result for ${invoice.invoiceNumber}`, { interestInvoiceVoided });
      if (interestInvoiceVoided) {
        logger.info(`Interest invoice ${previousEntry.interestInvoiceNumber} was voided - resetting charged amount`, {
          sourceInvoice: invoice.invoiceNumber,
          previouslyCharged,
        });
        previouslyCharged = 0;
      }
    }

    const delta = roundMoney(shouldOwe - previouslyCharged);

    // Determine reason for change (previousEntry already fetched above)
    const reason = previousEntry ? determineReason(previousEntry, invoice, shouldOwe, previouslyCharged) : 'Initial';

    let action: ReconcileAction | 'NoChange' = 'NoChange';
    if (Math.abs(delta) >= 0.01) {
      if (delta > 0) {
        action = previouslyCharged === 0 ? 'Created' : 'Updated';
      } else {
        action = shouldOwe === 0 ? 'Credited' : 'Updated';
      }
    }

    results.push({
      sourceInvoiceId: invoice.invoiceID,
      sourceInvoiceNumber: invoice.invoiceNumber,
      shouldOwe,
      previouslyCharged,
      delta,
      action,
      reason,
    });
  }

  // Calculate totals
  const totalShouldOwe = roundMoney(results.reduce((sum, r) => sum + r.shouldOwe, 0));
  const totalPreviouslyCharged = roundMoney(results.reduce((sum, r) => sum + r.previouslyCharged, 0));
  const netChange = roundMoney(totalShouldOwe - totalPreviouslyCharged);

  // In dry run mode, return what WOULD happen without making changes
  if (dryRun) {
    logger.info('DRY RUN - no changes made', {
      totalShouldOwe,
      totalPreviouslyCharged,
      netChange,
      invoicesWithChanges: results.filter(r => r.action !== 'NoChange').length,
    });

    return {
      results,
      interestInvoiceId: 'DRY_RUN',
      interestInvoiceNumber: 'DRY_RUN',
      totalShouldOwe,
      totalPreviouslyCharged,
      netChange,
    };
  }

  // ===== LIVE MODE - Actually make changes =====

  // Get or create the interest invoice for this period
  // For legacy reconciliation, use asOfDate as invoice date and +30 days for due date
  const legacyDueDate = new Date(asOfDate);
  legacyDueDate.setDate(legacyDueDate.getDate() + 30);

  const { invoiceId: interestInvoiceId, invoiceNumber: interestInvoiceNumber, isNew } =
    await getOrCreateInterestInvoice(
      config.xeroContactId,
      config.contactName,
      periodMonth,
      asOfDate, // Use asOfDate as invoice date for legacy reconciliation
      legacyDueDate,
      config.currencyCode
    );

  logger.info(`Interest invoice: ${interestInvoiceNumber}`, { isNew });

  // Log ledger entries for each invoice that changed
  for (const result of results) {
    if (result.action === 'NoChange') continue;

    const invoice = overdueInvoices.find(i => i.invoiceID === result.sourceInvoiceId)!;
    const previousEntry = await getLatestLedgerEntryForInvoice(result.sourceInvoiceId);

    await createLedgerEntry({
      sourceInvoiceId: result.sourceInvoiceId,
      sourceInvoiceNumber: result.sourceInvoiceNumber,
      interestInvoiceId: interestInvoiceId,
      interestInvoiceNumber: interestInvoiceNumber,
      chargeMonth: periodMonth,
      action: result.action as ReconcileAction,
      previousAmount: result.previouslyCharged,
      newAmount: result.shouldOwe,
      delta: result.delta,
      reason: result.reason,
      sourceDueDate: parseXeroDate(invoice.dueDate),
      sourceAmountDue: invoice.amountDue,
      daysOverdue: calculateShouldOwe(invoice, config, asOfDate).daysOverdue,
      rate: config.annualRate / 100,
      contactId: config.xeroContactId,
      contactName: config.contactName,
    });

    logger.info(`Logged ${result.action} for ${result.sourceInvoiceNumber}`, {
      delta: result.delta,
      reason: result.reason,
    });
  }

  // Check if we can modify the interest invoice
  const { canModify, status, isPaid } = await canModifyInvoice(interestInvoiceId);

  let creditNoteId: string | undefined;
  let creditNoteNumber: string | undefined;
  let finalInterestInvoiceId = interestInvoiceId;
  let finalInterestInvoiceNumber = interestInvoiceNumber;

  if (canModify) {
    try {
      // Move to draft if needed
      if (status !== 'DRAFT') {
        await moveToDraft(interestInvoiceId);
      }

      // Update line items
      const lineItems = buildLineItems(results, config);
      await updateInvoiceLineItems(interestInvoiceId, lineItems);

      logger.info(`Updated interest invoice ${interestInvoiceNumber}`, { totalShouldOwe });
    } catch (updateError) {
      // If update fails, create a new invoice instead
      logger.warn(`Failed to update interest invoice ${interestInvoiceNumber}, creating new one`, {
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });

      const lineItems = buildLineItems(results, config);
      const newInvoice = await createInvoice({
        Type: 'ACCREC',
        Contact: { ContactID: config.xeroContactId },
        Date: formatXeroDate(asOfDate),
        DueDate: formatXeroDate(legacyDueDate),
        Reference: `[FORIT-INT] Interest Charges - ${periodMonth}`,
        Status: 'AUTHORISED',
        LineItems: lineItems.map(li => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitAmount,
          AccountCode: li.accountCode,
          TaxType: li.taxType,
        })),
        CurrencyCode: config.currencyCode,
      });

      finalInterestInvoiceId = newInvoice.invoiceId;
      finalInterestInvoiceNumber = newInvoice.invoiceNumber;

      // Add history note explaining why this invoice was created
      await addInvoiceHistoryNote(
        newInvoice.invoiceId,
        `Replacement for ${interestInvoiceNumber} - original invoice could not be modified`
      );

      logger.info(`Created new interest invoice ${finalInterestInvoiceNumber}`, { totalShouldOwe });
    }

  } else if (isPaid && netChange < 0) {
    // Invoice is paid and we owe them money - create credit note
    const creditResult = await createCreditNote({
      Type: 'ACCRECCREDIT',
      Contact: { ContactID: config.xeroContactId },
      Date: formatXeroDate(asOfDate),
      Reference: `[FORIT-INT] Interest Charges - ${periodMonth}`,
      Status: 'AUTHORISED',
      LineItems: [{
        Description: `Interest adjustment for ${config.contactName}`,
        Quantity: 1,
        UnitAmount: Math.abs(netChange),
        AccountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
        TaxType: 'NONE',
      }],
    });

    creditNoteId = creditResult.creditNoteId;
    creditNoteNumber = creditResult.creditNoteNumber;

    // Add history note explaining the credit
    await addCreditNoteHistoryNote(
      creditResult.creditNoteId,
      `Credit for overpaid interest on ${interestInvoiceNumber} - recalculation reduced amount by $${Math.abs(netChange).toFixed(2)}`
    );

    logger.info(`Created credit note ${creditNoteNumber} for $${Math.abs(netChange)}`);

  } else if (isPaid && netChange > 0) {
    // Invoice is paid but we need to charge more - create additional invoice
    const additionalResult = await createInvoice({
      Type: 'ACCREC',
      Contact: { ContactID: config.xeroContactId },
      Date: formatXeroDate(asOfDate),
      DueDate: formatXeroDate(new Date(asOfDate.getTime() + 14 * 24 * 60 * 60 * 1000)),
      Reference: `[FORIT-INT] Interest Charges - ${periodMonth}`,
      Status: 'AUTHORISED',
      LineItems: [{
        Description: `Additional interest charges for ${config.contactName}`,
        Quantity: 1,
        UnitAmount: netChange,
        AccountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
        TaxType: 'NONE',
      }],
    });

    // Add history note explaining why additional invoice was needed
    await addInvoiceHistoryNote(
      additionalResult.invoiceId,
      `Additional charges for ${periodMonth} - ${interestInvoiceNumber} was already paid, recalculation increased amount by $${netChange.toFixed(2)}`
    );

    logger.info(`Created additional invoice ${additionalResult.invoiceNumber} for $${netChange}`);
  }

  return {
    results,
    interestInvoiceId: finalInterestInvoiceId,
    interestInvoiceNumber: finalInterestInvoiceNumber,
    totalShouldOwe,
    totalPreviouslyCharged,
    netChange,
    creditNoteId,
    creditNoteNumber,
  };
}
