"use strict";
/**
 * ForIT MCP Auth - Database Operations
 *
 * Shared database functions for all MCP products.
 * Connects to forit-saas-db on Azure SQL.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDatabase = initDatabase;
exports.createCustomer = createCustomer;
exports.getCustomerByEmail = getCustomerByEmail;
exports.getCustomerById = getCustomerById;
exports.generateApiKey = generateApiKey;
exports.createApiKey = createApiKey;
exports.validateApiKey = validateApiKey;
exports.grantProductAccess = grantProductAccess;
exports.checkProductAccess = checkProductAccess;
exports.saveProductConnection = saveProductConnection;
exports.getProductConnection = getProductConnection;
exports.updateProductTokens = updateProductTokens;
const mssql_1 = __importDefault(require("mssql"));
const crypto_1 = __importDefault(require("crypto"));
let pool = null;
let dbConfig = null;
/**
 * Initialize database connection configuration
 */
function initDatabase(config) {
    dbConfig = config;
}
/**
 * Get or create database connection pool
 */
async function getPool() {
    if (pool)
        return pool;
    if (!dbConfig) {
        throw new Error('Database not initialized. Call initDatabase() first.');
    }
    const password = await dbConfig.getPassword();
    pool = await mssql_1.default.connect({
        server: dbConfig.server,
        database: dbConfig.database,
        user: dbConfig.user,
        password,
        options: {
            encrypt: true,
            trustServerCertificate: false,
        },
    });
    return pool;
}
// ============================================================
// Customer Functions
// ============================================================
async function createCustomer(email, companyName) {
    const db = await getPool();
    const result = await db.request()
        .input('email', mssql_1.default.NVarChar, email)
        .input('company_name', mssql_1.default.NVarChar, companyName || null)
        .query(`
      INSERT INTO customers (email, company_name)
      OUTPUT INSERTED.*
      VALUES (@email, @company_name)
    `);
    return result.recordset[0];
}
async function getCustomerByEmail(email) {
    const db = await getPool();
    const result = await db.request()
        .input('email', mssql_1.default.NVarChar, email)
        .query('SELECT * FROM customers WHERE email = @email');
    return result.recordset[0] || null;
}
async function getCustomerById(id) {
    const db = await getPool();
    const result = await db.request()
        .input('id', mssql_1.default.UniqueIdentifier, id)
        .query('SELECT * FROM customers WHERE id = @id');
    return result.recordset[0] || null;
}
// ============================================================
// API Key Functions
// ============================================================
/**
 * Generate a new API key with prefix, hash
 * Format: fmcp_{32 random bytes base64url}
 */
