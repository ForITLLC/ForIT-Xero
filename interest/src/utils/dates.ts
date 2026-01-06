/**
 * Date utility functions for interest calculations
 */

/**
 * Calculate days between two dates (end - start)
 */
export function daysBetween(start: Date, end: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUtc - startUtc) / msPerDay);
}

/**
 * Get days overdue for an invoice
 * @param dueDate Invoice due date
 * @param asOf Calculate as of this date (default: now)
 */
export function daysOverdue(dueDate: Date, asOf: Date = new Date()): number {
  const days = daysBetween(dueDate, asOf);
  return Math.max(0, days);
}

/**
 * Parse Xero date string to Date
 * Xero returns dates like "2025-07-21T00:00:00" or "/Date(1626825600000)/"
 */
export function parseXeroDate(dateStr: string | Date | undefined): Date {
  // Handle undefined/null
  if (!dateStr) {
    return new Date();
  }

  // If already a Date object
  if (dateStr instanceof Date) {
    return dateStr;
  }

  // Handle .NET JSON date format /Date(1234567890000)/
  const dotNetMatch = dateStr.match(/\/Date\((\d+)\)\//);
  if (dotNetMatch) {
    return new Date(parseInt(dotNetMatch[1], 10));
  }

  // Handle ISO format
  return new Date(dateStr);
}

/**
 * Format date for Xero API (YYYY-MM-DD)
 */
export function formatXeroDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get the first day of the current month
 */
export function firstOfMonth(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Get the last day of the previous month
 */
export function lastOfPreviousMonth(date: Date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 0);
}

/**
 * Format date for display (Jan 15, 2026)
 */
export function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format month/year for invoice reference (January 2026)
 */
export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Check if two dates are in the same month
 */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/**
 * Get date N days ago
 */
export function daysAgo(days: number, from: Date = new Date()): Date {
  const result = new Date(from);
  result.setDate(result.getDate() - days);
  return result;
}
