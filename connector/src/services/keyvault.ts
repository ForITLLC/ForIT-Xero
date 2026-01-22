import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

const credential = new DefaultAzureCredential();
const vaultUrl = 'https://forit-xero-mcp-kv.vault.azure.net';
const client = new SecretClient(vaultUrl, credential);

export async function getSecret(name: string): Promise<string> {
  const secret = await client.getSecret(name);
  return secret.value || '';
}

export async function setSecret(name: string, value: string): Promise<void> {
  await client.setSecret(name, value);
}

export const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  // Shared with interest app
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  // Portal-to-connector authentication
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  // Stripe integration
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE-WEBHOOK-SECRET',
};
