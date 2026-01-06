import { XeroClient } from 'xero-node';
import { getSecret, setSecret, SECRETS } from './keyvault';
import { sendFailureNotification } from './notifications';
import {
  XeroInvoice,
  CreateInvoiceRequest,
  CreateCreditNoteRequest,
} from '../types';
import { formatXeroDate } from '../utils/dates';

let xeroClient: XeroClient | null = null;
let tenantId: string | null = null;
let tokenExpiresAt: number = 0; // Timestamp when token expires

// Token refresh buffer - refresh 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Initialize and return authenticated Xero client
 * Automatically refreshes token if expired or about to expire
 */
export async function getXeroClient(): Promise<XeroClient> {
  const now = Date.now();
  const needsRefresh = !xeroClient || now >= (tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS);

  if (!needsRefresh && xeroClient) {
    return xeroClient;
  }

  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) {
    throw new Error('XERO_CLIENT_ID environment variable not set');
  }

  const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);
  const refreshToken = await getSecret(SECRETS.XERO_REFRESH_TOKEN);
  tenantId = await getSecret(SECRETS.XERO_TENANT_ID);

  if (!xeroClient) {
    xeroClient = new XeroClient({
      clientId,
      clientSecret,
      redirectUris: [`${process.env.WEBSITE_HOSTNAME || 'https://forit-interest-accrual.azurewebsites.net'}/api/auth/callback`],
      scopes: [
        'openid',
        'profile',
        'email',
        'accounting.transactions',
        'accounting.transactions.read',
        'accounting.contacts.read',
        'accounting.settings.read',
        'offline_access',
      ],
    });

    await xeroClient.initialize();
  }

  // Refresh the token
  console.log('Refreshing Xero token...');

  try {
    const tokenSet = await xeroClient.refreshWithRefreshToken(clientId, clientSecret, refreshToken);

    // Store the new refresh token
    if (tokenSet.refresh_token) {
      await setSecret(SECRETS.XERO_REFRESH_TOKEN, tokenSet.refresh_token);
    }

    // Track when this token expires (default 30 min = 1800 seconds)
    const expiresIn = tokenSet.expires_in || 1800;
    tokenExpiresAt = now + (expiresIn * 1000);
    console.log(`Xero token refreshed, expires in ${expiresIn} seconds`);

    xeroClient.setTokenSet(tokenSet);

    return xeroClient;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Clear cached client so next call will try fresh
    clearXeroClient();

    // Send notification to user who authorized
    await sendFailureNotification('Xero Token Refresh', err, {
      hint: 'Refresh token may be expired. Re-authorization required.',
    });

    throw err;
  }
}

/**
 * Clear cached client (call on auth errors to force re-init)
 */
export function clearXeroClient(): void {
  xeroClient = null;
  tokenExpiresAt = 0;
}

/**
 * Get the Xero tenant ID
 */
export async function getTenantId(): Promise<string> {
  if (!tenantId) {
    tenantId = await getSecret(SECRETS.XERO_TENANT_ID);
  }
  return tenantId;
}

/**
 * Get overdue invoices for a contact WITH payments included
 *
 * Single API call - summaryOnly doesn't support where or order, so we just
 * fetch full details directly. Payments are included in the response.
 */
export async function getOverdueInvoices(
  contactId: string,
  minDaysOverdue: number,
  currencyCode?: string
): Promise<XeroInvoice[]> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  // Calculate the date threshold
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - minDaysOverdue);
  const thresholdStr = formatXeroDate(thresholdDate);

  // Build where clause
  // Exclude ALL interest invoices:
  // - Paidnice uses "2% Monthly Simple Interest" in Reference
  // - Our system uses "[FORIT-INT]" prefix in Reference
  // - Legacy uses "Interest Charges" or "Interest on" in Reference
  let where = `Contact.ContactID==Guid("${contactId}") AND Status=="AUTHORISED" AND AmountDue>0 AND DueDate<DateTime(${thresholdStr.replace(/-/g, ',')}) AND (Reference==null OR (NOT Reference.Contains("2% Monthly Simple Interest") AND NOT Reference.Contains("[FORIT-INT]") AND NOT Reference.Contains("Interest Charges") AND NOT Reference.Contains("Interest on")))`;

  if (currencyCode) {
    where += ` AND CurrencyCode=="${currencyCode}"`;
  }

  // Single call with full details (includes payments)
  const response = await client.accountingApi.getInvoices(
    xeroTenantId,
    undefined, // ifModifiedSince
    where,
    'DueDate ASC', // order
    undefined, // IDs
    undefined, // InvoiceNumbers
    undefined, // ContactIDs
    undefined, // Statuses
    undefined, // page
    false, // includeArchived
    false, // createdByMyApp
    undefined, // unitdp
    false // summaryOnly=false to get payments
  );

  return (response.body.invoices || []) as unknown as XeroInvoice[];
}

