/**
 * ForIT MCP Auth Types
 */
export interface Customer {
    id: string;
    email: string;
    company_name?: string;
    stripe_customer_id?: string;
    subscription_status: string;
    subscription_ends_at?: Date;
    created_at: Date;
    updated_at: Date;
}
export interface ApiKey {
    id: string;
    customer_id: string;
    key_hash: string;
    key_prefix: string;
    name: string;
    is_active: boolean;
    created_at: Date;
    last_used_at?: Date;
}
export interface ProductConnection {
    id: string;
    customer_id: string;
    tenant_id: string;
    tenant_name?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    created_at: Date;
    updated_at: Date;
}
export interface Product {
    id: string;
    slug: string;
    name: string;
    description?: string;
    price_monthly?: number;
    price_annual?: number;
    is_active: boolean;
}
export interface CustomerProduct {
    id: string;
    customer_id: string;
    product_id: string;
    status: 'trial' | 'active' | 'expired' | 'cancelled';
    trial_ends_at?: Date;
    created_at: Date;
}
/**
 * Configuration for MCP Auth handlers
 */
export interface McpAuthConfig {
    /** Product slug in database (e.g., 'xero-connector') */
    productSlug: string;
    /** Display name for the product */
    productName: string;
    /** OAuth provider name (for connection table naming) */
    oauthProvider: string;
    /** Base URL for this MCP (e.g., https://forit-xero-mcp.azurewebsites.net) */
    baseUrl: string;
    /** OAuth scopes to request */
    scopes: string[];
    /** Features to display on signup page */
    features: string[];
    /** Pricing info */
    pricing: {
        monthly: number;
        annual?: number;
        trialDays: number;
    };
    /** OAuth client configuration */
    oauth: {
        clientId: string;
        getClientSecret: () => Promise<string>;
        buildConsentUrl: (redirectUri: string, state: string) => Promise<string>;
        exchangeCode: (code: string, redirectUri: string) => Promise<OAuthTokens>;
        refreshToken: (refreshToken: string) => Promise<OAuthTokens>;
        getTenantInfo?: (accessToken: string) => Promise<TenantInfo>;
    };
    /** npm package name for Claude Code config */
    npmPackage: string;
}
export interface OAuthTokens {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
}
export interface TenantInfo {
    tenantId: string;
    tenantName: string;
}
export interface DatabaseConfig {
    server: string;
    database: string;
    user: string;
    getPassword: () => Promise<string>;
}
//# sourceMappingURL=index.d.ts.map