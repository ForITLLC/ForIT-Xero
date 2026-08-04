'use strict';

/**
 * WO#1148 D3 — drive EVERY anonymous route to its error path.
 *
 * WO#1137 found a leaked Key Vault secret name by accident, on one route. The
 * other 27 were never driven. A 500 body on an anonymous route is an
 * unauthenticated read of whatever the handler happened to be holding, so every
 * one of them gets rigged to fail here and the response is searched for
 * infrastructure detail.
 *
 * The invariant is NOT "no message ever reaches the caller" — connector.ts
 * deliberately passes Xero's own validation text through to Power Automate
 * flows that branch on it (pinned in errorEnvelopeScope.test.js and below).
 * The invariant is that no INTERNAL name escapes: Key Vault secrets and vault
 * hosts, the SQL server and login, passwords, stack traces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions, makeRequest, makeContext, clientVisible } = require('./helpers/harness');

// One error carrying every kind of internal detail these handlers can be
// holding when something fails.
const INFRA_ERROR =
  "Login failed for user 'foritadmin'. Server=forit-saas-sql.database.windows.net; " +
  'Password=P@ssw0rd-LEAKED; A secret with (name/id) XERO-CLIENT-SECRET was not found in ' +
  'https://forit-xero-mcp-kv.vault.azure.net';

const INFRA_SENTINELS = [
  'foritadmin',
  'forit-saas-sql.database.windows.net',
  'P@ssw0rd-LEAKED',
  'XERO-CLIENT-SECRET',
  'vault.azure.net',
  'Password=',
];

// A stack trace is itself a disclosure: file paths, framework versions, layout.
const STACK_SENTINELS = ['node_modules', '.ts:', '.js:', '    at '];

const throwsInfra = () => { throw new Error(INFRA_ERROR); };

/** Every service function this app has, rigged to fail. */
const FAILING_SERVICES = {
  'services/keyvault.js': new Proxy(
    { SECRETS: new Proxy({}, { get: (_t, key) => String(key) }) },
    { get: (target, key) => (key === 'SECRETS' ? target.SECRETS : throwsInfra) }
  ),
  'services/database.js': new Proxy({}, { get: () => throwsInfra }),
  'services/xeroConnection.js': new Proxy({}, { get: () => throwsInfra }),
};

const MODULES = [
  'functions/mcpAuth.js',
  'functions/connect.js',
  'functions/subscriptions.js',
  'functions/connector.js',
  'functions/mcp.js',
  'functions/health.js',
];

/**
 * A request generous enough that no handler bails on a missing input before it
 * reaches the dependency that fails.
 */
function genericRequest(route) {
  return makeRequest({
    headers: {
      'x-api-key': 'fk_live_probe',
      'stripe-signature': 't=1,v1=deadbeef',
      'content-type': 'application/json',
    },
    query: {
      email: 'probe@forit.io',
      code: 'auth-code',
      state: Buffer.from(JSON.stringify({
        customer_id: '11111111-2222-3333-4444-555555555555',
        return_url: 'https://www.forit.io/portal/xero-connector',
        timestamp: Date.now(),
      })).toString('base64url'),
      invoiceId: 'INV-001',
      contactId: 'contact-1',
      paymentId: 'pay-1',
    },
    json: {
      product_slug: 'xero-connector',
      success_url: 'https://forit.io/ok',
      cancel_url: 'https://forit.io/no',
      email: 'probe@forit.io',
      return_url: 'https://www.forit.io/portal/xero-connector',
      invoiceIds: ['INV-001'],
      status: 'AUTHORISED',
    },
    body: '{}',
    url: `https://xero.forit.io/api/${route}`,
  });
}

