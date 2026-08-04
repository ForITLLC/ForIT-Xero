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
  STRIPE_WEBHOOK_SECRET: 'STRIPE-WEBHOOK-SECRET',
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

async function callHealth(behaviour, env = {}) {
  const restore = [];
  for (const [key, value] of Object.entries(env)) {
    restore.push([key, process.env[key]]);
    process.env[key] = value;
  }
  try {
    const { handlers } = loadFunctions('functions/health.js', {
      'services/keyvault.js': keyvaultStub(behaviour),
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

test('is green only when the webhook can actually run', async () => {
  const { response } = await callHealth(async () => 'value', { BUILD_COMMIT: 'abc123' });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.status, 'ok');
  assert.equal(response.jsonBody.subscription_webhook_ready, true);
});

test('stays red — and answers 503, not 200 — while the signing credential is missing', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_WEBHOOK_SECRET ? notFound() : 'value'),
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
    async (name) => (name === SECRETS.STRIPE_WEBHOOK_SECRET ? forbidden() : 'value')
  );
  assert.equal(response.jsonBody.checks.stripe_webhook_signing_credential.reason, 'access_denied');
});

test('does not hand out vault or secret names', async () => {
  const { response } = await callHealth(
    async (name) => (name === SECRETS.STRIPE_WEBHOOK_SECRET ? notFound() : 'value')
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
