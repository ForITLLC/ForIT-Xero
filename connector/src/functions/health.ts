import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSecret, SECRETS } from '../services/keyvault';
import { reportFailure } from '../services/errors';

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

type Check = { ready: boolean; reason?: string };

interface HealthPayload {
  status: 'ok' | 'degraded';
  commit: string;
  built_at: string | null;
  checked_at: string;
  subscription_webhook_ready: boolean;
  checks: Record<string, Check>;
}

let cached: { at: number; payload: HealthPayload } | null = null;
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

async function buildPayload(context: InvocationContext): Promise<HealthPayload> {
  const [stripeApi, stripeWebhook] = await Promise.all([
    checkCredential(context, 'stripe_api_credential', SECRETS.STRIPE_SECRET_KEY),
    checkCredential(context, 'stripe_webhook_signing_credential', SECRETS.STRIPE_WEBHOOK_SECRET),
  ]);

  const checks = {
    stripe_api_credential: stripeApi,
    stripe_webhook_signing_credential: stripeWebhook,
  };

  // The webhook needs both: one to talk to Stripe, one to verify the signature.
  const subscriptionWebhookReady = stripeApi.ready && stripeWebhook.ready;
  const { commit, built_at } = getBuildInfo();

  return {
    status: subscriptionWebhookReady ? 'ok' : 'degraded',
    commit,
    built_at,
    checked_at: new Date().toISOString(),
    subscription_webhook_ready: subscriptionWebhookReady,
    checks,
  };
}

async function health(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_TTL_MS) {
    cached = { at: now, payload: await buildPayload(context) };
  }

  const payload = cached.payload;

  return {
    // Red while it is red: a degraded connector must not answer 200.
    status: payload.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
    jsonBody: payload,
  };
}

app.http('Health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: health,
});
