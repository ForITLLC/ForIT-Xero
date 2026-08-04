// SharePoint List Types

export interface InterestConfig {
  id: string;
  xeroContactId: string;
  contactName: string;
  annualRate: number;           // e.g., 24 for 24%
  minDaysOverdue: number;       // grace period
  minChargeAmount: number;      // skip tiny amounts
  currencyCode?: string;        // USD, CAD, or null for all
  isActive: boolean;
  lastRunDate?: Date;
  lastInvoiceId?: string;
  notes?: string;
}

// Reconciliation action types
export type ReconcileAction = 'Created' | 'Updated' | 'Credited' | 'AdditionalCharge';
export type ReconcileReason = 'Initial' | 'DueDateChanged' | 'PartialPayment' | 'SourceVoided' | 'PrincipalChanged' | 'DailyAccrual' | 'ManualAdjustment';

export interface InterestLedgerEntry {
  id?: string;
  sourceInvoiceId: string;        // Xero invoice GUID
  sourceInvoiceNumber: string;    // INV-0304
  interestInvoiceId: string;      // Interest invoice we created/updated
  interestInvoiceNumber?: string;
  chargeMonth: string;            // Which month this charge is for (YYYY-MM)
  action: ReconcileAction;        // What action was taken
  previousAmount: number;         // Interest amount before this action (for this month)
  newAmount: number;              // Interest amount after this action (for this month)
  delta: number;                  // Change amount (newAmount - previousAmount)
  reason: ReconcileReason;        // Why this change was made
  sourceDueDate: Date;            // Snapshot of due date at time of calc
  sourceAmountDue: number;        // Snapshot of amount due at time of calc
  daysOverdue: number;            // Total days overdue at time of calc
  rate: number;                   // Rate used (snapshot)
  creditNoteId?: string;          // If credit was issued
  creditNoteNumber?: string;
  contactId: string;
  contactName: string;
  created: Date;
  notes?: string;
}

// Xero Types

export interface XeroInvoice {
  invoiceID: string;
  invoiceNumber: string;
  type: 'ACCREC' | 'ACCPAY';
  contact: {
    contactID: string;
    name: string;
  };
  status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';
  dueDate: string;
  date: string;
  /** Present on the SDK's Invoice; used by the debug check-invoice route. */
  reference?: string;
  amountDue: number;
  amountPaid: number;
  total: number;
  currencyCode: string;
  payments?: XeroPayment[];
  creditNotes?: XeroCreditNote[];
}

/**
 * These mirror xero-node 9.3.0's Payment and CreditNote, verified against the
 * INSTALLED package: camelCase and optional. They previously declared
 * PaymentID/Date/Amount, which the SDK has never returned — the code compiled
 * only because `(payment as any).date || payment.Date` suppressed the check,
 * and `payment.Date` was undefined on every real response.
 *
 * Keep these matching the SDK. If xero-node moves a field, this file is where
 * the compiler should catch it.
 */
export interface XeroPayment {
  paymentID?: string;
  date?: string;
  amount?: number;
}

export interface XeroCreditNote {
  creditNoteID?: string;
  date?: string;
  total?: number;
  appliedAmount?: number;
}

export interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: string;
  Tracking?: Array<{
    Name: string;
    Option: string;
  }>;
}

export interface CreateInvoiceRequest {
  Type: 'ACCREC';
  Contact: { ContactID: string };
  Date: string;
  DueDate: string;
  Reference: string;
  Status: 'AUTHORISED';
  LineItems: XeroLineItem[];
  CurrencyCode?: string;
}

export interface CreateCreditNoteRequest {
  Type: 'ACCRECCREDIT';
  Contact: { ContactID: string };
  Date: string;
  Reference: string;
  Status: 'AUTHORISED';
  LineItems: XeroLineItem[];
  CurrencyCode?: string;
}

// Calculation Types

export interface InterestCalculation {
  sourceInvoice: XeroInvoice;
  principal: number;            // Amount to charge interest on
  daysOverdue: number;          // Total days overdue
  daysToCharge: number;         // Days for this period (may be less if partial)
  rate: number;                 // Annual rate as decimal (0.24 for 24%)
  interestAmount: number;       // Calculated interest
  periodStart: Date;
  periodEnd: Date;
  alreadyCharged: number;       // Interest already charged in ledger
  netInterest: number;          // interestAmount - alreadyCharged
}

export interface AccrualResult {
  config: InterestConfig;
  calculations: InterestCalculation[];
  totalInterest: number;
  invoiceCreated: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  errors: string[];
  skipped: Array<{
    invoiceNumber: string;
    reason: string;
  }>;
}

export interface ReconcileResult {
  voidedSourceInvoices: string[];
  creditNotesCreated: string[];
  ledgerEntriesUpdated: number;
  errors: string[];
}

// Function Input/Output Types

export interface DryRunRequest {
  contactId?: string;           // Specific client, or all if omitted
  asOfDate?: string;            // Calculate as of this date (default: now)
}

/**
 * The dry-run handler deliberately returns a REDUCED sourceInvoice — four
 * fields, not a whole invoice. `results: AccrualResult[]` claimed otherwise and
 * an `as any` at the call site kept the compiler quiet about the difference.
 * Declare the projection that is actually sent.
 */
export interface DryRunResponse {
  results: Array<Omit<AccrualResult, 'calculations'> & {
    calculations: Array<Omit<AccrualResult['calculations'][number], 'sourceInvoice'> & {
      sourceInvoice: Pick<XeroInvoice, 'invoiceID' | 'invoiceNumber' | 'amountDue' | 'dueDate'>;
    }>;
  }>;
  totalInterest: number;
  invoicesWouldCreate: number;
  timestamp: string;
}

export interface ManualRunRequest {
  contactId: string;
  force?: boolean;              // Run even if already ran this month
}

export interface CreditInterestRequest {
  ledgerEntryId: string;
  reason: string;
}