/**
 * Get a single invoice by ID
 */
export async function getInvoice(invoiceId: string): Promise<XeroInvoice | null> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  try {
    const response = await client.accountingApi.getInvoice(xeroTenantId, invoiceId);
    const invoices = response.body.invoices || [];
    return invoices.length > 0 ? (invoices[0] as unknown as XeroInvoice) : null;
  } catch (error) {
    return null;
  }
}

/**
 * Get a single invoice by invoice number
 */
export async function getInvoiceByNumber(invoiceNumber: string): Promise<XeroInvoice | null> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  try {
    const response = await client.accountingApi.getInvoices(
      xeroTenantId,
      undefined, // ifModifiedSince
      undefined, // where
      undefined, // order
      undefined, // IDs
      [invoiceNumber], // InvoiceNumbers
      undefined, // ContactIDs
      undefined, // Statuses
      undefined, // page
      false, // includeArchived
      false, // createdByMyApp
      undefined, // unitdp
      false // summaryOnly
    );

    const invoices = response.body.invoices || [];
    return invoices.length > 0 ? (invoices[0] as unknown as XeroInvoice) : null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if an invoice has been voided or deleted
 */
export async function isInvoiceVoided(invoiceId: string): Promise<boolean> {
  const invoice = await getInvoice(invoiceId);
  console.log(`[isInvoiceVoided] invoiceId=${invoiceId}, invoice=${invoice ? 'found' : 'null'}, status=${invoice?.status}`);
  if (!invoice) return true; // If we can't find it, treat as voided
  const isVoided = invoice.status === 'VOIDED' || invoice.status === 'DELETED';
  console.log(`[isInvoiceVoided] isVoided=${isVoided}`);
  return isVoided;
}

/**
 * Create an interest invoice
 */
export async function createInvoice(request: CreateInvoiceRequest): Promise<{
  invoiceId: string;
  invoiceNumber: string;
}> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  // Convert PascalCase properties to lowercase for xero-node SDK
  const invoice: any = {
    type: request.Type,
    contact: { contactID: request.Contact.ContactID },
    date: request.Date,
    dueDate: request.DueDate,
    reference: request.Reference,
    status: request.Status,
    lineItems: request.LineItems.map(li => ({
      description: li.Description,
      quantity: li.Quantity,
      unitAmount: li.UnitAmount,
      accountCode: li.AccountCode,
      taxType: li.TaxType,
      tracking: li.Tracking?.map(t => ({ name: t.Name, option: t.Option })),
    })),
  };

  if (request.CurrencyCode) {
    invoice.currencyCode = request.CurrencyCode;
  }

  const response = await client.accountingApi.createInvoices(xeroTenantId, {
    invoices: [invoice],
  });

  const createdInvoices = response.body.invoices || [];
  if (createdInvoices.length === 0) {
    throw new Error('Failed to create invoice - no invoice returned');
  }

  const created = createdInvoices[0] as any;
  return {
    invoiceId: created.invoiceID,
    invoiceNumber: created.invoiceNumber,
  };
}

/**
 * Create a credit note (to reverse interest charges)
 */
export async function createCreditNote(request: CreateCreditNoteRequest): Promise<{
  creditNoteId: string;
  creditNoteNumber: string;
}> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  // Convert PascalCase properties to lowercase for xero-node SDK
  const creditNote: any = {
    type: request.Type,
    contact: { contactID: request.Contact.ContactID },
    date: request.Date,
    reference: request.Reference,
    status: request.Status,
    lineItems: request.LineItems.map(li => ({
      description: li.Description,
      quantity: li.Quantity,
      unitAmount: li.UnitAmount,
      accountCode: li.AccountCode,
      taxType: li.TaxType,
    })),
  };

  if (request.CurrencyCode) {
    creditNote.currencyCode = request.CurrencyCode;
  }

  const response = await client.accountingApi.createCreditNotes(xeroTenantId, {
    creditNotes: [creditNote],
  });

  const createdNotes = response.body.creditNotes || [];
  if (createdNotes.length === 0) {
    throw new Error('Failed to create credit note - no credit note returned');
  }

  const created = createdNotes[0] as any;
  return {
    creditNoteId: created.creditNoteID,
    creditNoteNumber: created.creditNoteNumber,
  };
}

