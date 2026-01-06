"use strict";
/**
 * ForIT MCP Auth - Azure Key Vault Helpers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
exports.setSecret = setSecret;
exports.createSaasDbPasswordGetter = createSaasDbPasswordGetter;
exports.createProductSecretGetter = createProductSecretGetter;
const identity_1 = require("@azure/identity");
const keyvault_secrets_1 = require("@azure/keyvault-secrets");
const credential = new identity_1.DefaultAzureCredential();
const clients = new Map();
/**
 * Get a Key Vault client for a specific vault
 */
function getClient(vaultUrl) {
    if (!clients.has(vaultUrl)) {
        clients.set(vaultUrl, new keyvault_secrets_1.SecretClient(vaultUrl, credential));
    }
    return clients.get(vaultUrl);
}
/**
 * Get a secret from Key Vault
 */
async function getSecret(vaultUrl, secretName) {
    const client = getClient(vaultUrl);
    const secret = await client.getSecret(secretName);
    return secret.value || '';
}
/**
 * Set a secret in Key Vault
 */
async function setSecret(vaultUrl, secretName, value) {
    const client = getClient(vaultUrl);
    await client.setSecret(secretName, value);
}
/**
 * Create a password getter for the SaaS database
 */
function createSaasDbPasswordGetter() {
    const vaultUrl = 'https://forit-saas-kv.vault.azure.net';
    return () => getSecret(vaultUrl, 'SAAS-SQL-PASSWORD');
}
/**
 * Create a secret getter for a product's Key Vault
 */
function createProductSecretGetter(productName, secretName) {
    const vaultUrl = `https://forit-${productName}-kv.vault.azure.net`;
    return () => getSecret(vaultUrl, secretName);
}
//# sourceMappingURL=keyvault.js.map