function generateApiKey() {
    const keyBytes = crypto_1.default.randomBytes(32);
    const key = `fmcp_${keyBytes.toString('base64url')}`;
    const prefix = key.substring(0, 12);
    const hash = crypto_1.default.createHash('sha256').update(key).digest('hex');
    return { key, prefix, hash };
}
async function createApiKey(customerId, name = 'Default') {
    const { key, prefix, hash } = generateApiKey();
    const db = await getPool();
    const result = await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .input('key_hash', mssql_1.default.NVarChar, hash)
        .input('key_prefix', mssql_1.default.NVarChar, prefix)
        .input('name', mssql_1.default.NVarChar, name)
        .query(`
      INSERT INTO api_keys (customer_id, key_hash, key_prefix, name)
      OUTPUT INSERTED.*
      VALUES (@customer_id, @key_hash, @key_prefix, @name)
    `);
    return { apiKey: result.recordset[0], plainKey: key };
}
async function validateApiKey(key) {
    const hash = crypto_1.default.createHash('sha256').update(key).digest('hex');
    const db = await getPool();
    const result = await db.request()
        .input('key_hash', mssql_1.default.NVarChar, hash)
        .query(`
      SELECT c.* FROM customers c
      JOIN api_keys ak ON c.id = ak.customer_id
      WHERE ak.key_hash = @key_hash AND ak.is_active = 1
    `);
    if (result.recordset[0]) {
        // Update last_used_at
        await db.request()
            .input('key_hash', mssql_1.default.NVarChar, hash)
            .query('UPDATE api_keys SET last_used_at = GETUTCDATE() WHERE key_hash = @key_hash');
    }
    return result.recordset[0] || null;
}
// ============================================================
// Product Access Functions
// ============================================================
async function grantProductAccess(customerId, productSlug, status = 'trial') {
    const db = await getPool();
    await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .input('product_slug', mssql_1.default.NVarChar, productSlug)
        .input('status', mssql_1.default.NVarChar, status)
        .query(`
      INSERT INTO customer_products (customer_id, product_id, status)
      SELECT @customer_id, p.id, @status
      FROM products p WHERE p.slug = @product_slug
      AND NOT EXISTS (
        SELECT 1 FROM customer_products cp
        WHERE cp.customer_id = @customer_id AND cp.product_id = p.id
      )
    `);
}
async function checkProductAccess(customerId, productSlug) {
    const db = await getPool();
    const result = await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .input('product_slug', mssql_1.default.NVarChar, productSlug)
        .query(`
      SELECT 1 FROM customer_products cp
      JOIN products p ON cp.product_id = p.id
      WHERE cp.customer_id = @customer_id
        AND p.slug = @product_slug
        AND cp.status IN ('trial', 'active')
    `);
    return result.recordset.length > 0;
}
// ============================================================
// Product Connection Functions (Generic for any OAuth provider)
// ============================================================
async function saveProductConnection(tableName, customerId, tenantId, tenantName, accessToken, refreshToken, expiresAt) {
    const db = await getPool();
    // Use parameterized table name (safe because we control it)
    const result = await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .input('tenant_id', mssql_1.default.NVarChar, tenantId)
        .input('tenant_name', mssql_1.default.NVarChar, tenantName)
        .input('access_token', mssql_1.default.NVarChar(mssql_1.default.MAX), accessToken)
        .input('refresh_token', mssql_1.default.NVarChar(mssql_1.default.MAX), refreshToken)
        .input('expires_at', mssql_1.default.BigInt, expiresAt)
        .query(`
      MERGE ${tableName} AS target
      USING (SELECT @customer_id as customer_id, @tenant_id as tenant_id) AS source
      ON target.customer_id = source.customer_id AND target.tenant_id = source.tenant_id
      WHEN MATCHED THEN
        UPDATE SET
          tenant_name = @tenant_name,
          access_token = @access_token,
          refresh_token = @refresh_token,
          expires_at = @expires_at,
          updated_at = GETUTCDATE()
      WHEN NOT MATCHED THEN
        INSERT (customer_id, tenant_id, tenant_name, access_token, refresh_token, expires_at)
        VALUES (@customer_id, @tenant_id, @tenant_name, @access_token, @refresh_token, @expires_at)
      OUTPUT INSERTED.*;
    `);
    return result.recordset[0];
}
async function getProductConnection(tableName, customerId) {
    const db = await getPool();
    const result = await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .query(`SELECT * FROM ${tableName} WHERE customer_id = @customer_id`);
    return result.recordset[0] || null;
}
async function updateProductTokens(tableName, customerId, accessToken, refreshToken, expiresAt) {
    const db = await getPool();
    await db.request()
        .input('customer_id', mssql_1.default.UniqueIdentifier, customerId)
        .input('access_token', mssql_1.default.NVarChar(mssql_1.default.MAX), accessToken)
        .input('refresh_token', mssql_1.default.NVarChar(mssql_1.default.MAX), refreshToken)
        .input('expires_at', mssql_1.default.BigInt, expiresAt)
        .query(`
      UPDATE ${tableName}
      SET access_token = @access_token,
          refresh_token = @refresh_token,
          expires_at = @expires_at,
          updated_at = GETUTCDATE()
      WHERE customer_id = @customer_id
    `);
}
//# sourceMappingURL=database.js.map