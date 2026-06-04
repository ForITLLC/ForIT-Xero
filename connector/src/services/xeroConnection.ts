import { XeroClient } from 'xero-node';
import type { Transaction } from 'mssql';
import { getSecret, setSecret, disableSecret, SECRETS } from './keyvault';
import {
  getXeroConnection,
  updateXeroTokens,
  deleteXeroConnectionsByCustomer,
  withRefreshLock,
  XeroConnection,
} from './database';

/**
 * Centralized Xero token-refresh + connection-state service.
 *
 * Xero refresh tokens are single-use: each refresh rotates the token
 * and invalidates the previous one. If two refreshers run concurrently
 * (in-process async overlap OR two Function instances on Consumption),
 * both read the same refresh token, the first wins, and the second gets
 * `invalid_grant: Refresh token not found`. The old behavior treated
 * that loser as a dead connection and DELETED the row + disabled the KV
 * secret — nuking a live grant and forcing a human re-consent.
 *
 * Fix: refreshAndPersist now serializes per-customer via a SQL
 * app-lock (withRefreshLock) and double-checks the stored token after
 * acquiring the lock — so the loser of a race simply returns the
 * freshly-rotated token instead of refreshing again. invalid_grant no
 * longer auto-deletes; it logs a greppable marker and reports
 * 'expired', leaving re-consent as a deliberate human action.
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
 * DB + KV. Serializes per-customer via a SQL app-lock so two callers
 * never burn the same single-use refresh token. On invalid_grant: log
 * a marker and return 'expired' WITHOUT deleting the connection. On
 * transient error: leave the row in place and return 'transient'.
 */
export async function refreshAndPersist(customerId: string): Promise<RefreshResult> {
  const locked = await withRefreshLock(customerId, (tx) =>
    refreshAndPersistLocked(customerId, tx),
  );
  if (locked.acquired) return locked.value;

  // Couldn't take the lock within the timeout — another refresher is
  // mid-rotation. Re-read the connection; if it was just rotated to a
  // fresh access token, report that instead of a spurious transient.
  const connection = await getXeroConnection(customerId);
  if (!connection || !connection.refresh_token || !connection.tenant_id) {
    return { status: 'not_connected' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (connection.access_token && connection.expires_at && connection.expires_at > now + 60) {
    return {
      status: 'connected',
      tenantId: connection.tenant_id,
      tenantName: connection.tenant_name || 'Unknown Organization',
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token,
      expiresAt: connection.expires_at,
    };
  }
  return { status: 'transient', reason: 'refresh_lock_unavailable' };
}

/**
 * Lock-scoped refresh body. Runs inside the transaction that holds the
 * per-customer app-lock; all DB reads/writes use that same tx so they
 * see a consistent view and commit atomically when the lock releases.
 */
async function refreshAndPersistLocked(customerId: string, tx: Transaction): Promise<RefreshResult> {
  const connection = await getXeroConnection(customerId, tx);
  if (!connection || !connection.refresh_token || !connection.tenant_id) {
    return { status: 'not_connected' };
  }

  // Double-checked under the lock: another refresher may have rotated
  // the token while we waited. If the access token is still comfortably
  // fresh (>5 min), skip the refresh — rotating again would needlessly
  // burn a single-use token and could itself trigger a race downstream.
  const now = Math.floor(Date.now() / 1000);
  if (connection.access_token && connection.expires_at && connection.expires_at > now + 300) {
    return {
      status: 'connected',
      tenantId: connection.tenant_id,
      tenantName: connection.tenant_name || 'Unknown Organization',
      accessToken: connection.access_token,
      refreshToken: connection.refresh_token,
      expiresAt: connection.expires_at,
    };
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
      // DO NOT delete the row / disable the KV secret here. A lost
      // refresh race used to land the loser on this branch and nuke a
      // live grant, forcing re-consent. With serialization that race
      // is gone; a genuine invalid_grant now needs a deliberate human
      // re-consent, not an automatic teardown. Emit a greppable marker.
      console.error(
        `XERO_REFRESH_INVALID_GRANT customer=${customerId} — refresh rejected; NOT cleaning up. Manual re-consent required if this persists.`,
      );
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
      tx,
    );
  } catch (err) {
    // DB write failed AFTER Xero rotated the token. The tx will roll
    // back, leaving the row pointing at the now-invalid old token; the
    // next refresh will hit invalid_grant. Surface loudly.
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
