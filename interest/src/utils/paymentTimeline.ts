import { XeroInvoice, XeroPayment, XeroCreditNote, InterestConfig } from '../types';
import { parseXeroDate } from './dates';
import { roundMoney } from './calculations';

/**
 * A period during which the invoice had a specific balance
 */
export interface BalancePeriod {
  startDate: Date;
  endDate: Date;
  balance: number;
  daysInPeriod: number;
  daysAfterGrace: number;  // Days that count for interest (after grace period)
  interestForPeriod: number;
}

/**
 * Result of timeline-based interest calculation
 */
export interface TimelineInterestResult {
  periods: BalancePeriod[];
  totalInterest: number;
  totalDaysOverdue: number;
  effectiveDaysCharged: number;
}

/**
 * Build a payment timeline and calculate interest based on historical balances.
 *
 * This is the CORRECT way to calculate interest:
 * - For each period between payments, calculate interest on that period's balance
 * - Sum all period interests
 *
 * @param invoice The invoice with payments array populated
 * @param config Interest configuration (rate, grace period)
 * @param asOfDate Calculate interest up to this date
 */
export function calculateTimelineInterest(
  invoice: XeroInvoice,
  config: InterestConfig,
  asOfDate: Date = new Date()
): TimelineInterestResult {
  const dueDate = parseXeroDate(invoice.dueDate);
  const rate = config.annualRate / 100;
  const dailyRate = rate / 365;
  const gracePeriodDays = config.minDaysOverdue;

  // If not yet overdue, no interest
  if (asOfDate <= dueDate) {
    return { periods: [], totalInterest: 0, totalDaysOverdue: 0, effectiveDaysCharged: 0 };
  }

  // Collect all balance-changing events (payments and credit notes)
  const events: Array<{ date: Date; amount: number; type: 'payment' | 'credit' }> = [];

  // Add payments (Xero SDK returns lowercase property names)
  if (invoice.payments && invoice.payments.length > 0) {
    for (const payment of invoice.payments) {
      // Handle both PascalCase (types) and lowercase (actual SDK response)
      const paymentDate = parseXeroDate((payment as any).date || payment.Date);
      const paymentAmount = (payment as any).amount || payment.Amount;
      events.push({ date: paymentDate, amount: paymentAmount, type: 'payment' });
    }
  }

  // Add credit notes (Xero SDK returns lowercase property names)
  if (invoice.creditNotes && invoice.creditNotes.length > 0) {
    for (const cn of invoice.creditNotes) {
      // Handle both PascalCase (types) and lowercase (actual SDK response)
      const cnDate = parseXeroDate((cn as any).date || cn.Date);
      const cnAmount = (cn as any).appliedAmount || cn.AppliedAmount;
      events.push({ date: cnDate, amount: cnAmount, type: 'credit' });
    }
  }

  // Sort events by date (oldest first)
  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Build balance periods
  const periods: BalancePeriod[] = [];
  let currentBalance = invoice.total;  // Start with original invoice total
  let periodStart = dueDate;  // Interest starts accruing from due date

  // Grace period end date
  const graceEndDate = new Date(dueDate);
  graceEndDate.setDate(graceEndDate.getDate() + gracePeriodDays);

  for (const event of events) {
    // If event is before due date, adjust starting balance but don't create period
    if (event.date <= dueDate) {
      currentBalance -= event.amount;
      continue;
    }

    // Create period from periodStart to event date
    const periodEnd = event.date;

    if (periodEnd > periodStart && currentBalance > 0) {
      const period = createPeriod(
        periodStart,
        periodEnd,
        currentBalance,
        graceEndDate,
        dailyRate
      );
      if (period.daysInPeriod > 0) {
        periods.push(period);
      }
    }

    // Apply the payment/credit
    currentBalance -= event.amount;
    currentBalance = Math.max(0, currentBalance);  // Can't go negative
    periodStart = periodEnd;
  }

  // Final period: from last event (or due date) to asOfDate
  // NOTE: If there were no events, periodStart is still dueDate, so this creates the single period
  if (periodStart < asOfDate && currentBalance > 0) {
    const period = createPeriod(
      periodStart,
      asOfDate,
      currentBalance,
      graceEndDate,
      dailyRate
    );
    if (period.daysInPeriod > 0) {
      periods.push(period);
    }
  }

  // Calculate totals
  const totalInterest = roundMoney(periods.reduce((sum, p) => sum + p.interestForPeriod, 0));
  const totalDaysOverdue = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  const effectiveDaysCharged = periods.reduce((sum, p) => sum + p.daysAfterGrace, 0);

  return {
    periods,
    totalInterest,
    totalDaysOverdue,
    effectiveDaysCharged,
  };
}

/**
 * Create a balance period with interest calculation
 */
function createPeriod(
  startDate: Date,
  endDate: Date,
  balance: number,
  graceEndDate: Date,
  dailyRate: number
): BalancePeriod {
  const daysInPeriod = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

  // Calculate days after grace period within this period
  let daysAfterGrace = 0;

  if (endDate <= graceEndDate) {
    // Entire period is within grace period
    daysAfterGrace = 0;
  } else if (startDate >= graceEndDate) {
    // Entire period is after grace period
    daysAfterGrace = daysInPeriod;
  } else {
    // Period spans grace period end
    daysAfterGrace = Math.floor((endDate.getTime() - graceEndDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  const interestForPeriod = roundMoney(balance * dailyRate * daysAfterGrace);

  return {
    startDate,
    endDate,
    balance,
    daysInPeriod,
    daysAfterGrace,
    interestForPeriod,
  };
}

/**
 * Debug helper: format timeline for logging
 */
export function formatTimeline(result: TimelineInterestResult): string {
  const lines: string[] = [];
  lines.push(`Timeline Interest Calculation:`);
  lines.push(`  Total Days Overdue: ${result.totalDaysOverdue}`);
  lines.push(`  Effective Days Charged: ${result.effectiveDaysCharged}`);
  lines.push(`  Total Interest: $${result.totalInterest.toFixed(2)}`);
  lines.push(`  Periods:`);

  for (const period of result.periods) {
    lines.push(`    ${period.startDate.toISOString().split('T')[0]} → ${period.endDate.toISOString().split('T')[0]}`);
    lines.push(`      Balance: $${period.balance.toFixed(2)}, Days: ${period.daysInPeriod} (${period.daysAfterGrace} after grace)`);
    lines.push(`      Interest: $${period.interestForPeriod.toFixed(2)}`);
  }

  return lines.join('\n');
}
