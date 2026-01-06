"use strict";
/**
 * ForIT MCP Auth - Request Handlers
 *
 * Factory function to create signup, callback, and token endpoints
 * for any OAuth-based MCP product.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpAuthHandlers = createMcpAuthHandlers;
const database_js_1 = require("./database.js");
const index_js_1 = require("./templates/index.js");
/**
 * Create MCP auth handlers for a product
 */
function createMcpAuthHandlers(config) {
    const connectionTable = `${config.oauthProvider}_connections`;
    return {
        signup: createSignupHandler(config),
        callback: createCallbackHandler(config, connectionTable),
        tokens: createTokensHandler(config, connectionTable),
    };
}
function createSignupHandler(config) {
    return async (request, context) => {
        try {
            const email = request.query.get('email');
            // Step 1: No email - show email entry form
            if (!email) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' },
                    body: (0, index_js_1.emailFormTemplate)(config),
                };
            }
            // Step 2: Check if customer exists with active access
            const existingCustomer = await (0, database_js_1.getCustomerByEmail)(email);
            if (existingCustomer) {
                const hasAccess = await (0, database_js_1.checkProductAccess)(existingCustomer.id, config.productSlug);
                if (hasAccess) {
                    // Existing customer with access - go straight to OAuth
                    context.log('Existing customer with access, proceeding to OAuth', { email });
                    const state = encodeState({ customerId: existingCustomer.id });
                    const redirectUri = `${config.baseUrl}/api/mcp/callback`;
                    const authUrl = await config.oauth.buildConsentUrl(redirectUri, state);
                    return { status: 302, headers: { Location: authUrl } };
                }
            }
            // Step 3: New customer or no access - show signup form
            const companyName = request.query.get('company');
            if (!companyName) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' },
                    body: (0, index_js_1.signupFormTemplate)(config, email),
                };
            }
            // Step 4: Create customer and proceed to OAuth
            let customer = await (0, database_js_1.getCustomerByEmail)(email);
            if (!customer) {
                customer = await (0, database_js_1.createCustomer)(email, companyName);
                await (0, database_js_1.grantProductAccess)(customer.id, config.productSlug);
                context.log('Created new customer', { customerId: customer.id, email });
            }
            // Build OAuth URL with state containing customer ID
            const state = encodeState({ customerId: customer.id });
            const redirectUri = `${config.baseUrl}/api/mcp/callback`;
            const authUrl = await config.oauth.buildConsentUrl(redirectUri, state);
            context.log('Redirecting to OAuth', { customerId: customer.id });
            return {
                status: 302,
                headers: { Location: authUrl },
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            context.error('Signup failed', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'text/html' },
                body: (0, index_js_1.errorTemplate)(config, errorMessage),
            };
        }
    };
}
function createCallbackHandler(config, connectionTable) {
    return async (request, context) => {
        try {
            const code = request.query.get('code');
            const state = request.query.get('state');
            if (!code) {
                return { status: 400, body: 'Missing authorization code' };
            }
            if (!state) {
                return { status: 400, body: 'Missing state parameter' };
            }
            // Decode customer ID from state
            const stateData = decodeState(state);
            const customerId = stateData?.customerId;
            if (!customerId) {
                return { status: 400, body: 'Invalid state parameter' };
            }
            const customer = await (0, database_js_1.getCustomerById)(customerId);
            if (!customer) {
                return { status: 400, body: 'Customer not found' };
            }
            context.log('Processing OAuth callback', { customerId: customer.id, email: customer.email });
            // Exchange code for tokens
            const redirectUri = `${config.baseUrl}/api/mcp/callback`;
            const tokenSet = await config.oauth.exchangeCode(code, redirectUri);
            if (!tokenSet.refresh_token) {
                throw new Error('No refresh token received');
            }
            // Get tenant info if provider supports it
            let tenantId = 'default';
            let tenantName = 'Default';
            if (config.oauth.getTenantInfo) {
                const tenantInfo = await config.oauth.getTenantInfo(tokenSet.access_token);
                tenantId = tenantInfo.tenantId;
                tenantName = tenantInfo.tenantName;
            }
            // Save connection to database
            await (0, database_js_1.saveProductConnection)(connectionTable, customer.id, tenantId, tenantName, tokenSet.access_token, tokenSet.refresh_token, tokenSet.expires_at || 0);
            // Generate API key for customer
            const { plainKey } = await (0, database_js_1.createApiKey)(customer.id, 'Default');
            context.log('OAuth complete, API key generated', { customerId: customer.id, tenantId });
            return {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
                body: (0, index_js_1.successTemplate)(config, customer, tenantName, plainKey),
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            context.error('OAuth callback failed', error);
            return {
                status: 500,
                headers: { 'Content-Type': 'text/html' },
                body: (0, index_js_1.errorTemplate)(config, errorMessage),
            };
        }
    };
}
function createTokensHandler(config, connectionTable) {
    return async (request, context) => {
        try {
            const apiKey = request.headers.get('x-api-key');
            if (!apiKey) {
                return { status: 401, jsonBody: { error: 'Missing API key' } };
            }
            // Validate API key and get customer
            const customer = await (0, database_js_1.validateApiKey)(apiKey);
            if (!customer) {
                return { status: 401, jsonBody: { error: 'Invalid API key' } };
            }
            // Check product access
            const hasAccess = await (0, database_js_1.checkProductAccess)(customer.id, config.productSlug);
            if (!hasAccess) {
                return {
                    status: 403,
                    jsonBody: { error: `No active subscription. Visit ${config.baseUrl}/api/mcp/signup to subscribe.` },
                };
            }
            // Get connection
            const connection = await (0, database_js_1.getProductConnection)(connectionTable, customer.id);
            if (!connection) {
                return {
                    status: 404,
                    jsonBody: { error: 'Not connected. Visit /api/mcp/signup to connect.' },
                };
            }
            // Check if token needs refresh (5 min buffer)
            const now = Math.floor(Date.now() / 1000);
            if (connection.expires_at && now > connection.expires_at - 300) {
                context.log('Refreshing expired token', { customerId: customer.id });
                const newTokenSet = await config.oauth.refreshToken(connection.refresh_token);
                await (0, database_js_1.updateProductTokens)(connectionTable, customer.id, newTokenSet.access_token, newTokenSet.refresh_token || connection.refresh_token, newTokenSet.expires_at || 0);
                return {
                    status: 200,
                    jsonBody: {
                        access_token: newTokenSet.access_token,
                        refresh_token: newTokenSet.refresh_token || connection.refresh_token,
                        tenant_id: connection.tenant_id,
                        expires_at: newTokenSet.expires_at,
                    },
                };
            }
            return {
                status: 200,
                jsonBody: {
                    access_token: connection.access_token,
                    refresh_token: connection.refresh_token,
                    tenant_id: connection.tenant_id,
                    expires_at: connection.expires_at,
                },
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            context.error('Failed to get tokens', error);
            return {
                status: 500,
                jsonBody: { error: errorMessage },
            };
        }
    };
}
// ============================================================
// Helpers
// ============================================================
function encodeState(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64');
}
function decodeState(state) {
    try {
        return JSON.parse(Buffer.from(state, 'base64').toString());
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=handlers.js.map