/**
 * Search contacts by name
 */
export async function searchContacts(searchTerm: string): Promise<Array<{
  contactId: string;
  name: string;
  emailAddress?: string;
}>> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  const where = `Name.Contains("${searchTerm}")`;

  const response = await client.accountingApi.getContacts(
    xeroTenantId,
    undefined, // ifModifiedSince
    where,
    'Name ASC',
    undefined, // IDs
    undefined, // page
    false // includeArchived
  );

  return (response.body.contacts || []).map((c: any) => ({
    contactId: c.contactID,
    name: c.name,
    emailAddress: c.emailAddress,
  }));
}

/**
 * Void an invoice
 */
export async function voidInvoice(invoiceId: string): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        status: 'VOIDED' as any,
      }],
    }
  );
}

/**
 * Void multiple invoices
 */
export async function voidInvoices(invoiceIds: string[]): Promise<{ voided: string[]; failed: { id: string; error: string }[] }> {
  const voided: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const invoiceId of invoiceIds) {
    try {
      await voidInvoice(invoiceId);
      voided.push(invoiceId);
    } catch (error) {
      failed.push({ id: invoiceId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { voided, failed };
}

/**
 * Delete a draft invoice (only works for DRAFT status)
 */
export async function deleteInvoice(invoiceId: string): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        status: 'DELETED' as any,
      }],
    }
  );
}

/**
 * Move an invoice back to DRAFT status
 * Only works if invoice has no payments or credit note allocations
 */
export async function moveToDraft(invoiceId: string): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        status: 'DRAFT' as any,
      }],
    }
  );
}

/**
 * Update an invoice's line items (must be in DRAFT status)
 */
export async function updateInvoiceLineItems(
  invoiceId: string,
  lineItems: Array<{
    description: string;
    itemCode?: string;
    quantity: number;
    unitAmount: number;
    accountCode: string;
    taxType: string;
  }>
): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        lineItems: lineItems as any,
      }],
    }
  );
}

/**
 * Update an invoice's date and due date (must be in DRAFT status)
 */
export async function updateInvoiceDates(
  invoiceId: string,
  invoiceDate: Date,
  dueDate: Date
): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        date: formatXeroDate(invoiceDate),
        dueDate: formatXeroDate(dueDate),
      }],
    }
  );
}

/**
 * Authorize a draft invoice
 */
export async function authorizeInvoice(invoiceId: string): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.updateInvoice(
    xeroTenantId,
    invoiceId,
    {
      invoices: [{
        invoiceID: invoiceId,
        status: 'AUTHORISED' as any,
      }],
    }
  );
}

/**
 * Get all accounts from Xero
 */
export async function getAccounts(): Promise<Array<{
  accountId: string;
  code: string;
  name: string;
  type: string;
  status: string;
}>> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  const response = await client.accountingApi.getAccounts(xeroTenantId);

  return (response.body.accounts || []).map((a: any) => ({
    accountId: a.accountID,
    code: a.code,
    name: a.name,
    type: a.type,
    status: a.status,
  }));
}

/**
 * Get all items from Xero
 */
export async function getItems(): Promise<Array<{
  itemId: string;
  code: string;
  name: string;
  description?: string;
}>> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  const response = await client.accountingApi.getItems(xeroTenantId);

  return (response.body.items || []).map((i: any) => ({
    itemId: i.itemID,
    code: i.code,
    name: i.name,
    description: i.description,
  }));
}

/**
 * Create an item in Xero
 */
export async function createItem(
  code: string,
  name: string,
  description: string,
  accountCode: string
): Promise<{ itemId: string; code: string }> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  const response = await client.accountingApi.createItems(xeroTenantId, {
    items: [{
      code,
      name,
      description,
      isSold: true,
      salesDetails: {
        unitPrice: 0,
        accountCode,
        taxType: 'NONE',
      },
    } as any],
  });

  const created = (response.body.items || [])[0] as any;
  return {
    itemId: created.itemID,
    code: created.code,
  };
}

/**
 * Get or create the interest charge item
 * Returns undefined if item doesn't exist and can't be created (insufficient scope)
 */
