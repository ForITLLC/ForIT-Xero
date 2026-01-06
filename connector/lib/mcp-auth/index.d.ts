/**
 * @forit/mcp-auth
 *
 * Shared MCP authentication components for ForIT products.
 *
 * @example
 * ```typescript
 * import { createMcpAuthHandlers, initDatabase, createSaasDbPasswordGetter } from '@forit/mcp-auth';
 * import { app } from '@azure/functions';
 *
 * // Initialize database
 * initDatabase({
 *   server: 'forit-saas-sql.database.windows.net',
 *   database: 'forit-saas-db',
 *   user: 'foritadmin',
 *   getPassword: createSaasDbPasswordGetter(),
 * });
 *
 * // Create handlers
 * const handlers = createMcpAuthHandlers({
 *   productSlug: 'xero-connector',
 *   productName: 'ForIT Xero MCP',
 *   oauthProvider: 'xero',
 *   baseUrl: 'https://forit-xero-mcp.azurewebsites.net',
 *   scopes: ['accounting.transactions', 'offline_access'],
 *   features: ['Delete payments', 'Recode invoices'],
 *   pricing: { monthly: 9.99, trialDays: 14 },
 *   npmPackage: 'forit-xero-mcp',
 *   oauth: {
 *     clientId: process.env.XERO_CLIENT_ID!,
 *     getClientSecret: () => getSecret('XERO-CLIENT-SECRET'),
 *     buildConsentUrl: async (redirectUri, state) => { ... },
 *     exchangeCode: async (code, redirectUri) => { ... },
 *     refreshToken: async (refreshToken) => { ... },
 *     getTenantInfo: async (accessToken) => { ... },
 *   },
 * });
 *
 * // Register endpoints
 * app.http('Signup', { route: 'mcp/signup', handler: handlers.signup });
 * app.http('Callback', { route: 'mcp/callback', handler: handlers.callback });
 * app.http('Tokens', { route: 'mcp/tokens', handler: handlers.tokens });
 * ```
 */
export type { Customer, ApiKey, ProductConnection, Product, CustomerProduct, McpAuthConfig, OAuthTokens, TenantInfo, DatabaseConfig, } from './types/index.js';
export { initDatabase, createCustomer, getCustomerByEmail, getCustomerById, generateApiKey, createApiKey, validateApiKey, grantProductAccess, checkProductAccess, saveProductConnection, getProductConnection, updateProductTokens, } from './database.js';
export { getSecret, setSecret, createSaasDbPasswordGetter, createProductSecretGetter, } from './keyvault.js';
export { createMcpAuthHandlers } from './handlers.js';
export type { McpAuthHandlers } from './handlers.js';
export { emailFormTemplate, signupFormTemplate, successTemplate, errorTemplate, } from './templates/index.js';
//# sourceMappingURL=index.d.ts.map