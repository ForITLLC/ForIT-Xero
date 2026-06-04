import { app, InvocationContext, Timer } from '@azure/functions';
import { getConnectedCustomerIds } from '../services/database';
import { refreshAndPersist } from '../services/xeroConnection';

/**
 * Xero Token Keep-Alive
 *
 * Why this exists: the connector refreshes the Xero token only lazily,
 * when an inbound request happens to arrive past the access-token
 * expiry. During any stretch with no inbound traffic, nothing exercises
 * the refresh token — and Xero kills a refresh token after 60 days of
 * non-use. A long quiet period therefore lets the connection die on its
 * own, and the next caller gets invalid_grant. This timer proactively
 * refreshes every live connection daily, far inside the 60-day window,
 * and alerts the moment one comes back dead so a re-consent can happen
 * before the token silently lapses.
 *
 * Each refreshAndPersist call rotates the refresh token and persists the
 * new value to DB + the KV mirror, so a daily run also keeps the KV
 * mirror (read by the interest app) current.
 *
 * Concurrency: the refresh token is single-use and shared, so two
 * refreshers racing would rotate it out from under each other. That is
 * now handled inside refreshAndPersist via a per-customer SQL app-lock
 * plus a double-checked read — the interest app is already a pure KV
 * consumer and never rotates. A genuine invalid_grant no longer
 * auto-deletes the connection; it surfaces here as 'expired' and fires
 * the ALERT_MARKER so a human can re-consent. See ALERT_MARKER
 * occurrences in logs/alerts.
 */

const ALERT_MARKER = 'XERO_KEEPALIVE_ALERT';

interface KeepAliveTally {
  total: number;
  connected: number;
  expired: string[];   // customerIds whose refresh token is dead
  transient: string[]; // customerIds that failed transiently (retry next run)
  notConnected: string[];
}

/**
 * Best-effort alert when one or more connections came back dead. Logs a
 * marker line that an Application Insights alert rule can match, and —
 * if KEEPALIVE_ALERT_WEBHOOK is configured — POSTs a short summary to a
 * Teams/Slack-style incoming webhook. Never throws.
 */
async function alertDeadConnections(tally: KeepAliveTally, context: InvocationContext): Promise<void> {
  const summary =
    `${ALERT_MARKER}: ${tally.expired.length} Xero connection(s) dead (invalid_grant) ` +
    `out of ${tally.total}. Re-consent required at https://forit.io/portal. ` +
    `customerIds=${tally.expired.join(',')}`;

  context.error(summary, {
    marker: ALERT_MARKER,
    expired: tally.expired,
    transient: tally.transient,
    total: tally.total,
  });

  const webhook = process.env.KEEPALIVE_ALERT_WEBHOOK;
  if (!webhook) return;

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: summary }),
    });
  } catch (err) {
    context.warn('Keep-alive webhook post failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function xeroKeepAlive(timer: Timer, context: InvocationContext): Promise<void> {
  context.log('Xero keep-alive starting', {
    scheduledTime: timer.scheduleStatus?.last,
    isPastDue: timer.isPastDue,
  });

  const tally: KeepAliveTally = {
    total: 0,
    connected: 0,
    expired: [],
    transient: [],
    notConnected: [],
  };

  let customerIds: string[];
  try {
    customerIds = await getConnectedCustomerIds();
  } catch (err) {
    // Can't even read the connection list — surface loudly and bail.
    context.error('Xero keep-alive could not list connections', {
      marker: ALERT_MARKER,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  tally.total = customerIds.length;
  if (tally.total === 0) {
    context.log('Xero keep-alive: no connections to refresh');
    return;
  }

  for (const customerId of customerIds) {
    try {
      const result = await refreshAndPersist(customerId);
      switch (result.status) {
        case 'connected':
          tally.connected++;
          break;
        case 'expired':
          // invalid_grant — the grant is genuinely dead (refreshAndPersist
          // no longer auto-deletes; the row stays so this keeps alerting
          // until a human re-consents).
          tally.expired.push(customerId);
          break;
        case 'transient':
          tally.transient.push(customerId);
          context.warn('Xero keep-alive transient failure (will retry next run)', {
            customerId,
            reason: result.reason,
          });
          break;
        case 'not_connected':
          // Row vanished between the list query and the refresh — benign.
          tally.notConnected.push(customerId);
          break;
      }
    } catch (err) {
      // refreshAndPersist swallows known cases; an unexpected throw here
      // shouldn't abort the whole sweep. Treat as transient.
      tally.transient.push(customerId);
      context.error('Xero keep-alive unexpected error for customer', {
        customerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  context.log('Xero keep-alive complete', {
    total: tally.total,
    connected: tally.connected,
    expired: tally.expired.length,
    transient: tally.transient.length,
    notConnected: tally.notConnected.length,
  });

  if (tally.expired.length > 0) {
    await alertDeadConnections(tally, context);
  }
}

app.timer('XeroKeepAlive', {
  // Daily at 05:00 UTC — far inside Xero's 60-day refresh-token TTL.
  schedule: '0 0 5 * * *',
  handler: xeroKeepAlive,
  runOnStartup: false,
});
