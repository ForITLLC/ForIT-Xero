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
  updateInvoiceDates,
  authorizeInvoice,
  canModifyInvoice,
  createCreditNote,
  createInvoice,
  isInvoiceVoided,
  getOrCreateInterestItem,
  addInvoiceHistoryNote,
  addCreditNoteHistoryNote,
} from './xero';
import {
  createLedgerEntry,
  getChargedAmountForMonth,
  getLatestLedgerEntryForMonth,
} from './database';
import { parseXeroDate, formatXeroDate } from '../utils/dates';
import { roundMoney } from '../utils/calculations';
import { Logger } from '../utils/logger';

// Rate limiting - Xero allows 60 requests/minute
const XERO_RATE_LIMIT_DELAY_MS = 1100; // ~55 requests/minute to be safe
let lastXeroCall = 0;

async function rateLimitedCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const timeSinceLastCall = now - lastXeroCall;
  if (timeSinceLastCall < XERO_RATE_LIMIT_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, XERO_RATE_LIMIT_DELAY_MS - timeSinceLastCall));
  }
  lastXeroCall = Date.now();
  return fn();
}

// Cache for voided invoice checks to avoid repeated API calls
const voidedInvoiceCache = new Map<string, boolean>();

export interface MonthlyResult {
  chargeMonth: string;
  invoiceNumber: string;
  invoiceId: string;
  totalInterest: number;
  lineItems: number;
  isNew: boolean;
}

export interface MonthlyReconciliationResult {
  sourceInvoiceId: string;
  sourceInvoiceNumber: string;
  chargeMonth: string;
  shouldOwe: number;
  previouslyCharged: number;
  delta: number;
  action: ReconcileAction | 'NoChange';
  reason: ReconcileReason;
}

/**
 * Get all months from a start date to end date
 */
export function getMonthsBetween(startDate: Date, endDate: Date): string[] {
  const months: string[] = [];
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

  while (current <= end) {
    const year = current.getFullYear();
    const month = String(current.getMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
    current.setMonth(current.getMonth() + 1);
  }

  return months;
}

/**
 * Get the first and last day of a month
 */
export function getMonthBounds(chargeMonth: string): { start: Date; end: Date } {
  const [year, month] = chargeMonth.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0); // Last day of month
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * Calculate days overdue within a specific month
 * Returns the number of days the invoice was overdue during that month
 */
export function getDaysOverdueInMonth(
  dueDate: Date,
  gracePeriodDays: number,
  chargeMonth: string
): number {
  const { start: monthStart, end: monthEnd } = getMonthBounds(chargeMonth);

  // The date when interest starts accruing (due date + grace period)
  const interestStartDate = new Date(dueDate);
  interestStartDate.setDate(interestStartDate.getDate() + gracePeriodDays);

  // If interest hasn't started by the end of this month, no days
  if (interestStartDate > monthEnd) {
    return 0;
  }

  // Calculate the effective start of interest for this month
  const effectiveStart = interestStartDate > monthStart ? interestStartDate : monthStart;

  // Calculate days in this month
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.floor((monthEnd.getTime() - effectiveStart.getTime()) / msPerDay) + 1;

  return Math.max(0, days);
}

/**
 * Calculate interest for a specific month only
 */
export function calculateMonthlyInterest(
  invoice: XeroInvoice,
  config: InterestConfig,
  chargeMonth: string
): { interest: number; daysInMonth: number } {
  const dueDate = parseXeroDate(invoice.dueDate);
  const daysInMonth = getDaysOverdueInMonth(dueDate, config.minDaysOverdue, chargeMonth);

  if (daysInMonth <= 0) {
    return { interest: 0, daysInMonth: 0 };
  }

  const principal = invoice.amountDue;
  if (principal <= 0) {
    return { interest: 0, daysInMonth };
  }

  const rate = config.annualRate / 100;
  const dailyRate = rate / 365;
  const interest = roundMoney(principal * dailyRate * daysInMonth);

  return { interest, daysInMonth };
}

/**
 * Find the earliest date an invoice became eligible for interest
 */
export function getEarliestInterestDate(
  invoices: XeroInvoice[],
  gracePeriodDays: number
): Date | null {
  let earliest: Date | null = null;

  for (const invoice of invoices) {
    const dueDate = parseXeroDate(invoice.dueDate);
    const interestStartDate = new Date(dueDate);
    interestStartDate.setDate(interestStartDate.getDate() + gracePeriodDays);

    if (!earliest || interestStartDate < earliest) {
      earliest = interestStartDate;
    }
  }

  return earliest;
}

/**
 * Calculate the invoice date for a given month
 * Invoice date = last day of the charge month (when interest was "earned")
 */
export function calculateInvoiceDateForMonth(chargeMonth: string): Date {
  const { end: monthEnd } = getMonthBounds(chargeMonth);
  // Return just the date part (midnight)
  return new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate());
}

