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

/**
 * Disable the current version of a secret without deleting it. Used
 * for cleanup when Xero tells us a refresh token is dead — we want
 * the audit trail preserved and the ability to recover, but we don't
 * want any caller (e.g. interest app) to pick the stale value up.
 *
 * No-ops silently if the secret does not currently exist.
 */
export async function disableSecret(name: string): Promise<void> {
  try {
    const current = await client.getSecret(name);
    if (!current.properties?.version) return;
    await client.updateSecretProperties(name, current.properties.version, { enabled: false });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return;
    throw err;
  }
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
