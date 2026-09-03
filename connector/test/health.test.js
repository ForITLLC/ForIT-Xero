'use strict';

/**
 * WO#1137 D3 — the health surface must state readiness as a fact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions, makeRequest, makeContext, clientVisible } = require('./helpers/harness');

const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
};

function keyvaultStub(behaviour) {
  return {
    SECRETS,
    setSecret: async () => {},
    getSecret: async (name) => behaviour(name),
  };
}

function notFound() {
  const error = new Error('A secret with (name/id) STRIPE-WEBHOOK-SECRET was not found in this key vault.');
  error.code = 'SecretNotFound';
  error.statusCode = 404;
  throw error;
}

function forbidden() {
  const error = new Error('Caller is not authorized to perform action on resource.');
  error.code = 'Forbidden';
  error.statusCode = 403;
  throw error;
}

const NOTHING_OBSERVED = { verifiedCount: 0, rejectedCount: 0, lastVerifiedAt: null, lastRejectedAt: null };
const NO_DURABLE_EVIDENCE = { provisioned: 0, lastWriteAt: null };

async function callHealth(behaviour, env = {}, observations = NOTHING_OBSERVED, evidence = NO_DURABLE_EVIDENCE, scopeGate = { armed: false }) {
  const restore = [];
  for (const [key, value] of Object.entries(env)) {
    restore.push([key, process.env[key]]);
    process.env[key] = value;
  }
  try {
    const { handlers } = loadFunctions('functions/health.js', {
      'services/keyvault.js': keyvaultStub(behaviour),
      'services/webhookState.js': {
        getWebhookObservations: () => observations,
        recordVerifiedEvent: () => {},
        recordRejectedSignature: () => {},
      },
      'services/database.js': {
        getSubscriptionEvidence: async () => {
          if (evidence instanceof Error) throw evidence;
          return evidence;
        },
        getApiKeyScopeGateState: async () => {
          if (scopeGate instanceof Error) throw scopeGate;
          return scopeGate;
        },
      },
    });
    const context = makeContext();
    const response = await handlers.Health(makeRequest(), context);
    return { response, context };
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('reports the running commit so deployed==main is checkable off the app', async () => {
  const { response } = await callHealth(async () => 'value', { BUILD_COMMIT: 'deadbeefcafe1234' });
  assert.equal(response.jsonBody.commit, 'deadbeefcafe1234');
});

test('finds build-info.json where the deploy workflow stamps it', async () => {
  // The path that matters in production: no BUILD_COMMIT env, just the file
  // the workflow writes into the package root. If this resolves wrong, the
  // route reports "unknown" and deployed==main becomes unprovable.
  const fs = require('node:fs');
  const path = require('node:path');
  const { CONNECTOR_ROOT } = require('./helpers/harness');

  const stampPath = path.join(CONNECTOR_ROOT, 'build-info.json');
  const preexisting = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;
  fs.writeFileSync(stampPath, JSON.stringify({ commit: 'stamped0000111122223333', built_at: '2026-08-04T00:00:00Z' }));

  const saved = process.env.BUILD_COMMIT;
  delete process.env.BUILD_COMMIT;

  try {
    const { response } = await callHealth(async () => 'value');
    assert.equal(response.jsonBody.commit, 'stamped0000111122223333');
    assert.equal(response.jsonBody.built_at, '2026-08-04T00:00:00Z');
  } finally {
    if (saved !== undefined) process.env.BUILD_COMMIT = saved;
    if (preexisting === null) fs.unlinkSync(stampPath);
    else fs.writeFileSync(stampPath, preexisting);
  }
});

test('degrades to "unknown" rather than throwing when nothing stamped the build', async () => {
  const saved = process.env.BUILD_COMMIT;
  delete process.env.BUILD_COMMIT;
  try {
    const { response } = await callHealth(async () => 'value');
    assert.equal(typeof response.jsonBody.commit, 'string');
    assert.ok(response.jsonBody.commit.length > 0);
  } finally {
    if (saved !== undefined) process.env.BUILD_COMMIT = saved;
  }
});

test('resolvable credentials alone are NOT readiness — that is a claim about Stripe', async () => {
  // The handler is correct and both secrets read. That still does not prove the
  // signing secret is the one Stripe signs with.
  const { response } = await callHealth(async () => 'value', { BUILD_COMMIT: 'abc123' });

  assert.equal(response.jsonBody.status, 'unproven');
  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  assert.equal(response.jsonBody.readiness_basis, 'unproven');
  assert.equal(response.jsonBody.checks.stripe_signature_verified.ready, false);
  assert.equal(
    response.jsonBody.checks.stripe_signature_verified.reason,
    'no_verified_event_observed_by_this_instance'
  );
  // Not an alarm: nothing is known to be broken.
  assert.equal(response.status, 200);
  assert.match(response.jsonBody.readiness_note, /only a real event that provisions settles it/i);
});

const VERIFIED_IN_PROCESS = {
  verifiedCount: 5,
  rejectedCount: 0,
  lastVerifiedAt: '2026-08-04T12:00:00.000Z',
  lastRejectedAt: null,
};

test('an in-process verified count is NOT readiness — it does not survive a recycle', async () => {
  // Observed 2026-08-04: an app restart took rejected_count 2 -> 0 on the same
  // commit. This app is Consumption (Y1, alwaysOn=false, scale limit 200), so
  // it goes cold between events and can serve health from an instance that
  // never saw one. Readiness keyed on process memory can never be true when it
  // matters.
  const { response } = await callHealth(async () => 'value', {}, VERIFIED_IN_PROCESS, NO_DURABLE_EVIDENCE);

  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  assert.equal(response.jsonBody.readiness_basis, 'unproven');
  // Still reported — it is real evidence, just scoped to one process.
  assert.equal(response.jsonBody.checks.stripe_signature_verified.verified_count, 5);
  assert.equal(response.jsonBody.checks.stripe_signature_verified.scope, 'this_instance_only');
});

test('durable evidence makes it ready on an instance that has verified nothing', async () => {
  const { response } = await callHealth(async () => 'value', {}, NOTHING_OBSERVED, {
    provisioned: 3,
    lastWriteAt: '2026-08-04T12:00:00.000Z',
  });

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.status, 'ok');
  assert.equal(response.jsonBody.subscription_webhook_ready, true);
  assert.equal(response.jsonBody.readiness_basis, 'verified_event_persisted');
  assert.equal(response.jsonBody.checks.subscription_provisioning_observed.ready, true);
  assert.equal(response.jsonBody.checks.subscription_provisioning_observed.scope, 'durable_cross_instance');
  assert.equal(response.jsonBody.checks.subscription_provisioning_observed.last_write_at, '2026-08-04T12:00:00.000Z');
});

test('readiness means subscriptions were provisioned, not merely that signatures verify', async () => {
  // The distinction D3 exists for: the door opening is not the floor holding.
  const { response } = await callHealth(async () => 'value', {}, VERIFIED_IN_PROCESS, {
    provisioned: 0,
    lastWriteAt: null,
  });

  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  assert.match(response.jsonBody.readiness_note, /provision/i);
});

test('an unreachable database does not fabricate readiness or a fault', async () => {
  const { response } = await callHealth(
    async () => 'value',
    {},
    NOTHING_OBSERVED,
    Object.assign(new Error('Login failed for user'), { code: 'ELOGIN' })
  );

  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  assert.equal(response.jsonBody.checks.subscription_provisioning_observed.ready, false);
  assert.equal(response.jsonBody.checks.subscription_provisioning_observed.reason, 'unavailable');
  // Credentials are fine, so this is not a hard fault.
  assert.equal(response.status, 200);
  // And it must not leak the database error to an anonymous caller.
  assert.ok(!clientVisible(response).includes('Login failed'));
});

test('rejected signatures are reported but never on their own claim readiness', async () => {
  const { response } = await callHealth(async () => 'value', {}, {
    verifiedCount: 0,
    rejectedCount: 42,
    lastVerifiedAt: null,
    lastRejectedAt: '2026-08-04T12:00:00.000Z',
  });

  assert.equal(response.jsonBody.checks.stripe_signature_verified.rejected_count, 42);
  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  // The route is public: anyone can drive rejections up with junk, so they must
  // not flip the connector to 'degraded' on their own.
  assert.equal(response.jsonBody.status, 'unproven');
  assert.equal(response.status, 200);
});

test('a missing credential still goes hard red', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET ? notFound() : 'value'),
    {},
    { verifiedCount: 5, rejectedCount: 0, lastVerifiedAt: '2026-08-04T12:00:00.000Z', lastRejectedAt: null }
  );

  // Even with verified events on record, an unreadable credential wins.
  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.status, 'degraded');
  assert.equal(response.jsonBody.readiness_basis, 'credentials_missing');
  assert.equal(response.jsonBody.subscription_webhook_ready, false);
});

test('stays red — and answers 503, not 200 — while the signing credential is missing', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET ? notFound() : 'value'),
    { BUILD_COMMIT: 'abc123' }
  );

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.status, 'degraded');
  assert.equal(response.jsonBody.subscription_webhook_ready, false);
  assert.equal(response.jsonBody.checks.stripe_webhook_signing_credential.ready, false);
  assert.equal(response.jsonBody.checks.stripe_webhook_signing_credential.reason, 'not_provisioned');
  // The credential that does resolve must still report honestly.
  assert.equal(response.jsonBody.checks.stripe_api_credential.ready, true);
});

test('distinguishes "cannot read it" from "it is not there"', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET ? forbidden() : 'value')
  );
  assert.equal(response.jsonBody.checks.stripe_webhook_signing_credential.reason, 'access_denied');
});

test('does not hand out vault or secret names', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET ? notFound() : 'value')
  );

  const visible = clientVisible(response);
  for (const sentinel of ['STRIPE-WEBHOOK-SECRET', 'STRIPE-SECRET-KEY', 'key vault', 'vault.azure.net']) {
    assert.ok(!visible.includes(sentinel), `health surface disclosed "${sentinel}": ${visible}`);
  }
});

test('never returns a secret value', async () => {
  const { response } = await callHealth(async () => 'sk_live_super_secret_value');
  assert.ok(!clientVisible(response).includes('sk_live_super_secret_value'));
});

/**
 * WO#1821B-2 — the scope gate is dormant-but-present in the code from the
 * moment it deploys, and only the column decides whether it does anything.
 * Those two states look identical from outside, so the app has to say which
 * one it is in. This is also the migration's acceptance evidence: it is read
 * from the app, not from a SQL client.
 */
