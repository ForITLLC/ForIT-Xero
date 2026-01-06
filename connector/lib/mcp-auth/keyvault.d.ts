/**
 * ForIT MCP Auth - Azure Key Vault Helpers
 */
/**
 * Get a secret from Key Vault
 */
export declare function getSecret(vaultUrl: string, secretName: string): Promise<string>;
/**
 * Set a secret in Key Vault
 */
export declare function setSecret(vaultUrl: string, secretName: string, value: string): Promise<void>;
/**
 * Create a password getter for the SaaS database
 */
export declare function createSaasDbPasswordGetter(): () => Promise<string>;
/**
 * Create a secret getter for a product's Key Vault
 */
export declare function createProductSecretGetter(productName: string, secretName: string): () => Promise<string>;
//# sourceMappingURL=keyvault.d.ts.map