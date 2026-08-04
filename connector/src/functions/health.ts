import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSecret, SECRETS } from '../services/keyvault';
import { reportFailure } from '../services/errors';
import { getWebhookObservations } from '../services/webhookState';
import { getSubscriptionEvidence } from '../services/database';

/**
 * GET /api/health
 *
 * The connector had 27 routes and no way for anyone to ask whether any of it
 * worked — the subscription webhook had been failing every call in production
 * and nothing said so. This states readiness as a fact and stays red while it
 * is red.
 *
 * It is a surface, not a poller: nothing here runs on a timer, and the result
 * is cached briefly so an anonymous caller cannot drive Key Vault traffic.
 *
 * It names components, never Key Vault secret names — reporting that a secret
 * called X is missing is the same disclosure the leak this route ships
 * alongside was fixed to stop.
 */

const CACHE_TTL_MS = 30_000;

type Check = { ready: boolean; reason?: string; [key: string]: unknown };

type ReadinessBasis = 'verified_event_persisted' | 'unproven' | 'credentials_missing';

interface HealthPayload {
  status: 'ok' | 'unproven' | 'degraded';
  commit: string;
  /** Alias of `commit`. The ForIT fleet monitor classifies a probe on a `sha` field. */
  sha: string;
  built_at: string | null;
  checked_at: string;
  subscription_webhook_ready: boolean;
  readiness_basis: ReadinessBasis;
  readiness_note: string;
  checks: Record<string, Check>;
}

// Only the Key Vault reads are cached. Observed Stripe traffic is read fresh on
// every request — it costs nothing and must not be stale.
let cachedCredentials: { at: number; checks: Record<string, Check> } | null = null;
let buildInfo: { commit: string; built_at: string | null } | null = null;

/**
 * The commit this instance is actually running, so "deployed == main" can be
 * checked against the app rather than against somebody's working copy.
 * Stamped into build-info.json by the deploy workflow.
 */
