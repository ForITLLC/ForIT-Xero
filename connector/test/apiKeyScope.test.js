'use strict';

/**
 * WO#1821B — the read-only API key scope gate.
 *
 * Background: a key used to be all-or-nothing. `xero.api_keys` had no scope
 * column and `authenticateRequest` ran the identical check for every route, so
 * "this consumer is read-only" could only ever be a promise made outside the
 * code. These tests make it an enforced property of the API.
 *
 * Two things here are easy to get wrong and are asserted deliberately:
 *
 *  1. The catch-all `connector/{*path}` accepts GET/POST/PUT/PATCH/DELETE and
 *     proxies straight to Xero. A per-route allow-list that gates the named
 *     write routes and misses this one buys nothing. The tests assert the
 *     rejection happens BEFORE the upstream fetch, not after.
 *
 *  2. `GET /api/tokens` hands back a Xero access_token AND refresh_token. It is
 *     a GET, so a pure method gate would let a read-only key through — and the
 *     holder could then write to Xero directly, completely outside this API.
 *     A read-scoped key is refused there regardless of method.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions, makeRequest, makeContext } = require('./helpers/harness');

const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
};

// Far enough in the future that no handler takes the refresh branch.
const NOT_EXPIRING = Math.floor(Date.now() / 1000) + 86400;

function stubs(scope) {
  return {
    'services/keyvault.js': { getSecret: async () => 'stub', setSecret: async () => {}, disableSecret: async () => {}, SECRETS },
    'services/database.js': {
      validateApiKey: async () => ({ id: 'cust-1', email: 'probe@forit.io', key_scope: scope }),
      checkProductAccess: async () => true,
      getXeroConnection: async () => ({
        customer_id: 'cust-1',
        tenant_id: 'tenant-1',
        access_token: 'access-token-stub',
        refresh_token: 'refresh-token-stub',
        expires_at: NOT_EXPIRING,
      }),
    },
    'services/xeroConnection.js': {
      refreshAndPersist: async () => ({
        status: 'connected',
        accessToken: 'access-token-stub',
        refreshToken: 'refresh-token-stub',
        tenantId: 'tenant-1',
        expiresAt: NOT_EXPIRING,
      }),
      probeConnection: async () => ({ status: 'connected' }),
    },
  };
}

/** A request the real handlers can drive: method, route params and a query it can iterate. */
function request({ method = 'GET', path = '', body = '' } = {}) {
  const base = makeRequest({ headers: { 'x-api-key': 'stub-key' }, body });
  return {
    ...base,
    method,
    params: { path },
    query: { ...base.query, forEach: () => {} },
  };
}

/** Run a handler with `fetch` replaced, and report whether it was reached. */
async function withFetchSpy(fn) {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return { ok: true, status: 200, text: async () => '{"Organisations":[]}' };
  };
  try {
    const result = await fn();
    return { result, fetched: called };
  } finally {
    globalThis.fetch = original;
  }
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

test('read-scoped key is refused on every write method through the catch-all, before any upstream call', async () => {
  for (const method of WRITE_METHODS) {
    const { handlers } = loadFunctions('functions/connector.js', stubs('read'));
    const { result, fetched } = await withFetchSpy(() =>
      handlers.ConnectorPassthrough(request({ method, path: 'Payments' }), makeContext())
    );

    assert.equal(result.status, 403, `${method} through the catch-all should be 403, got ${result.status}`);
    assert.equal(fetched, 0, `${method} reached Xero despite a read-only key — the gate must reject before proxying`);
  }
});

test('read-scoped key still passes on GET through the catch-all', async () => {
  const { handlers } = loadFunctions('functions/connector.js', stubs('read'));
  const { result, fetched } = await withFetchSpy(() =>
    handlers.ConnectorPassthrough(request({ method: 'GET', path: 'Organisation' }), makeContext())
  );

  assert.equal(result.status, 200);
  assert.equal(fetched, 1, 'a read-only key must still be able to read');
});

test('read-scoped key is refused on the named write routes', async () => {
  const cases = [
    ['ConnectorCreatePayment', 'POST'],
    ['ConnectorDeletePayment', 'DELETE'],
    ['ConnectorSetInvoiceStatus', 'POST'],
    ['ConnectorRecodeInvoiceLine', 'POST'],
    ['ConnectorCreateInvoice', 'POST'],
    ['ConnectorCreateContact', 'POST'],
  ];

  for (const [name, method] of cases) {
    const { handlers } = loadFunctions('functions/connector.js', stubs('read'));
    assert.ok(handlers[name], `${name} is not registered`);
    const { result, fetched } = await withFetchSpy(() =>
      handlers[name](request({ method, body: '{}' }), makeContext())
    );

    assert.equal(result.status, 403, `${name} should be 403 for a read-only key, got ${result.status}`);
    assert.equal(fetched, 0, `${name} reached Xero despite a read-only key`);
  }
});

test('read-scoped key cannot obtain Xero tokens — a GET that would hand out full write access', async () => {
  const { handlers } = loadFunctions('functions/mcpAuth.js', stubs('read'));
  const result = await handlers.GetTokens(request({ method: 'GET' }), makeContext());

  assert.equal(result.status, 403, 'GET /api/tokens must refuse a read-only key');

  const visible = JSON.stringify(result);
  assert.ok(!visible.includes('access-token-stub'), 'a read-only key was handed a Xero access token');
  assert.ok(!visible.includes('refresh-token-stub'), 'a read-only key was handed a Xero refresh token');
});

test('full-scoped key is unaffected on writes, reads and tokens', async () => {
  for (const method of WRITE_METHODS) {
    const { handlers } = loadFunctions('functions/connector.js', stubs('full'));
    const { result } = await withFetchSpy(() =>
      handlers.ConnectorPassthrough(request({ method, path: 'Payments' }), makeContext())
    );
    assert.notEqual(result.status, 403, `${method} was gated for a full-scope key`);
  }

  const { handlers } = loadFunctions('functions/mcpAuth.js', stubs('full'));
  const tokens = await handlers.GetTokens(request({ method: 'GET' }), makeContext());
  assert.equal(tokens.status, 200);
});

/**
 * The deploy-order guard. This code ships before the migration can be applied,
 * so `validateApiKey` may legitimately return a row with no scope at all. That
 * must behave exactly as it does today — anything else takes down the Power
 * Automate lane, which is currently the only healthy consumer of this API.
 */
test('a key row with no scope behaves as full — the schema may not have the column yet', async () => {
  for (const absent of [undefined, null]) {
    const { handlers } = loadFunctions('functions/connector.js', stubs(absent));
    const { result } = await withFetchSpy(() =>
      handlers.ConnectorPassthrough(request({ method: 'POST', path: 'Payments' }), makeContext())
    );
    assert.notEqual(result.status, 403, `scope=${absent} must not be gated`);
  }
});
