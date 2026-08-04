'use strict';

/**
 * WO#1148 D1 — the interest lane's suppressing casts, on the money path.
 *
 * `XeroPayment` declared PaymentID/Date/Amount. The INSTALLED xero-node 9.3.0
 * declares 'date'?: string and 'amount'?: number on Payment, and 'date'? /
 * 'appliedAmount'? on CreditNote — camelCase, and optional. The local type was
 * simply wrong about the SDK, and `(payment as any).date || payment.Date` was
 * the cast that made it work while hiding the mismatch.
 *
 * That matters here more than anywhere: `parseXeroDate(undefined)` returns
 * NEW DATE() — today. A payment whose date does not arrive is silently placed
 * at today instead of when it happened, which moves the balance timeline and
 * charges a customer the wrong interest, plausibly and without a trace.
 *
 * These drive the real calculation with SDK-shaped data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { calculateTimelineInterest } = require(
  path.join(__dirname, '..', 'dist', 'src', 'utils', 'paymentTimeline.js')
);

const CONFIG = { annualRate: 24, minDaysOverdue: 0 };

// Due 2026-01-01, 100 outstanding, one payment of 50 on 2026-02-01.
function invoiceWithPayment(payment) {
  return {
    invoiceID: 'inv-1',
    invoiceNumber: 'INV-001',
    type: 'ACCREC',
    contact: { contactID: 'c-1', name: 'Test' },
    status: 'AUTHORISED',
    date: '2026-01-01',
    dueDate: '2026-01-01',
    total: 100,
    amountPaid: 50,
    amountDue: 50,
    currencyCode: 'CAD',
    payments: [payment],
  };
}

const AS_OF = new Date('2026-03-01T00:00:00Z');

test('a payment in the shape xero-node 9.3.0 actually returns is applied on its own date', () => {
  // camelCase, exactly as the SDK sends it.
  const result = calculateTimelineInterest(
    invoiceWithPayment({ paymentID: 'p-1', date: '2026-02-01', amount: 50 }),
    CONFIG,
    AS_OF
  );

  // Two periods: 100 outstanding for January, 50 for February.
  assert.equal(result.periods.length, 2, `expected the payment to split the timeline: ${JSON.stringify(result.periods)}`);
  assert.equal(result.periods[0].balance, 100);
  assert.equal(result.periods[1].balance, 50);

  // 100 * 24%/365 * 31 days + 50 * 24%/365 * 28 days
  const expected = (100 * 0.24 / 365) * 31 + (50 * 0.24 / 365) * 28;
  assert.ok(
    Math.abs(result.totalInterest - expected) < 0.02,
    `interest ${result.totalInterest} is not the timeline figure ${expected.toFixed(2)}`
  );
});

test('a payment with no usable date is refused, not silently dated today', () => {
  // parseXeroDate(undefined) returns today. Applied to an interest timeline
  // that silently moves a balance change by weeks and bills the difference.
  assert.throws(
    () => calculateTimelineInterest(
      invoiceWithPayment({ paymentID: 'p-1', amount: 50 }),
      CONFIG,
      AS_OF
    ),
    /payment/i,
    'a dateless payment was accepted — it will be dated today and the interest will be wrong'
  );
});

test('a payment with no usable amount is refused', () => {
  assert.throws(
    () => calculateTimelineInterest(
      invoiceWithPayment({ paymentID: 'p-1', date: '2026-02-01' }),
      CONFIG,
      AS_OF
    ),
    /payment/i
  );
});

test('a credit note in the SDK shape reduces the balance from its own date', () => {
  const invoice = {
    ...invoiceWithPayment({ paymentID: 'p-1', date: '2026-02-01', amount: 50 }),
    payments: [],
    creditNotes: [{ creditNoteID: 'cn-1', date: '2026-02-01', appliedAmount: 50, total: 50 }],
  };

  const result = calculateTimelineInterest(invoice, CONFIG, AS_OF);
  assert.equal(result.periods.length, 2);
  assert.equal(result.periods[1].balance, 50);
});

test('an invoice that is not yet overdue accrues nothing', () => {
  const result = calculateTimelineInterest(
    invoiceWithPayment({ paymentID: 'p-1', date: '2026-02-01', amount: 50 }),
    CONFIG,
    new Date('2025-12-01T00:00:00Z')
  );
  assert.equal(result.totalInterest, 0);
  assert.deepEqual(result.periods, []);
});