function getBuildInfo(): { commit: string; built_at: string | null } {
  if (buildInfo) return buildInfo;

  if (process.env.BUILD_COMMIT) {
    buildInfo = { commit: process.env.BUILD_COMMIT, built_at: process.env.BUILD_TIME || null };
    return buildInfo;
  }

  try {
    // dist/src/functions/health.js -> the package root
    const raw = readFileSync(join(__dirname, '..', '..', '..', 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as { commit?: string; built_at?: string };
    buildInfo = { commit: parsed.commit || 'unknown', built_at: parsed.built_at || null };
  } catch {
    buildInfo = { commit: 'unknown', built_at: null };
  }

  return buildInfo;
}

async function checkCredential(context: InvocationContext, label: string, secretName: string): Promise<Check> {
  try {
    const value = await getSecret(secretName);
    if (!value) return { ready: false, reason: 'empty' };
    return { ready: true };
  } catch (error) {
    reportFailure(context, `Health check failed: ${label}`, error);

    const code = (error as { code?: string }).code;
    const statusCode = (error as { statusCode?: number }).statusCode;

    if (code === 'SecretNotFound' || statusCode === 404) return { ready: false, reason: 'not_provisioned' };
    if (code === 'Forbidden' || statusCode === 403) return { ready: false, reason: 'access_denied' };
    return { ready: false, reason: 'unavailable' };
  }
}

async function credentialChecks(context: InvocationContext): Promise<Record<string, Check>> {
  const now = Date.now();
  if (cachedCredentials && now - cachedCredentials.at <= CACHE_TTL_MS) {
    return cachedCredentials.checks;
  }

  const [stripeApi, stripeWebhook, provisioning] = await Promise.all([
    checkCredential(context, 'stripe_api_credential', SECRETS.STRIPE_SECRET_KEY),
    checkCredential(context, 'stripe_webhook_signing_credential', SECRETS.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET),
    provisioningCheck(context),
  ]);

  const checks = {
    stripe_api_credential: stripeApi,
    stripe_webhook_signing_credential: stripeWebhook,
    subscription_provisioning_observed: provisioning,
  };

  cachedCredentials = { at: now, checks };
  return checks;
}

const READINESS_NOTES: Record<ReadinessBasis, string> = {
  credentials_missing:
    'A Stripe credential could not be read from Key Vault. The webhook cannot run.',
  unproven:
    'Both credentials resolve and the handler is covered by signature tests, but no Stripe event has ' +
    'yet verified AND provisioned a subscription. Stripe does not disclose a signing secret on list or ' +
    'retrieve, so the secret is matched to the endpoint by elimination, not proven. Only a real event ' +
    'that provisions settles it.',
  verified_event_persisted:
    'A real Stripe event verified against the configured signing secret and provisioned a subscription. ' +
    'This evidence is read from the database, so it holds across a recycle and from any instance.',
};

/**
 * Durable evidence, read through the same 30s window as the credential checks.
 * A database that cannot be reached is reported as unknown — never as readiness
 * and never as a fault, because the connector itself is not broken.
 */
async function provisioningCheck(context: InvocationContext): Promise<Check> {
  try {
    const evidence = await getSubscriptionEvidence();
    return {
      ready: evidence.provisioned > 0,
      ...(evidence.provisioned === 0 ? { reason: 'no_subscription_ever_provisioned' } : {}),
      scope: 'durable_cross_instance',
      provisioned_count: evidence.provisioned,
      last_write_at: evidence.lastWriteAt,
    };
  } catch (error) {
    reportFailure(context, 'Health check failed: subscription_provisioning_observed', error);
    return { ready: false, reason: 'unavailable', scope: 'durable_cross_instance' };
  }
}

async function buildPayload(context: InvocationContext): Promise<HealthPayload> {
  const checks = await credentialChecks(context);
  const credentialsReady =
    checks.stripe_api_credential.ready && checks.stripe_webhook_signing_credential.ready;

  const provisioning = checks.subscription_provisioning_observed;

  // Read fresh, never cached: in-process counters cost nothing to read and
  // must not be stale.
  const observed = getWebhookObservations();

  const basis: ReadinessBasis = !credentialsReady
    ? 'credentials_missing'
    : provisioning.ready
      ? 'verified_event_persisted'
      : 'unproven';

  const { commit, built_at } = getBuildInfo();

  return {
    // 'ok' is a claim about Stripe, and only durable evidence supports it.
    // 'unproven' is not an alarm — nothing is known to be broken — but it is
    // not health either, and subscription_webhook_ready stays false for it.
    status: basis === 'verified_event_persisted' ? 'ok' : basis === 'unproven' ? 'unproven' : 'degraded',
    commit,
    sha: commit,
    built_at,
    checked_at: new Date().toISOString(),
    subscription_webhook_ready: basis === 'verified_event_persisted',
    readiness_basis: basis,
    readiness_note: READINESS_NOTES[basis],
    checks: {
      ...checks,
      stripe_signature_verified: {
        ready: observed.verifiedCount > 0,
        ...(observed.verifiedCount === 0 ? { reason: 'no_verified_event_observed_by_this_instance' } : {}),
        // This process only. Observed 2026-08-04: a restart took these to zero
        // on an unchanged commit, so they can never carry a readiness claim.
        scope: 'this_instance_only',
        verified_count: observed.verifiedCount,
        last_verified_at: observed.lastVerifiedAt,
        // Reported, never alarmed on: this route is public and anonymous, so
        // anyone can drive this number up with junk. It is a hint for a human
        // reading the page, not a signal a monitor should trip on.
        rejected_count: observed.rejectedCount,
        last_rejected_at: observed.lastRejectedAt,
      },
    },
  };
}

async function health(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const payload = await buildPayload(context);

  return {
    // Red only when something is actually broken. An unproven secret is stated
    // in the body rather than shouted in the status line — a connector that
    // has simply not seen an event yet is not a failing connector.
    status: payload.status === 'degraded' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody: payload,
  };
}

/**
 * GET /api/version
 *
 * The ForIT fleet monitor (for-Inventory, inventory.AppEndpoints) probes
 * `version_path` — '/api/version' — and classifies the result on a `sha` field:
 * 404 is 'not_found', and a 200 without a sha is 'degraded'. This connector is
 * registered there and monitored, but had no such route, so it was dark. This
 * is the cheapest possible surface that answers it honestly.
 */
async function version(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const { commit, built_at } = getBuildInfo();

  return {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody: { sha: commit, commit, built_at },
  };
}

app.http('Health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: health,
});

app.http('Version', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'version',
  handler: version,
});
