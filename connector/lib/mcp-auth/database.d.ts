/**
 * ForIT MCP Auth - Database Operations
 *
 * Shared database functions for all MCP products.
 * Connects to forit-saas-db on Azure SQL.
 */
import type { Customer, ApiKey, ProductConnection, DatabaseConfig } from './types/index.js';
/**
 * Initialize database connection configuration
 */
export declare function initDatabase(config: DatabaseConfig): void;
export declare function createCustomer(email: string, companyName?: string): Promise<Customer>;
export declare function getCustomerByEmail(email: string): Promise<Customer | null>;
export declare function getCustomerById(id: string): Promise<Customer | null>;
/**
 * Generate a new API key with prefix, hash
 * Format: fmcp_{32 random bytes base64url}
 */
export declare function generateApiKey(): {
    key: string;
    prefix: string;
    hash: string;
};
export declare function createApiKey(customerId: string, name?: string): Promise<{
    apiKey: ApiKey;
    plainKey: string;
}>;
export declare function validateApiKey(key: string): Promise<Customer | null>;
export declare function grantProductAccess(customerId: string, productSlug: string, status?: 'trial' | 'active'): Promise<void>;
export declare function checkProductAccess(customerId: string, productSlug: string): Promise<boolean>;
export declare function saveProductConnection(tableName: string, customerId: string, tenantId: string, tenantName: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<ProductConnection>;
export declare function getProductConnection(tableName: string, customerId: string): Promise<ProductConnection | null>;
export declare function updateProductTokens(tableName: string, customerId: string, accessToken: string, refreshToken: string, expiresAt: number): Promise<void>;
//# sourceMappingURL=database.d.ts.map