"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorTemplate = exports.successTemplate = exports.signupFormTemplate = exports.emailFormTemplate = exports.createMcpAuthHandlers = exports.createProductSecretGetter = exports.createSaasDbPasswordGetter = exports.setSecret = exports.getSecret = exports.updateProductTokens = exports.getProductConnection = exports.saveProductConnection = exports.checkProductAccess = exports.grantProductAccess = exports.validateApiKey = exports.createApiKey = exports.generateApiKey = exports.getCustomerById = exports.getCustomerByEmail = exports.createCustomer = exports.initDatabase = void 0;
// Database
var database_js_1 = require("./database.js");
Object.defineProperty(exports, "initDatabase", { enumerable: true, get: function () { return database_js_1.initDatabase; } });
Object.defineProperty(exports, "createCustomer", { enumerable: true, get: function () { return database_js_1.createCustomer; } });
Object.defineProperty(exports, "getCustomerByEmail", { enumerable: true, get: function () { return database_js_1.getCustomerByEmail; } });
Object.defineProperty(exports, "getCustomerById", { enumerable: true, get: function () { return database_js_1.getCustomerById; } });
Object.defineProperty(exports, "generateApiKey", { enumerable: true, get: function () { return database_js_1.generateApiKey; } });
Object.defineProperty(exports, "createApiKey", { enumerable: true, get: function () { return database_js_1.createApiKey; } });
Object.defineProperty(exports, "validateApiKey", { enumerable: true, get: function () { return database_js_1.validateApiKey; } });
Object.defineProperty(exports, "grantProductAccess", { enumerable: true, get: function () { return database_js_1.grantProductAccess; } });
Object.defineProperty(exports, "checkProductAccess", { enumerable: true, get: function () { return database_js_1.checkProductAccess; } });
Object.defineProperty(exports, "saveProductConnection", { enumerable: true, get: function () { return database_js_1.saveProductConnection; } });
Object.defineProperty(exports, "getProductConnection", { enumerable: true, get: function () { return database_js_1.getProductConnection; } });
Object.defineProperty(exports, "updateProductTokens", { enumerable: true, get: function () { return database_js_1.updateProductTokens; } });
// Key Vault
var keyvault_js_1 = require("./keyvault.js");
Object.defineProperty(exports, "getSecret", { enumerable: true, get: function () { return keyvault_js_1.getSecret; } });
Object.defineProperty(exports, "setSecret", { enumerable: true, get: function () { return keyvault_js_1.setSecret; } });
Object.defineProperty(exports, "createSaasDbPasswordGetter", { enumerable: true, get: function () { return keyvault_js_1.createSaasDbPasswordGetter; } });
Object.defineProperty(exports, "createProductSecretGetter", { enumerable: true, get: function () { return keyvault_js_1.createProductSecretGetter; } });
// Handlers
var handlers_js_1 = require("./handlers.js");
Object.defineProperty(exports, "createMcpAuthHandlers", { enumerable: true, get: function () { return handlers_js_1.createMcpAuthHandlers; } });
// Templates (for customization)
var index_js_1 = require("./templates/index.js");
Object.defineProperty(exports, "emailFormTemplate", { enumerable: true, get: function () { return index_js_1.emailFormTemplate; } });
Object.defineProperty(exports, "signupFormTemplate", { enumerable: true, get: function () { return index_js_1.signupFormTemplate; } });
Object.defineProperty(exports, "successTemplate", { enumerable: true, get: function () { return index_js_1.successTemplate; } });
Object.defineProperty(exports, "errorTemplate", { enumerable: true, get: function () { return index_js_1.errorTemplate; } });
//# sourceMappingURL=index.js.map