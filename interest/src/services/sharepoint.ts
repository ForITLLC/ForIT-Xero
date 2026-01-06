import { Client } from '@microsoft/microsoft-graph-client';
import { DefaultAzureCredential } from '@azure/identity';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { InterestConfig, InterestLedgerEntry } from '../types';

let graphClient: Client | null = null;

/**
 * Get authenticated Microsoft Graph client
 */
function getGraphClient(): Client {
  if (graphClient) {
    return graphClient;
  }

  const credential = new DefaultAzureCredential();
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ['https://graph.microsoft.com/.default'],
  });

  graphClient = Client.initWithMiddleware({ authProvider });
  return graphClient;
}

/**
 * Get the SharePoint site ID
 */
function getSiteId(): string {
  const siteId = process.env.SHAREPOINT_SITE_ID;
  if (!siteId) {
    throw new Error('SHAREPOINT_SITE_ID environment variable not set');
  }
  return siteId;
}

// List names
const INTEREST_CONFIG_LIST = 'InterestConfig';
const INTEREST_LEDGER_LIST = 'InterestLedger';

/**
 * Get all active interest configurations
 */
export async function getActiveConfigs(): Promise<InterestConfig[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  // Fetch all configs and filter in code - Graph API filter on expanded fields is unreliable
  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_CONFIG_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .get();

  return (response.value || [])
    .map(mapConfigFromSharePoint)
    .filter((config: InterestConfig) => config.isActive);
}

/**
 * Get a specific config by contact ID
 */
export async function getConfigByContactId(contactId: string): Promise<InterestConfig | null> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_CONFIG_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Xero_x0020_Contact_x0020_ID eq '${contactId}'`)
    .get();

  const items = response.value || [];
  return items.length > 0 ? mapConfigFromSharePoint(items[0]) : null;
}

/**
 * Update config after successful run
 */
export async function updateConfigLastRun(
  configId: string,
  lastRunDate: Date,
  lastInvoiceId: string
): Promise<void> {
  const client = getGraphClient();
  const siteId = getSiteId();

  await client
    .api(`/sites/${siteId}/lists/${INTEREST_CONFIG_LIST}/items/${configId}/fields`)
    .patch({
      Last_x0020_Run_x0020_Date: lastRunDate.toISOString(),
      Last_x0020_Invoice_x0020_ID: lastInvoiceId,
    });
}

/**
 * Get ledger entries for a contact
 */
export async function getLedgerEntriesByContact(contactId: string): Promise<InterestLedgerEntry[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Contact_x0020_ID eq '${contactId}'`)
    .get();

  return (response.value || []).map(mapLedgerFromSharePoint);
}

/**
 * Get ledger entries for a specific source invoice
 */
export async function getLedgerEntriesBySourceInvoice(sourceInvoiceId: string): Promise<InterestLedgerEntry[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Source_x0020_Invoice_x0020_ID eq '${sourceInvoiceId}'`)
    .get();

  return (response.value || []).map(mapLedgerFromSharePoint);
}

/**
 * Get active ledger entries (for reconciliation)
 */
export async function getActiveLedgerEntries(): Promise<InterestLedgerEntry[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter("fields/Status eq 'Active'")
    .get();

  return (response.value || []).map(mapLedgerFromSharePoint);
}

/**
 * Create a new ledger entry (reconciliation log)
 */
export async function createLedgerEntry(entry: Omit<InterestLedgerEntry, 'id' | 'created'>): Promise<string> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .post({
      fields: {
        Source_x0020_Invoice_x0020_ID: entry.sourceInvoiceId,
        Source_x0020_Invoice_x0020_Numbe: entry.sourceInvoiceNumber,
        Interest_x0020_Invoice_x0020_ID: entry.interestInvoiceId,
        Interest_x0020_Invoice_x0020_Num: entry.interestInvoiceNumber,
        Charge_x0020_Month: entry.chargeMonth,
        Action: entry.action,
        Previous_x0020_Amount: entry.previousAmount,
        New_x0020_Amount: entry.newAmount,
        Delta: entry.delta,
        Reason: entry.reason,
        Source_x0020_Due_x0020_Date: entry.sourceDueDate.toISOString(),
        Source_x0020_Amount_x0020_Due: entry.sourceAmountDue,
        Days_x0020_Overdue: entry.daysOverdue,
        Rate: entry.rate,
        Credit_x0020_Note_x0020_ID: entry.creditNoteId,
        Credit_x0020_Note_x0020_Number: entry.creditNoteNumber,
        Contact_x0020_ID: entry.contactId,
        Contact_x0020_Name: entry.contactName,
        Notes: entry.notes,
      },
    });

  return response.id;
}

/**
 * Get the most recent ledger entry for a source invoice
 * Used to determine previous amount charged
 */
export async function getLatestLedgerEntryForInvoice(sourceInvoiceId: string): Promise<InterestLedgerEntry | null> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Source_x0020_Invoice_x0020_ID eq '${sourceInvoiceId}'`)
    .orderby('fields/Created desc')
    .top(1)
    .get();

  const items = response.value || [];
  return items.length > 0 ? mapLedgerFromSharePoint(items[0]) : null;
}

