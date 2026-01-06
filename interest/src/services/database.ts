import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import * as sql from 'mssql';
import { InterestConfig, InterestLedgerEntry } from '../types';

// Database configuration
const DB_SERVER = 'forit-saas-sql.database.windows.net';
const DB_NAME = 'forit-xero-db';
const DB_USER = 'foritadmin';
const KEY_VAULT_URL = 'https://forit-saas-kv.vault.azure.net/';
const PASSWORD_SECRET_NAME = 'SAAS-SQL-PASSWORD';

let pool: sql.ConnectionPool | null = null;
let dbPassword: string | null = null;

/**
 * Get the database password from Key Vault
 */
async function getDbPassword(): Promise<string> {
  if (dbPassword) {
    return dbPassword;
  }

  const credential = new DefaultAzureCredential();
  const secretClient = new SecretClient(KEY_VAULT_URL, credential);
  const secret = await secretClient.getSecret(PASSWORD_SECRET_NAME);

  if (!secret.value) {
    throw new Error(`Secret ${PASSWORD_SECRET_NAME} not found in Key Vault`);
  }

  dbPassword = secret.value;
  return dbPassword;
}

/**
 * Get or create database connection pool
 */
async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  const password = await getDbPassword();

  const config: sql.config = {
    server: DB_SERVER,
    database: DB_NAME,
    user: DB_USER,
    password: password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  pool = await sql.connect(config);
  return pool;
}

/**
 * Close the database connection pool
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

// ============================================================================
// Config Functions
// ============================================================================

/**
 * Get all active interest configurations
 */
export async function getActiveConfigs(): Promise<InterestConfig[]> {
  const db = await getPool();

  const result = await db.request().query(`
    SELECT
      id,
      xero_contact_id,
      contact_name,
      annual_rate,
      min_days_overdue,
      min_charge_amount,
      currency_code,
      is_active,
      last_run_date,
      last_invoice_id,
      notes
    FROM interest_configs
    WHERE is_active = 1
  `);

  return result.recordset.map(mapConfigFromDb);
}

/**
 * Get a specific config by contact ID
 */
export async function getConfigByContactId(contactId: string): Promise<InterestConfig | null> {
  const db = await getPool();

  const result = await db.request()
    .input('contactId', sql.NVarChar, contactId)
    .query(`
      SELECT
        id,
        xero_contact_id,
        contact_name,
        annual_rate,
        min_days_overdue,
        min_charge_amount,
        currency_code,
        is_active,
        last_run_date,
        last_invoice_id,
        notes
      FROM interest_configs
      WHERE xero_contact_id = @contactId
    `);

  return result.recordset.length > 0 ? mapConfigFromDb(result.recordset[0]) : null;
}

/**
 * Update config after successful run
 */
export async function updateConfigLastRun(
  configId: string,
  lastRunDate: Date,
  lastInvoiceId: string
): Promise<void> {
  const db = await getPool();

  await db.request()
    .input('configId', sql.NVarChar, configId)
    .input('lastRunDate', sql.DateTime2, lastRunDate)
    .input('lastInvoiceId', sql.NVarChar, lastInvoiceId)
    .query(`
      UPDATE interest_configs
      SET last_run_date = @lastRunDate,
          last_invoice_id = @lastInvoiceId
      WHERE id = @configId
    `);
}

// ============================================================================
// Ledger Functions
// ============================================================================

/**
 * Get ledger entries for a contact
 */
export async function getLedgerEntriesByContact(contactId: string): Promise<InterestLedgerEntry[]> {
  const db = await getPool();

  const result = await db.request()
    .input('contactId', sql.NVarChar, contactId)
    .query(`
      SELECT *
      FROM interest_ledger
      WHERE contact_id = @contactId
      ORDER BY created DESC
    `);

  return result.recordset.map(mapLedgerFromDb);
}

/**
 * Get ledger entries for a specific source invoice
 */
export async function getLedgerEntriesBySourceInvoice(sourceInvoiceId: string): Promise<InterestLedgerEntry[]> {
  const db = await getPool();

  const result = await db.request()
    .input('sourceInvoiceId', sql.NVarChar, sourceInvoiceId)
    .query(`
      SELECT *
      FROM interest_ledger
      WHERE source_invoice_id = @sourceInvoiceId
      ORDER BY created DESC
    `);

  return result.recordset.map(mapLedgerFromDb);
}

/**
 * Get active ledger entries (for reconciliation)
 */
export async function getActiveLedgerEntries(): Promise<InterestLedgerEntry[]> {
  const db = await getPool();

  const result = await db.request().query(`
    SELECT *
    FROM interest_ledger
    WHERE action != 'Credited'
    ORDER BY created DESC
  `);

  return result.recordset.map(mapLedgerFromDb);
}

/**
 * Create a new ledger entry (reconciliation log)
 */
