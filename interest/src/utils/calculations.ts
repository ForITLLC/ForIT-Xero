import { XeroInvoice, InterestConfig, InterestCalculation } from '../types';
import { daysOverdue, parseXeroDate } from './dates';

/**
 * Calculate interest for a single invoice (simplified version)
 * Main calculation logic is now in reconciliation.ts
 *
 * Formula: Principal × (AnnualRate / 365) × EffectiveDaysOverdue
 */
export function calculateInterest(
  invoice: XeroInvoice,
  config: InterestConfig,
  asOfDate: Date = new Date()
): InterestCalculation | null {
  const dueDate = parseXeroDate(invoice.dueDate);
  const totalDaysOverdue = daysOverdue(dueDate, asOfDate);

  // Not overdue enough (within grace period)
  if (totalDaysOverdue < config.minDaysOverdue) {
    return null;
  }

  // Calculate effective days (after grace period)
  const effectiveDaysOverdue = totalDaysOverdue - config.minDaysOverdue;
  if (effectiveDaysOverdue <= 0) {
    return null;
  }

  // Principal is the amount due (accounts for partial payments)
  const principal = invoice.amountDue;
  if (principal <= 0) {
    return null;
  }

  // Calculate interest
  const rate = config.annualRate / 100; // Convert 24 to 0.24
  const dailyRate = rate / 365;
  const interestAmount = roundMoney(principal * dailyRate * effectiveDaysOverdue);

  return {
    sourceInvoice: invoice,
    principal,
    daysOverdue: totalDaysOverdue,
    daysToCharge: effectiveDaysOverdue,
    rate,
    interestAmount,
    periodStart: dueDate,
    periodEnd: asOfDate,
    alreadyCharged: 0,
    netInterest: interestAmount,
  };
}

/**
 * Round to 2 decimal places (standard money rounding)
 */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Check if an amount meets the minimum charge threshold
 */
export function meetsMinimum(amount: number, minimum: number): boolean {
  return roundMoney(amount) >= minimum;
}

/**
 * Calculate interest for multiple invoices (simplified - no ledger dedup)
 * The reconciliation system handles deduplication through the ledger
 */
export function calculateBatchInterest(
  invoices: XeroInvoice[],
  config: InterestConfig,
  asOfDate: Date = new Date()
): {
  calculations: InterestCalculation[];
  totalInterest: number;
  skipped: Array<{ invoiceNumber: string; reason: string }>;
} {
  const calculations: InterestCalculation[] = [];
  const skipped: Array<{ invoiceNumber: string; reason: string }> = [];

  for (const invoice of invoices) {
    // Skip voided or paid invoices
    if (invoice.status === 'VOIDED' || invoice.status === 'DELETED') {
      skipped.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Invoice voided/deleted' });
      continue;
    }

    if (invoice.status === 'PAID') {
      skipped.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Invoice paid' });
      continue;
    }

    if (invoice.amountDue <= 0) {
      skipped.push({ invoiceNumber: invoice.invoiceNumber, reason: 'No amount due' });
      continue;
    }

    const calc = calculateInterest(invoice, config, asOfDate);

    if (!calc) {
      skipped.push({ invoiceNumber: invoice.invoiceNumber, reason: 'Within grace period' });
      continue;
    }

    if (!meetsMinimum(calc.netInterest, config.minChargeAmount)) {
      skipped.push({
        invoiceNumber: invoice.invoiceNumber,
        reason: `Interest $${calc.netInterest} below minimum $${config.minChargeAmount}`
      });
      continue;
    }

    calculations.push(calc);
  }

  const totalInterest = roundMoney(
    calculations.reduce((sum, c) => sum + c.netInterest, 0)
  );

  return { calculations, totalInterest, skipped };
}

/**
 * Build line item description for interest charge
 */
export function buildLineItemDescription(calc: InterestCalculation): string {
  const { sourceInvoice, daysToCharge, rate } = calc;
  const dueDate = parseXeroDate(sourceInvoice.dueDate);
  const dueDateStr = dueDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const ratePercent = (rate * 100).toFixed(1);

  return `Interest on ${sourceInvoice.invoiceNumber} (Due: ${dueDateStr}, ${daysToCharge} days @ ${ratePercent}%)`;
}