test('reports the read-only key gate as inert while the scope column is absent', async () => {
  const { response } = await callHealth(async () => 'value', {}, NOTHING_OBSERVED, NO_DURABLE_EVIDENCE, { armed: false });

  const gate = response.jsonBody.checks.api_key_scope_gate;
  assert.equal(gate.ready, false);
  assert.equal(gate.reason, 'scope_column_absent');
  assert.equal(gate.scope, 'durable_cross_instance');
  assert.match(gate.note, /inert/);
});

test('reports the read-only key gate as armed once the scope column exists', async () => {
  const { response } = await callHealth(async () => 'value', {}, NOTHING_OBSERVED, NO_DURABLE_EVIDENCE, { armed: true });

  const gate = response.jsonBody.checks.api_key_scope_gate;
  assert.equal(gate.ready, true);
  assert.equal(gate.reason, undefined);
});

/**
 * An unapplied migration is not a fault. If this ever flips the route to 503 it
 * will page somebody for a schema change that broke nothing.
 */
test('an inert scope gate does not turn health red', async () => {
  const { response } = await callHealth(async () => 'value', {}, NOTHING_OBSERVED, NO_DURABLE_EVIDENCE, { armed: false });

  assert.equal(response.status, 200);
  assert.notEqual(response.jsonBody.status, 'degraded');
  assert.equal(response.jsonBody.readiness_basis, 'unproven');
});

test('a database that cannot answer is unknown, not a fault', async () => {
  const { response } = await callHealth(
    async () => 'value', {}, NOTHING_OBSERVED, NO_DURABLE_EVIDENCE, new Error('pool offline')
  );

  const gate = response.jsonBody.checks.api_key_scope_gate;
  assert.equal(gate.ready, false);
  assert.equal(gate.reason, 'unavailable');
  assert.equal(response.status, 200);
});