async function driveEveryAnonymousRoute() {
  const results = [];

  for (const file of MODULES) {
    const { registrations } = loadFunctions(file, FAILING_SERVICES);

    for (const registration of registrations) {
      if (registration.kind !== 'http') continue;

      const context = makeContext();
      let response;
      let threw = null;
      try {
        response = await registration.options.handler(genericRequest(registration.options.route), context);
      } catch (err) {
        // A handler that throws instead of returning is its own defect: the
        // Functions host turns it into a 500 whose body we do not control.
        threw = err;
      }

      results.push({
        file,
        name: registration.name,
        route: registration.options.route,
        status: response?.status ?? null,
        visible: response ? clientVisible(response) : '',
        threw,
      });
    }
  }

  return results;
}

test('every anonymous route is driven, and the inventory is exactly 28', async () => {
  const results = await driveEveryAnonymousRoute();
  assert.equal(results.length, 28, `anonymous route count changed: ${results.map((r) => r.name).join(', ')}`);
});

test('no anonymous route hands internal infrastructure detail to the caller', async () => {
  const results = await driveEveryAnonymousRoute();
  const leaks = [];

  for (const result of results) {
    for (const sentinel of INFRA_SENTINELS) {
      if (result.visible.includes(sentinel)) {
        leaks.push(`${result.name} (${result.route}) leaked "${sentinel}" -> ${result.visible.slice(0, 240)}`);
      }
    }
  }

  assert.deepEqual(leaks, [], `\n${leaks.join('\n')}\n`);
});

test('no anonymous route hands a stack trace to the caller', async () => {
  const results = await driveEveryAnonymousRoute();
  const leaks = [];

  for (const result of results) {
    for (const sentinel of STACK_SENTINELS) {
      if (result.visible.includes(sentinel)) {
        leaks.push(`${result.name} leaked stack detail "${sentinel}"`);
      }
    }
  }

  assert.deepEqual(leaks, []);
});

test('no anonymous route throws instead of returning a response', async () => {
  const results = await driveEveryAnonymousRoute();
  const throwers = results.filter((r) => r.threw).map((r) => `${r.name}: ${r.threw.message}`);
  assert.deepEqual(throwers, [], `\n${throwers.join('\n')}\n`);
});

test('the rigging actually reached the failure paths, not just early returns', async () => {
  const results = await driveEveryAnonymousRoute();
  const failed = results.filter((r) => r.status >= 500).map((r) => r.name);

  // If this drops, the probe stopped exercising the code it claims to cover.
  assert.ok(
    failed.length >= 18,
    `only ${failed.length} routes reached a 5xx — the probe is no longer driving error paths: ${failed.join(', ')}`
  );
});

test("Xero's own validation text still reaches Power Automate flows", async () => {
  // The passthrough branch (`!response.ok` -> responseText) is a different
  // return path from the catch, and it is the one live flows branch on.
  // Fixing the catch blocks must not silence this.
  const xeroBody = JSON.stringify({
    Type: 'ValidationException',
    Message: 'A validation exception occurred',
    Elements: [{ ValidationErrors: [{ Message: 'Account code must be specified' }] }],
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => xeroBody,
    json: async () => JSON.parse(xeroBody),
  });

  try {
    const { registrations } = loadFunctions('functions/connector.js', {
      'services/keyvault.js': { getSecret: async () => 'x', setSecret: async () => {}, SECRETS: {} },
      'services/database.js': new Proxy({}, {
        get: (_t, key) => {
          if (key === 'validateApiKey') return async () => ({ id: 'cust-1', email: 'probe@forit.io' });
          if (key === 'checkProductAccess') return async () => true;
          if (key === 'getXeroConnection') {
            return async () => ({
              tenant_id: 'tenant-1',
              access_token: 'at',
              refresh_token: 'rt',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            });
          }
          return async () => null;
        },
      }),
      'services/xeroConnection.js': new Proxy({}, { get: () => async () => ({ status: 'connected' }) }),
    });

    const getInvoices = registrations.find((r) => r.name === 'ConnectorGetInvoices');
    const response = await getInvoices.options.handler(genericRequest('connector/invoices'), makeContext());

    assert.equal(response.status, 400, 'the Xero status is no longer passed through');
    assert.match(
      clientVisible(response),
      /Account code must be specified/,
      "Xero's validation text no longer reaches the caller — live Power Automate flows branch on it"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