export async function createLedgerEntry(entry: Omit<InterestLedgerEntry, 'id' | 'created'>): Promise<string> {
  const db = await getPool();

  const result = await db.request()
    .input('sourceInvoiceId', sql.NVarChar, entry.sourceInvoiceId)
    .input('sourceInvoiceNumber', sql.NVarChar, entry.sourceInvoiceNumber)
    .input('interestInvoiceId', sql.NVarChar, entry.interestInvoiceId)
    .input('interestInvoiceNumber', sql.NVarChar, entry.interestInvoiceNumber || null)
    .input('chargeMonth', sql.NVarChar, entry.chargeMonth)
    .input('action', sql.NVarChar, entry.action)
    .input('previousAmount', sql.Decimal(18, 2), entry.previousAmount)
    .input('newAmount', sql.Decimal(18, 2), entry.newAmount)
    .input('delta', sql.Decimal(18, 2), entry.delta)
    .input('reason', sql.NVarChar, entry.reason)
    .input('sourceDueDate', sql.DateTime2, entry.sourceDueDate)
    .input('sourceAmountDue', sql.Decimal(18, 2), entry.sourceAmountDue)
    .input('daysOverdue', sql.Int, entry.daysOverdue)
    .input('rate', sql.Decimal(5, 2), entry.rate)
    .input('creditNoteId', sql.NVarChar, entry.creditNoteId || null)
    .input('creditNoteNumber', sql.NVarChar, entry.creditNoteNumber || null)
    .input('contactId', sql.NVarChar, entry.contactId)
    .input('contactName', sql.NVarChar, entry.contactName)
    .input('notes', sql.NVarChar, entry.notes || null)
    .query(`
      INSERT INTO interest_ledger (
        source_invoice_id,
        source_invoice_number,
        interest_invoice_id,
        interest_invoice_number,
        charge_month,
        action,
        previous_amount,
        new_amount,
        delta,
        reason,
        source_due_date,
        source_amount_due,
        days_overdue,
        rate,
        credit_note_id,
        credit_note_number,
        contact_id,
        contact_name,
        notes
      ) OUTPUT INSERTED.id
      VALUES (
        @sourceInvoiceId,
        @sourceInvoiceNumber,
        @interestInvoiceId,
        @interestInvoiceNumber,
        @chargeMonth,
        @action,
        @previousAmount,
        @newAmount,
        @delta,
        @reason,
        @sourceDueDate,
        @sourceAmountDue,
        @daysOverdue,
        @rate,
        @creditNoteId,
        @creditNoteNumber,
        @contactId,
        @contactName,
        @notes
      )
    `);

  return result.recordset[0].id.toString();
}

/**
 * Get the most recent ledger entry for a source invoice
 * Used to determine previous amount charged
 */
export async function getLatestLedgerEntryForInvoice(sourceInvoiceId: string): Promise<InterestLedgerEntry | null> {
  const db = await getPool();

  const result = await db.request()
    .input('sourceInvoiceId', sql.NVarChar, sourceInvoiceId)
    .query(`
      SELECT TOP 1 *
      FROM interest_ledger
      WHERE source_invoice_id = @sourceInvoiceId
      ORDER BY created DESC
    `);

  return result.recordset.length > 0 ? mapLedgerFromDb(result.recordset[0]) : null;
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
  const db = await getPool();

  const result = await db.request()
    .input('entryId', sql.Int, parseInt(entryId, 10))
    .query(`
      SELECT *
      FROM interest_ledger
      WHERE id = @entryId
    `);

  return result.recordset.length > 0 ? mapLedgerFromDb(result.recordset[0]) : null;
}

/**
 * Get ledger entries for a specific source invoice and charge month
 */
export async function getLedgerEntriesForMonth(
  sourceInvoiceId: string,
  chargeMonth: string
): Promise<InterestLedgerEntry[]> {
  const db = await getPool();

  const result = await db.request()
    .input('sourceInvoiceId', sql.NVarChar, sourceInvoiceId)
    .input('chargeMonth', sql.NVarChar, chargeMonth)
    .query(`
      SELECT *
      FROM interest_ledger
      WHERE source_invoice_id = @sourceInvoiceId
        AND charge_month = @chargeMonth
      ORDER BY created DESC
    `);

  return result.recordset.map(mapLedgerFromDb);
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
  const db = await getPool();

  const result = await db.request()
    .input('sourceInvoiceId', sql.NVarChar, sourceInvoiceId)
    .input('chargeMonth', sql.NVarChar, chargeMonth)
    .query(`
      SELECT TOP 1 *
      FROM interest_ledger
      WHERE source_invoice_id = @sourceInvoiceId
        AND charge_month = @chargeMonth
      ORDER BY created DESC
    `);

  return result.recordset.length > 0 ? mapLedgerFromDb(result.recordset[0]) : null;
}

/**
 * Get all ledger entries (for bulk operations)
 */
