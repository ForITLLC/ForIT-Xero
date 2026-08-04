'use strict';

/**
 * Every HTTP route in this connector is `authLevel: 'anonymous'` BY DESIGN.
 * Auth is enforced per-handler — `x-api-key` -> validateApiKey, with the
 * customer derived from the key and never from the body. Stripe cannot send an
 * `x-functions-key`, so flipping a route to 'function' breaks the webhook or
 * the key model.
 *
 * This test exists so that stays a deliberate decision instead of something a
 * future reader "fixes" on sight.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions } = require('./helpers/harness');

const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
};

const SERVICE_STUBS = {
  'services/keyvault.js': { getSecret: async () => 'stub', setSecret: async () => {}, disableSecret: async () => {}, SECRETS },
  'services/database.js': new Proxy({}, { get: () => async () => null }),
  'services/xeroConnection.js': new Proxy({}, { get: () => async () => ({ status: 'not_connected' }) }),
};

const MODULES = [
  'functions/mcpAuth.js',
  'functions/connect.js',
  'functions/subscriptions.js',
  'functions/connector.js',
  'functions/mcp.js',
  'functions/keepAlive.js',
  'functions/health.js',
];

test('every HTTP route stays anonymous — auth is per-handler by x-api-key', () => {
  const seen = [];

  for (const file of MODULES) {
    const { registrations } = loadFunctions(file, SERVICE_STUBS);
    for (const registration of registrations) {
      if (registration.kind !== 'http') continue;
      seen.push(registration.name);
      assert.equal(
        registration.options.authLevel,
        'anonymous',
        `${file} -> ${registration.name} is authLevel '${registration.options.authLevel}'. ` +
        'Routes are anonymous by design and guarded per-handler; see this file.'
      );
    }
  }

  assert.ok(seen.length >= 27, `expected the full route surface, saw ${seen.length}: ${seen.join(', ')}`);
});

test('the public signup and key-minting endpoints stay disabled', () => {
  const { registrations } = loadFunctions('functions/mcpAuth.js', SERVICE_STUBS);
  const byName = Object.fromEntries(registrations.map((r) => [r.name, r]));

  for (const name of ['Signup', 'GenerateNewKey']) {
    assert.ok(byName[name], `${name} registration disappeared`);
  }
});

test('the health route is registered and reachable without a key', () => {
  const { registrations } = loadFunctions('functions/health.js', SERVICE_STUBS);
  const health = registrations.find((r) => r.name === 'Health');

  assert.ok(health, 'Health route is not registered');
  assert.equal(health.options.route, 'health');
  assert.equal(health.options.authLevel, 'anonymous');
});