/**
 * Calculate the due date for an interest invoice
 * Due date = invoice date + 30 days
 */
export function calculateDueDateForInvoice(invoiceDate: Date): Date {
  const dueDate = new Date(invoiceDate);
  dueDate.setDate(dueDate.getDate() + 30);
  return dueDate;
}

/**
 * Run monthly reconciliation for a client
 * Creates/updates one interest invoice per month, backfilling as needed
 */
export async function runMonthlyReconciliation(
  config: InterestConfig,
  logger: Logger,
  asOfDate: Date = new Date(),
  dryRun: boolean = false
): Promise<{
  monthlyResults: MonthlyResult[];
  detailedResults: MonthlyReconciliationResult[];
  totalInterest: number;
}> {
  logger.info(`Running monthly reconciliation for ${config.contactName}`, { dryRun });

  // Get all overdue invoices
  const overdueInvoices = await getOverdueInvoices(
    config.xeroContactId,
    config.minDaysOverdue,
    config.currencyCode
  );

  logger.info(`Found ${overdueInvoices.length} overdue invoices`);

  if (overdueInvoices.length === 0) {
    return { monthlyResults: [], detailedResults: [], totalInterest: 0 };
  }

  // Find the earliest interest start date
  const earliestDate = getEarliestInterestDate(overdueInvoices, config.minDaysOverdue);
  if (!earliestDate) {
    return { monthlyResults: [], detailedResults: [], totalInterest: 0 };
  }

  // Get all months that need processing
  const monthsToProcess = getMonthsBetween(earliestDate, asOfDate);
  logger.info(`Processing ${monthsToProcess.length} months: ${monthsToProcess[0]} to ${monthsToProcess[monthsToProcess.length - 1]}`);

  const monthlyResults: MonthlyResult[] = [];
  const detailedResults: MonthlyReconciliationResult[] = [];
  let totalInterest = 0;

  // Process each month
  for (const chargeMonth of monthsToProcess) {
    const monthResults: MonthlyReconciliationResult[] = [];
    let monthTotal = 0;

    // Calculate interest for each invoice for this month
    for (const invoice of overdueInvoices) {
      const { interest: shouldOwe, daysInMonth } = calculateMonthlyInterest(invoice, config, chargeMonth);

      // Skip if no interest for this month
      if (shouldOwe <= 0 && daysInMonth <= 0) {
        continue;
      }

      // Get what we've already charged for this invoice/month
      let previouslyCharged = await getChargedAmountForMonth(invoice.invoiceID, chargeMonth);

      // Check if the interest invoice was voided (with caching to avoid repeated API calls)
      const previousEntry = await getLatestLedgerEntryForMonth(invoice.invoiceID, chargeMonth);
      if (previousEntry && previousEntry.interestInvoiceId) {
        let isVoided: boolean;
        if (voidedInvoiceCache.has(previousEntry.interestInvoiceId)) {
          isVoided = voidedInvoiceCache.get(previousEntry.interestInvoiceId)!;
        } else {
          isVoided = await rateLimitedCall(() => isInvoiceVoided(previousEntry.interestInvoiceId));
          voidedInvoiceCache.set(previousEntry.interestInvoiceId, isVoided);
        }
        if (isVoided) {
          logger.info(`Interest invoice for ${chargeMonth} was voided - resetting`, {
            sourceInvoice: invoice.invoiceNumber,
          });
          previouslyCharged = 0;
        }
      }

      const delta = roundMoney(shouldOwe - previouslyCharged);

      let action: ReconcileAction | 'NoChange' = 'NoChange';
      let reason: ReconcileReason = 'DailyAccrual';

      if (Math.abs(delta) >= 0.01) {
        if (delta > 0) {
          action = previouslyCharged === 0 ? 'Created' : 'Updated';
          reason = previouslyCharged === 0 ? 'Initial' : 'DailyAccrual';
        } else {
          action = shouldOwe === 0 ? 'Credited' : 'Updated';
          reason = 'PartialPayment';
        }
      }

      if (shouldOwe > 0 || action !== 'NoChange') {
        monthResults.push({
          sourceInvoiceId: invoice.invoiceID,
          sourceInvoiceNumber: invoice.invoiceNumber,
          chargeMonth,
          shouldOwe,
          previouslyCharged,
          delta,
          action,
          reason,
        });
      }

      if (shouldOwe > 0) {
        monthTotal += shouldOwe;
      }
    }

    // Skip months with no interest
    if (monthTotal <= 0 && monthResults.every(r => r.action === 'NoChange')) {
      continue;
    }

    totalInterest += monthTotal;
    detailedResults.push(...monthResults);

    if (dryRun) {
      monthlyResults.push({
        chargeMonth,
        invoiceNumber: 'DRY_RUN',
        invoiceId: 'DRY_RUN',
        totalInterest: monthTotal,
        lineItems: monthResults.filter(r => r.shouldOwe > 0).length,
        isNew: false,
      });
      continue;
    }

    // ===== LIVE MODE =====

    // Invoice date = last day of charge month, due date = +30 days
    const invoiceDate = calculateInvoiceDateForMonth(chargeMonth);
    const dueDate = calculateDueDateForInvoice(invoiceDate);
    logger.info(`Invoice date for ${chargeMonth}: ${invoiceDate.toISOString().split('T')[0]}, due: ${dueDate.toISOString().split('T')[0]}`);

    // Get or create the INTEREST item
    const accountCode = process.env.INTEREST_ACCOUNT_CODE || '4010';
    const { itemCode } = await rateLimitedCall(() => getOrCreateInterestItem(accountCode));

    // Get or create the interest invoice for this month
    const { invoiceId, invoiceNumber, isNew } = await rateLimitedCall(() =>
      getOrCreateInterestInvoice(
        config.xeroContactId,
        config.contactName,
        chargeMonth,
        invoiceDate,
        dueDate,
        config.currencyCode
      )
    );

    logger.info(`Interest invoice for ${chargeMonth}: ${invoiceNumber}`, { isNew });

    // Create ledger entries for changes
    for (const result of monthResults) {
      if (result.action === 'NoChange') continue;

      const invoice = overdueInvoices.find(i => i.invoiceID === result.sourceInvoiceId)!;
      const { daysInMonth } = calculateMonthlyInterest(invoice, config, chargeMonth);

      await createLedgerEntry({
        sourceInvoiceId: result.sourceInvoiceId,
        sourceInvoiceNumber: result.sourceInvoiceNumber,
        interestInvoiceId: invoiceId,
        interestInvoiceNumber: invoiceNumber,
        chargeMonth,
        action: result.action as ReconcileAction,
        previousAmount: result.previouslyCharged,
        newAmount: result.shouldOwe,
        delta: result.delta,
        reason: result.reason,
        sourceDueDate: parseXeroDate(invoice.dueDate),
        sourceAmountDue: invoice.amountDue,
        daysOverdue: daysInMonth,
        rate: config.annualRate / 100,
        contactId: config.xeroContactId,
        contactName: config.contactName,
      });
    }

    // Update the invoice
    const { canModify, status, isPaid } = await rateLimitedCall(() => canModifyInvoice(invoiceId));
    const netChange = roundMoney(monthResults.reduce((sum, r) => sum + r.delta, 0));

    if (canModify) {
      // Build line items for this month with proper itemCode (if available)
      const lineItems = monthResults
        .filter(r => r.shouldOwe > 0)
        .map(r => {
          const item: any = {
            description: `Interest on ${r.sourceInvoiceNumber} @ ${config.annualRate}% p.a. (${chargeMonth})`,
            quantity: 1,
            unitAmount: r.shouldOwe,
            accountCode: accountCode,
            taxType: 'NONE',
          };
          if (itemCode) {
            item.itemCode = itemCode;
          }
          return item;
        });

      if (lineItems.length === 0) {
        const emptyItem: any = {
          description: `No interest charges for ${chargeMonth}`,
          quantity: 1,
          unitAmount: 0,
          accountCode: accountCode,
          taxType: 'NONE',
        };
        if (itemCode) {
          emptyItem.itemCode = itemCode;
        }
        lineItems.push(emptyItem);
      }

      try {
        if (status !== 'DRAFT') {
          await rateLimitedCall(() => moveToDraft(invoiceId));
        }

        // Always update dates to ensure they match the charge month
        await rateLimitedCall(() => updateInvoiceDates(invoiceId, invoiceDate, dueDate));
        logger.info(`Updated invoice dates for ${invoiceNumber}`, {
          date: invoiceDate.toISOString().split('T')[0],
          dueDate: dueDate.toISOString().split('T')[0],
        });

        await rateLimitedCall(() => updateInvoiceLineItems(invoiceId, lineItems));

        // Authorize the invoice (move from DRAFT to AUTHORISED)
        await rateLimitedCall(() => authorizeInvoice(invoiceId));
        logger.info(`Authorized ${invoiceNumber} with ${lineItems.length} line items`, { total: monthTotal });
      } catch (updateError) {
        // If update fails, create a new invoice instead
        logger.warn(`Failed to update invoice ${invoiceNumber} for ${chargeMonth}, creating new one`, {
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });

        // Build line items for the new invoice (without ItemCode to avoid serialization issues)
        const newLineItems = lineItems.map(li => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitAmount,
          AccountCode: li.accountCode,
          TaxType: li.taxType,
        }));

        logger.info(`Creating new invoice with ${newLineItems.length} line items`, {
          chargeMonth,
          lineItems: newLineItems,
        });

        const newInvoice = await rateLimitedCall(() => createInvoice({
          Type: 'ACCREC',
          Contact: { ContactID: config.xeroContactId },
          Date: formatXeroDate(invoiceDate),
          DueDate: formatXeroDate(dueDate),
          Reference: `[FORIT-INT] Interest Charges - ${chargeMonth}`,
          Status: 'AUTHORISED',
          LineItems: newLineItems,
          CurrencyCode: config.currencyCode,
        }));

        // Add history note explaining why this invoice was created
        await rateLimitedCall(() => addInvoiceHistoryNote(
          newInvoice.invoiceId,
          `Replacement for ${invoiceNumber} - original invoice could not be modified`
        ));

        logger.info(`Created replacement invoice ${newInvoice.invoiceNumber} for ${chargeMonth}`, {
          total: monthTotal,
          lineItems: lineItems.length,
        });

        // Update the monthlyResults to reference the new invoice
        monthlyResults.push({
          chargeMonth,
          invoiceNumber: newInvoice.invoiceNumber,
          invoiceId: newInvoice.invoiceId,
          totalInterest: monthTotal,
          lineItems: lineItems.length,
          isNew: true,
        });
        continue; // Skip the normal monthlyResults.push at the end
      }

    } else if (isPaid && netChange < 0) {
      // Create credit note
      const creditResult = await rateLimitedCall(() => createCreditNote({
        Type: 'ACCRECCREDIT',
        Contact: { ContactID: config.xeroContactId },
        Date: formatXeroDate(asOfDate),
        Reference: `[FORIT-INT] Interest Charges - ${chargeMonth}`,
        Status: 'AUTHORISED',
        LineItems: [{
          Description: `Interest adjustment for ${config.contactName} (${chargeMonth})`,
          Quantity: 1,
          UnitAmount: Math.abs(netChange),
          AccountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
          TaxType: 'NONE',
        }],
      }));

      // Add history note explaining the credit
      await rateLimitedCall(() => addCreditNoteHistoryNote(
        creditResult.creditNoteId,
        `Credit for overpaid interest on ${invoiceNumber} - recalculation reduced amount by $${Math.abs(netChange).toFixed(2)}`
      ));

      logger.info(`Created credit note ${creditResult.creditNoteNumber} for ${chargeMonth}`);

    } else if (isPaid && netChange > 0) {
      // Create additional invoice
      const additionalResult = await rateLimitedCall(() => createInvoice({
        Type: 'ACCREC',
        Contact: { ContactID: config.xeroContactId },
        Date: formatXeroDate(asOfDate),
        DueDate: formatXeroDate(new Date(asOfDate.getTime() + 14 * 24 * 60 * 60 * 1000)),
        Reference: `[FORIT-INT] Interest Charges - ${chargeMonth}`,
        Status: 'AUTHORISED',
        LineItems: [{
          Description: `Additional interest charges for ${config.contactName} (${chargeMonth})`,
          Quantity: 1,
          UnitAmount: netChange,
          AccountCode: process.env.INTEREST_ACCOUNT_CODE || '4010',
          TaxType: 'NONE',
        }],
      }));

      // Add history note explaining why additional invoice was needed
      await rateLimitedCall(() => addInvoiceHistoryNote(
        additionalResult.invoiceId,
        `Additional charges for ${chargeMonth} - ${invoiceNumber} was already paid, recalculation increased amount by $${netChange.toFixed(2)}`
      ));

      logger.info(`Created additional invoice ${additionalResult.invoiceNumber} for ${chargeMonth}`);
    }

    monthlyResults.push({
      chargeMonth,
      invoiceNumber,
      invoiceId,
      totalInterest: monthTotal,
      lineItems: monthResults.filter(r => r.shouldOwe > 0).length,
      isNew,
    });
  }

  logger.info(`Monthly reconciliation complete`, {
    monthsProcessed: monthlyResults.length,
    totalInterest,
    dryRun,
  });

  return { monthlyResults, detailedResults, totalInterest };
}