export async function getAllLedgerEntries(): Promise<InterestLedgerEntry[]> {
  const db = await getPool();

  const result = await db.request().query(`
    SELECT *
    FROM interest_ledger
    ORDER BY created DESC
  `);

  return result.recordset.map(mapLedgerFromDb);
}

/**
 * Delete a ledger entry by ID
 */
export async function deleteLedgerEntry(entryId: string): Promise<void> {
  const db = await getPool();

  await db.request()
    .input('entryId', sql.Int, parseInt(entryId, 10))
    .query(`
      DELETE FROM interest_ledger
      WHERE id = @entryId
    `);
}

// ============================================================================
// Mappers
// ============================================================================

function mapConfigFromDb(row: any): InterestConfig {
  return {
    id: row.id.toString(),
    xeroContactId: row.xero_contact_id,
    contactName: row.contact_name,
    annualRate: row.annual_rate,
    minDaysOverdue: row.min_days_overdue ?? 30,
    minChargeAmount: row.min_charge_amount ?? 1,
    currencyCode: row.currency_code || undefined,
    isActive: row.is_active === true || row.is_active === 1,
    lastRunDate: row.last_run_date ? new Date(row.last_run_date) : undefined,
    lastInvoiceId: row.last_invoice_id || undefined,
    notes: row.notes || undefined,
  };
}

function mapLedgerFromDb(row: any): InterestLedgerEntry {
  return {
    id: row.id.toString(),
    sourceInvoiceId: row.source_invoice_id,
    sourceInvoiceNumber: row.source_invoice_number,
    interestInvoiceId: row.interest_invoice_id,
    interestInvoiceNumber: row.interest_invoice_number || undefined,
    chargeMonth: row.charge_month || '',
    action: row.action,
    previousAmount: parseFloat(row.previous_amount) || 0,
    newAmount: parseFloat(row.new_amount) || 0,
    delta: parseFloat(row.delta) || 0,
    reason: row.reason,
    sourceDueDate: new Date(row.source_due_date),
    sourceAmountDue: parseFloat(row.source_amount_due) || 0,
    daysOverdue: row.days_overdue || 0,
    rate: row.rate,
    creditNoteId: row.credit_note_id || undefined,
    creditNoteNumber: row.credit_note_number || undefined,
    contactId: row.contact_id,
    contactName: row.contact_name,
    created: new Date(row.created),
    notes: row.notes || undefined,
  };
}

// ============================================================================
// SQL Schema (for reference - run this to create tables)
// ============================================================================
/*

-- Table: interest_configs
CREATE TABLE interest_configs (
  id INT IDENTITY(1,1) PRIMARY KEY,
  xero_contact_id NVARCHAR(50) NOT NULL UNIQUE,
  contact_name NVARCHAR(255) NOT NULL,
  annual_rate DECIMAL(5,2) NOT NULL,
  min_days_overdue INT NOT NULL DEFAULT 30,
  min_charge_amount DECIMAL(18,2) NOT NULL DEFAULT 1,
  currency_code NVARCHAR(10) NULL,
  is_active BIT NOT NULL DEFAULT 1,
  last_run_date DATETIME2 NULL,
  last_invoice_id NVARCHAR(50) NULL,
  notes NVARCHAR(MAX) NULL,
  created DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
  updated DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_interest_configs_contact ON interest_configs(xero_contact_id);
CREATE INDEX IX_interest_configs_active ON interest_configs(is_active);

-- Table: interest_ledger
CREATE TABLE interest_ledger (
  id INT IDENTITY(1,1) PRIMARY KEY,
  source_invoice_id NVARCHAR(50) NOT NULL,
  source_invoice_number NVARCHAR(50) NOT NULL,
  interest_invoice_id NVARCHAR(50) NOT NULL,
  interest_invoice_number NVARCHAR(50) NULL,
  charge_month NVARCHAR(7) NOT NULL,
  action NVARCHAR(50) NOT NULL,
  previous_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  new_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  delta DECIMAL(18,2) NOT NULL DEFAULT 0,
  reason NVARCHAR(50) NOT NULL,
  source_due_date DATETIME2 NOT NULL,
  source_amount_due DECIMAL(18,2) NOT NULL DEFAULT 0,
  days_overdue INT NOT NULL DEFAULT 0,
  rate DECIMAL(5,2) NOT NULL,
  credit_note_id NVARCHAR(50) NULL,
  credit_note_number NVARCHAR(50) NULL,
  contact_id NVARCHAR(50) NOT NULL,
  contact_name NVARCHAR(255) NOT NULL,
  notes NVARCHAR(MAX) NULL,
  created DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX IX_interest_ledger_source ON interest_ledger(source_invoice_id);
CREATE INDEX IX_interest_ledger_contact ON interest_ledger(contact_id);
CREATE INDEX IX_interest_ledger_month ON interest_ledger(source_invoice_id, charge_month);
CREATE INDEX IX_interest_ledger_created ON interest_ledger(created DESC);

*/
