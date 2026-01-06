import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

let secretClient: SecretClient | null = null;

function getSecretClient(): SecretClient {
  if (!secretClient) {
    const keyVaultUrl = process.env.KEY_VAULT_URL;
    if (!keyVaultUrl) {
      throw new Error('KEY_VAULT_URL environment variable not set');
    }
    const credential = new DefaultAzureCredential();
    secretClient = new SecretClient(keyVaultUrl, credential);
  }
  return secretClient;
}

/**
 * Get a secret from Azure Key Vault
 */
export async function getSecret(secretName: string): Promise<string> {
  const client = getSecretClient();
  const secret = await client.getSecret(secretName);
  if (!secret.value) {
    throw new Error(`Secret ${secretName} not found or has no value`);
  }
  return secret.value;
}

/**
 * Set a secret in Azure Key Vault
 */
export async function setSecret(secretName: string, value: string): Promise<void> {
  const client = getSecretClient();
  await client.setSecret(secretName, value);
}

// Secret names used by this application
export const SECRETS = {
  XERO_CLIENT_SECRET: 'xero-client-secret',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  NOTIFICATION_EMAIL: 'notification-email',
  MCP_XERO_CLIENT_SECRET: 'MCP-XERO-CLIENT-SECRET',
} as const;