/**
 * Get current total interest charged for a source invoice
 * Sums all deltas to get net amount currently owed
 */
export async function getCurrentChargedAmount(sourceInvoiceId: string): Promise<number> {
  const entries = await getLedgerEntriesBySourceInvoice(sourceInvoiceId);
  // Sum all deltas - this accounts for increases and decreases
  return entries.reduce((sum, entry) => sum + entry.delta, 0);
}

/**
 * Get a single ledger entry by ID
 */
export async function getLedgerEntry(entryId: string): Promise<InterestLedgerEntry | null> {
  const client = getGraphClient();
  const siteId = getSiteId();

  try {
    const response = await client
      .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items/${entryId}`)
      .expand('fields')
      .get();

    return mapLedgerFromSharePoint(response);
  } catch {
    return null;
  }
}

// Mappers

function mapConfigFromSharePoint(item: any): InterestConfig {
  const fields = item.fields;
  return {
    id: item.id,
    xeroContactId: fields.Xero_x0020_Contact_x0020_ID,
    contactName: fields.Contact_x0020_Name,
    annualRate: fields.Annual_x0020_Rate,
    minDaysOverdue: fields.Min_x0020_Days_x0020_Overdue ?? 30,
    minChargeAmount: fields.Min_x0020_Charge_x0020_Amount ?? 1,
    currencyCode: fields.Currency_x0020_Code || undefined,
    isActive: fields.Is_x0020_Active ?? true,
    lastRunDate: fields.Last_x0020_Run_x0020_Date ? new Date(fields.Last_x0020_Run_x0020_Date) : undefined,
    lastInvoiceId: fields.Last_x0020_Invoice_x0020_ID || undefined,
    notes: fields.Notes || undefined,
  };
}

function mapLedgerFromSharePoint(item: any): InterestLedgerEntry {
  const fields = item.fields;
  return {
    id: item.id,
    sourceInvoiceId: fields.Source_x0020_Invoice_x0020_ID,
    sourceInvoiceNumber: fields.Source_x0020_Invoice_x0020_Numbe,
    interestInvoiceId: fields.Interest_x0020_Invoice_x0020_ID,
    interestInvoiceNumber: fields.Interest_x0020_Invoice_x0020_Num,
    chargeMonth: fields.Charge_x0020_Month || '',
    action: fields.Action,
    previousAmount: fields.Previous_x0020_Amount || 0,
    newAmount: fields.New_x0020_Amount || 0,
    delta: fields.Delta || 0,
    reason: fields.Reason,
    sourceDueDate: new Date(fields.Source_x0020_Due_x0020_Date),
    sourceAmountDue: fields.Source_x0020_Amount_x0020_Due || 0,
    daysOverdue: fields.Days_x0020_Overdue || 0,
    rate: fields.Rate,
    creditNoteId: fields.Credit_x0020_Note_x0020_ID || undefined,
    creditNoteNumber: fields.Credit_x0020_Note_x0020_Number || undefined,
    contactId: fields.Contact_x0020_ID,
    contactName: fields.Contact_x0020_Name,
    created: new Date(fields.Created),
    notes: fields.Notes || undefined,
  };
}

/**
 * Get ledger entries for a specific source invoice and charge month
 */
export async function getLedgerEntriesForMonth(
  sourceInvoiceId: string,
  chargeMonth: string
): Promise<InterestLedgerEntry[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Source_x0020_Invoice_x0020_ID eq '${sourceInvoiceId}' and fields/Charge_x0020_Month eq '${chargeMonth}'`)
    .get();

  return (response.value || []).map(mapLedgerFromSharePoint);
}

/**
 * Get current charged amount for a specific source invoice and month
 */
export async function getChargedAmountForMonth(
  sourceInvoiceId: string,
  chargeMonth: string
): Promise<number> {
  const entries = await getLedgerEntriesForMonth(sourceInvoiceId, chargeMonth);
  return entries.reduce((sum, entry) => sum + entry.delta, 0);
}

/**
 * Get the latest ledger entry for a source invoice and specific month
 */
export async function getLatestLedgerEntryForMonth(
  sourceInvoiceId: string,
  chargeMonth: string
): Promise<InterestLedgerEntry | null> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .filter(`fields/Source_x0020_Invoice_x0020_ID eq '${sourceInvoiceId}' and fields/Charge_x0020_Month eq '${chargeMonth}'`)
    .orderby('fields/Created desc')
    .top(1)
    .get();

  const items = response.value || [];
  return items.length > 0 ? mapLedgerFromSharePoint(items[0]) : null;
}

/**
 * Get all ledger entries (for bulk operations)
 */
export async function getAllLedgerEntries(): Promise<InterestLedgerEntry[]> {
  const client = getGraphClient();
  const siteId = getSiteId();

  const response = await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items`)
    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
    .expand('fields')
    .top(999)
    .get();

  return (response.value || []).map(mapLedgerFromSharePoint);
}

/**
 * Delete a ledger entry by ID
 */
export async function deleteLedgerEntry(entryId: string): Promise<void> {
  const client = getGraphClient();
  const siteId = getSiteId();

  await client
    .api(`/sites/${siteId}/lists/${INTEREST_LEDGER_LIST}/items/${entryId}`)
    .delete();
}