export async function getOrCreateInterestItem(accountCode: string): Promise<{
  itemCode: string | undefined;
  itemId: string | undefined;
}> {
  try {
    const items = await getItems();
    const existing = items.find(i => i.code === 'INTEREST');

    if (existing) {
      return { itemCode: existing.code, itemId: existing.itemId };
    }

    // Try to create the item
    const created = await createItem(
      'INTEREST',
      'Interest Charges',
      'Interest on overdue invoices',
      accountCode
    );

    return { itemCode: created.code, itemId: created.itemId };
  } catch (error) {
    // If we can't create items (insufficient scope), just proceed without itemCode
    console.log('Could not get/create INTEREST item - proceeding without itemCode');
    return { itemCode: undefined, itemId: undefined };
  }
}

/**
 * Check if an invoice can be modified (not paid, no allocations)
 */
export async function canModifyInvoice(invoiceId: string): Promise<{
  canModify: boolean;
  status: string;
  isPaid: boolean;
  hasAllocations: boolean;
}> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) {
    return { canModify: false, status: 'NOT_FOUND', isPaid: false, hasAllocations: false };
  }

  const isPaid = invoice.status === 'PAID' || (invoice.amountPaid || 0) > 0;
  const hasAllocations = (invoice.creditNotes && invoice.creditNotes.length > 0) || false;
  const canModify = !isPaid && !hasAllocations && invoice.status !== 'VOIDED' && invoice.status !== 'DELETED';

  return {
    canModify,
    status: invoice.status,
    isPaid,
    hasAllocations,
  };
}

/**
 * Get or create a draft interest invoice for a contact/period
 * Returns existing draft if one exists for this month
 * @param invoiceDate - The date for the invoice (last day of charge month)
 * @param dueDate - The due date for the invoice (invoice date + 30 days)
 */
export async function getOrCreateInterestInvoice(
  contactId: string,
  contactName: string,
  periodMonth: string, // e.g., "2026-01"
  invoiceDate: Date, // The date the invoice should be dated
  dueDate: Date, // The due date for the invoice
  currencyCode?: string
): Promise<{ invoiceId: string; invoiceNumber: string; isNew: boolean }> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  // Look for existing interest invoice for this period
  const reference = `[FORIT-INT] Interest Charges - ${periodMonth}`;
  const where = `Contact.ContactID==Guid("${contactId}") AND Reference=="${reference}" AND Status!="VOIDED" AND Status!="DELETED"`;

  const response = await client.accountingApi.getInvoices(
    xeroTenantId,
    undefined,
    where,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    false
  );

  const existing = response.body.invoices || [];
  if (existing.length > 0) {
    const inv = existing[0] as any;
    return {
      invoiceId: inv.invoiceID,
      invoiceNumber: inv.invoiceNumber,
      isNew: false,
    };
  }

  // Create new draft invoice (dueDate is passed in, typically invoice date + 30 days)

  // Get or create the INTEREST item (may be undefined if insufficient scope)
  const accountCode = process.env.INTEREST_ACCOUNT_CODE || '4010';
  const { itemCode } = await getOrCreateInterestItem(accountCode);

  const lineItem: any = {
    description: 'Interest charges - pending calculation',
    quantity: 1,
    unitAmount: 0,
    accountCode: accountCode,
    taxType: 'NONE',
  };
  if (itemCode) {
    lineItem.itemCode = itemCode;
  }

  const createResponse = await client.accountingApi.createInvoices(xeroTenantId, {
    invoices: [{
      type: 'ACCREC' as any,
      contact: { contactID: contactId },
      date: formatXeroDate(invoiceDate),
      dueDate: formatXeroDate(dueDate),
      reference: reference,
      status: 'DRAFT' as any,
      lineItems: [lineItem],
      currencyCode: currencyCode,
    } as any],
  });

  const created = (createResponse.body.invoices || [])[0] as any;
  return {
    invoiceId: created.invoiceID,
    invoiceNumber: created.invoiceNumber,
    isNew: true,
  };
}

/**
 * Add a history note to an invoice
 * Used to record change history (e.g., "Replaced invoice INV-0123 - calculation correction")
 */
export async function addInvoiceHistoryNote(
  invoiceId: string,
  note: string
): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.createInvoiceHistory(xeroTenantId, invoiceId, {
    historyRecords: [{
      details: note,
    }],
  });
}

/**
 * Add a history note to a credit note
 */
export async function addCreditNoteHistoryNote(
  creditNoteId: string,
  note: string
): Promise<void> {
  const client = await getXeroClient();
  const xeroTenantId = await getTenantId();

  await client.accountingApi.createCreditNoteHistory(xeroTenantId, creditNoteId, {
    historyRecords: [{
      details: note,
    }],
  });
}
