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
  amountDue: number;
  amountPaid: number;
  total: number;
  currencyCode: string;
  payments?: XeroPayment[];
  creditNotes?: XeroCreditNote[];
}

export interface XeroPayment {
  PaymentID: string;
  Date: string;
  Amount: number;
}

export interface XeroCreditNote {
  CreditNoteID: string;
  Date: string;
  Total: number;
  AppliedAmount: number;
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

export interface DryRunResponse {
  results: AccrualResult[];
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
