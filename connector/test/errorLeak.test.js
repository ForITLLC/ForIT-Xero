'use strict';

/**
 * WO#1137 D1 — the raw-error leak guard.
 *
 * Every handler below used to hand `error.message` straight back to the caller.
 * In production that returned, to an anonymous unauthenticated POST:
 *
 *   {"error":"A secret with (name/id) STRIPE-WEBHOOK-SECRET was not found in this key vault."}
 *
 * These tests drive the REAL registered handlers with a dependency rigged to
 * throw, and assert that what the caller can see carries none of the internal
 * detail — while the logs still carry all of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions, makeRequest, makeContext, clientVisible, loggedText } = require('./helpers/harness');

// Stand-ins for the kind of detail these errors really carry.
const DB_DETAIL = "Login failed for user 'foritadmin'. (server=forit-saas-sql.database.windows.net, password=P@ssw0rd-LEAKED)";
const KEYVAULT_404 = 'A secret with (name/id) STRIPE-WEBHOOK-SECRET was not found in this key vault. If you recently deleted this secret you may be able to recover it using the correct recovery command.';

const DB_SENTINELS = ['foritadmin', 'forit-saas-sql.database.windows.net', 'P@ssw0rd-LEAKED'];
const KEYVAULT_SENTINELS = ['STRIPE-WEBHOOK-SECRET', 'key vault'];

const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
};

const throws = (message) => async () => { throw new Error(message); };

const encodeState = (state) => Buffer.from(JSON.stringify(state)).toString('base64url');

const freshState = () => encodeState({
  customer_id: '11111111-2222-3333-4444-555555555555',
  return_url: 'https://www.forit.io/portal/xero-connector',
  timestamp: Date.now(),
});

// Handlers reach dependencies they don't exercise in these paths; these keep
// module load honest without affecting the failure under test.
const inertXeroConnection = {
  refreshAndPersist: async () => ({ status: 'transient', reason: 'unused' }),
  probeConnection: async () => ({ status: 'not_connected' }),
};

const CASES = [
  {
    site: 'mcpAuth.ts:113  GET /api/tokens',
    file: 'functions/mcpAuth.js',
    handler: 'GetTokens',
    sentinels: DB_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/database.js': { validateApiKey: throws(DB_DETAIL), getXeroConnection: async () => null },
      'services/xeroConnection.js': inertXeroConnection,
    },
    request: () => makeRequest({ headers: { 'x-api-key': 'fk_live_probe' } }),
  },
  {
    site: 'connect.ts:143  POST /api/connect/init',
    file: 'functions/connect.js',
    handler: 'ConnectInit',
    sentinels: DB_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/keyvault.js': { getSecret: throws(DB_DETAIL), setSecret: async () => {}, SECRETS },
      'services/database.js': { getCustomerByEmail: async () => null, saveXeroConnection: async () => {} },
      'services/xeroConnection.js': inertXeroConnection,
    },
    request: () => makeRequest({
      headers: { 'x-api-key': 'portal-key' },
      json: { email: 'b.thomas@forit.io', return_url: 'https://www.forit.io/portal/xero-connector' },
    }),
  },
  {
    site: 'connect.ts:391  GET /api/connection-status',
    file: 'functions/connect.js',
    handler: 'ConnectionStatus',
    sentinels: DB_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/keyvault.js': { getSecret: async () => 'portal-key', setSecret: async () => {}, SECRETS },
      'services/database.js': { getCustomerByEmail: throws(DB_DETAIL), saveXeroConnection: async () => {} },
      'services/xeroConnection.js': inertXeroConnection,
    },
    request: () => makeRequest({
      headers: { 'x-api-key': 'portal-key' },
      query: { email: 'b.thomas@forit.io' },
    }),
  },
  {
    // Same class, and it leaks into a redirect URL rather than a body.
    site: 'connect.ts:311  GET /api/callback (redirect)',
    file: 'functions/connect.js',
    handler: 'ConnectCallback',
    sentinels: DB_SENTINELS,
    expectedStatus: 302,
    env: { XERO_CLIENT_ID: '09AF916BFDF94BEB92ABFAA2738FDE98' },
    stubs: {
      'services/keyvault.js': { getSecret: throws(DB_DETAIL), setSecret: async () => {}, SECRETS },
      'services/database.js': { getCustomerByEmail: async () => null, saveXeroConnection: async () => {} },
      'services/xeroConnection.js': inertXeroConnection,
    },
    request: () => makeRequest({ query: { code: 'xero-auth-code', state: freshState() } }),
  },
  {
    site: 'subscriptions.ts:278  POST /api/subscriptions/checkout',
    file: 'functions/subscriptions.js',
    handler: 'SubscriptionsCheckout',
    sentinels: DB_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/database.js': { validateApiKey: throws(DB_DETAIL) },
      'services/keyvault.js': { getSecret: async () => 'sk_test_harness', setSecret: async () => {}, SECRETS },
    },
    request: () => makeRequest({
      headers: { 'x-api-key': 'fk_live_probe' },
      json: { product_slug: 'xero-connector', success_url: 'https://forit.io/ok', cancel_url: 'https://forit.io/no' },
    }),
  },
  {
    // The one proved live in production: anonymous POST, no signature.
    site: 'subscriptions.ts:354  POST /api/subscriptions/webhook',
    file: 'functions/subscriptions.js',
    handler: 'SubscriptionsWebhook',
    sentinels: KEYVAULT_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/database.js': { validateApiKey: async () => null },
      'services/keyvault.js': {
        // Faithful reproduction of production: the Stripe API key resolves,
        // the webhook signing secret 404s.
        getSecret: async (name) => {
          if (name === SECRETS.STRIPE_SECRET_KEY) return 'sk_test_harness';
          throw new Error(KEYVAULT_404);
        },
        setSecret: async () => {},
        SECRETS,
      },
    },
    request: () => makeRequest({ body: '{}' }),
  },
  {
    site: 'subscriptions.ts:582  POST /api/subscriptions/portal',
    file: 'functions/subscriptions.js',
    handler: 'SubscriptionsPortal',
    sentinels: DB_SENTINELS,
    expectedStatus: 500,
    stubs: {
      'services/database.js': { validateApiKey: throws(DB_DETAIL) },
      'services/keyvault.js': { getSecret: async () => 'sk_test_harness', setSecret: async () => {}, SECRETS },
    },
    request: () => makeRequest({ headers: { 'x-api-key': 'fk_live_probe' }, json: {} }),
  },
];

for (const testCase of CASES) {
  test(`no internal detail reaches the caller — ${testCase.site}`, async () => {
    const restore = [];
    for (const [key, value] of Object.entries(testCase.env ?? {})) {
      restore.push([key, process.env[key]]);
      process.env[key] = value;
    }

    try {
      const { handlers } = loadFunctions(testCase.file, testCase.stubs);
      const handler = handlers[testCase.handler];
      assert.ok(handler, `handler ${testCase.handler} was not registered`);

      const context = makeContext();
      const response = await handler(testCase.request(), context);

      const visible = clientVisible(response);
      const logged = loggedText(context);

      // The status must stay honest — we hide the detail, not the failure.
      assert.equal(response.status, testCase.expectedStatus, `status changed: ${visible}`);

      for (const sentinel of testCase.sentinels) {
        assert.ok(
          !visible.includes(sentinel),
          `internal detail "${sentinel}" reached the caller: ${visible}`
        );
      }

      // The caller gets something they can quote back to support.
      assert.match(visible, /correlation_id/, `no correlation id offered to the caller: ${visible}`);
      const correlationId = visible.match(/correlation_id["=:]+([0-9a-f-]{36})/i)?.[1];
      assert.ok(correlationId, `correlation id is not a uuid: ${visible}`);

      // ...and the detail must still be recoverable from the logs, keyed by it.
      for (const sentinel of testCase.sentinels) {
        assert.ok(logged.includes(sentinel), `internal detail "${sentinel}" was dropped from the logs entirely`);
      }
      assert.ok(logged.includes(correlationId), 'logs are not keyed by the correlation id handed to the caller');
    } finally {
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
