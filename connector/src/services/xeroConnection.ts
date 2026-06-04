import { XeroClient } from 'xero-node';
import { getSecret, setSecret, disableSecret, SECRETS } from './keyvault';
import {
  getXeroConnection,
  updateXeroTokens,
  deleteXeroConnectionsByCustomer,
  XeroConnection,
} from './database';

/**
 * Centralized Xero token-refresh + connection-state service.
 *
 * Background: any failure between `apiCallback` returning a new tokenSet
 * and saveXeroConnection committing it leaves Xero rotated and the DB
 * stale. Once stale, every subsequent refresh attempt gets
 * `invalid_grant: Refresh token not found` from Xero, but the system
 * still reported "connected" because the row still existed. This
 * module centralizes refresh + invalid_grant cleanup so every Xero
 * call site benefits.
 */

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const BASE_URL = process.env.BASE_URL || 'https://xero.forit.io';

export type RefreshResult =
  | { status: 'connected'; tenantId: string; tenantName: string; accessToken: string; refreshToken: string; expiresAt: number }
  | { status: 'not_connected' }
  | { status: 'expired'; reason: string }
  | { status: 'transient'; reason: string };

/**
 * Detect invalid_grant errors raised by xero-node / openid-client.
 * The OPError shape has .error and .error_description; some wrappers
 * stringify into the message. Match both.
 */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { error?: string; error_description?: string; message?: string; name?: string };
  if (e.error === 'invalid_grant') return true;
  const haystack = `${e.error || ''} ${e.error_description || ''} ${e.message || ''}`.toLowerCase();
  if (haystack.includes('invalid_grant')) return true;
  if (haystack.includes('refresh token not found')) return true;
  if (haystack.includes('no refresh token returned')) return true;
  return false;
}

/**
 * Delete every connection row for a customer AND disable the KV
 * refresh-token secret. Used when Xero tells us the refresh token is
 * dead — leaving the row in place would make the portal lie.
 */
export async function cleanupDeadConnection(customerId: string): Promise<void> {
  await deleteXeroConnectionsByCustomer(customerId);
  try {
    await disableSecret(SECRETS.XERO_REFRESH_TOKEN);
  } catch {
    // KV may already have no current version, or RBAC missing — DB cleanup
    // is the truth source for the portal, so don't block on KV.
  }
}

async function getXeroClientForRefresh(): Promise<XeroClient> {
  if (!XERO_CLIENT_ID) {
    throw new Error('XERO_CLIENT_ID not configured');
  }
  const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);
  const client = new XeroClient({
    clientId: XERO_CLIENT_ID,
    clientSecret,
    redirectUris: [`${BASE_URL}/api/callback`],
    scopes: [
      'openid',
      'profile',
      'email',
      'accounting.transactions',
      'accounting.settings',
      'accounting.contacts',
      'offline_access',
    ],
  });
  await client.initialize();
  return client;
}

/**
 * Refresh the customer's Xero token and persist the rotated values to
 * DB + KV. On invalid_grant: cleanup the orphan row and return
 * 'expired'. On transient error: leave the row in place and return
 * 'transient'.
 */
export async function refreshAndPersist(customerId: string): Promise<RefreshResult> {
  const connection = await getXeroConnection(customerId);
  if (!connection || !connection.refresh_token || !connection.tenant_id) {
    return { status: 'not_connected' };
  }

  let newTokenSet;
  try {
    const xeroClient = await getXeroClientForRefresh();
    xeroClient.setTokenSet({
      refresh_token: connection.refresh_token,
      access_token: connection.access_token,
      expires_at: connection.expires_at,
    });
    newTokenSet = await xeroClient.refreshToken();
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await cleanupDeadConnection(customerId);
      return { status: 'expired', reason: 'invalid_grant' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'transient', reason: msg };
  }

  if (!newTokenSet.access_token || !newTokenSet.refresh_token) {
    // Xero returned a degenerate response — treat as transient, don't
    // wipe the row in case the next call succeeds.
    return { status: 'transient', reason: 'empty_token_set' };
  }

  try {
    await updateXeroTokens(
      customerId,
      newTokenSet.access_token,
      newTokenSet.refresh_token,
      newTokenSet.expires_at || Math.floor(Date.now() / 1000) + 1800,
    );
  } catch (err) {
    // DB write failed AFTER Xero rotated the token. This is exactly
    // the poisoned-state we are trying to prevent elsewhere. Best we
    // can do here is surface the failure loudly — the next refresh
    // attempt will hit invalid_grant and clean up via this same path.
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'transient', reason: `db_write_failed_after_rotation: ${msg}` };
  }

  // Keep KV in sync for the interest app. Failures here are not fatal
  // — DB is the truth source for the connector.
  try {
    await setSecret(SECRETS.XERO_REFRESH_TOKEN, newTokenSet.refresh_token);
  } catch {
    // Logged at call site if needed.
  }

  return {
    status: 'connected',
    tenantId: connection.tenant_id,
    tenantName: connection.tenant_name || 'Unknown Organization',
    accessToken: newTokenSet.access_token,
    refreshToken: newTokenSet.refresh_token,
    expiresAt: newTokenSet.expires_at || Math.floor(Date.now() / 1000) + 1800,
  };
}

/**
 * Probe a Xero connection's true state. Prefers a non-mutating probe
 * (call /connections with the existing access_token) when the access
 * token is still fresh; falls back to refreshAndPersist when expired
 * or when /connections returns 401.
 *
 * This is the function the portal connection indicator should call —
 * it never reports "connected" without verifying against Xero.
 */
export async function probeConnection(customerId: string): Promise<RefreshResult> {
  const connection = await getXeroConnection(customerId);
  if (!connection || !connection.refresh_token || !connection.tenant_id) {
    return { status: 'not_connected' };
  }

  const now = Math.floor(Date.now() / 1000);
  const hasFreshAccessToken =
    !!connection.access_token &&
    !!connection.expires_at &&
    connection.expires_at > now + 60;

  if (hasFreshAccessToken) {
    const probeOk = await probeWithAccessToken(connection);
    if (probeOk === 'ok') {
      return {
        status: 'connected',
        tenantId: connection.tenant_id,
        tenantName: connection.tenant_name || 'Unknown Organization',
        accessToken: connection.access_token!,
        refreshToken: connection.refresh_token,
        expiresAt: connection.expires_at!,
      };
    }
    if (probeOk === 'transient') {
      return { status: 'transient', reason: 'connections_probe_5xx' };
    }
    // 401: access token revoked. Fall through to refresh attempt.
  }

  return refreshAndPersist(customerId);
}

/**
 * GET /connections directly against Xero with the existing access
 * token. Does NOT rotate the refresh token. Returns:
 *   'ok'         — 2xx, token still valid
 *   'unauthorized' — 401, token revoked (caller should try refresh)
 *   'transient'  — network error or 5xx
 */
async function probeWithAccessToken(connection: XeroConnection): Promise<'ok' | 'unauthorized' | 'transient'> {
  try {
    const res = await fetch('https://api.xero.com/connections', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401 || res.status === 403) return 'unauthorized';
    if (res.status >= 500) return 'transient';
    if (!res.ok) return 'unauthorized';
    return 'ok';
  } catch {
    return 'transient';
  }
}
