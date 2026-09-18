'use strict';

/**
 * WO#2073 — the Xero OAuth scope set is ONE list, requested identically at
 * consent (POST /api/connect/init) and at refresh (xeroConnection), and it
 * covers the reads for-Finance's X4 archive needs: Journals, Reports,
 * Attachments (Settings reads are already inside the broad accounting.settings).
 *
 * Why this is pinned: the list used to live as two hand-copied arrays
 * (connect.ts and xeroConnection.ts). Two copies drift, and a refresh that
 * requests fewer scopes than the consent did is a silent way to narrow a
 * grant. One constant, two call sites, one test that drives both real
 * handlers and reads what they actually hand to xero-node.
 *
 * What is deliberately NOT here: any scope the connector does not use. Xero
 * shows every scope on the consent screen, and the March 2026 attempt to
 * request everything (f79c835, reverted in 8ac1c12) is the cautionary tale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadFunctions, makeRequest, makeContext } = require('./helpers/harness');

const DIST = path.resolve(__dirname, '..', 'dist', 'src');

const SECRETS = {
  XERO_CLIENT_SECRET: 'XERO-CLIENT-SECRET',
  XERO_REFRESH_TOKEN: 'xero-refresh-token',
  XERO_TENANT_ID: 'xero-tenant-id',
  PORTAL_API_KEY: 'PORTAL-API-KEY',
  STRIPE_SECRET_KEY: 'STRIPE-SECRET-KEY',
  STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
};

const KEYVAULT_STUB = {
  getSecret: async () => 'stub',
  setSecret: async () => {},
  disableSecret: async () => {},
  SECRETS,
};

// What the connector was consented with before WO#2073. Every one of these
// must survive: dropping one would break a live route on re-consent.
const BASELINE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.transactions',
  'accounting.settings',
  'accounting.contacts',
];

// The reads WO#2073 adds. accounting.settings.read is intentionally absent —
// the broad accounting.settings already grants it.
const WO2073_READS = [
  'accounting.journals.read',
  'accounting.reports.read',
  'accounting.attachments.read',
];

/**
 * A xero-node stand-in that records every constructor config so the test can
 * read the scopes the real code handed over. Nothing here touches the network.
 */
function xeroNodeStub(captured) {
  class XeroClient {
    constructor(config) {
      captured.push(config);
      this.tenants = [];
    }
    async initialize() { return this; }
    async buildConsentUrl() {
      const last = captured[captured.length - 1] || {};
      return 'https://login.xero.com/identity/connect/authorize?scope=' +
        encodeURIComponent((last.scopes || []).join(' '));
    }
    setTokenSet() {}
    async refreshToken() {
      return {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      };
    }
    async updateTenants() {}
    async apiCallback() { return {}; }
  }
  return { XeroClient };
}

function loadScopes() {
  return require(path.join(DIST, 'services', 'xeroScopes.js')).XERO_OAUTH_SCOPES;
}

test('the scope list is one constant: baseline kept, WO#2073 reads added, no duplicates, no redundant .read twins', () => {
  const scopes = loadScopes();
  assert.ok(Array.isArray(scopes) && scopes.length > 0, 'XERO_OAUTH_SCOPES must be a non-empty array');
  for (const s of [...BASELINE, ...WO2073_READS]) {
    assert.ok(scopes.includes(s), `scope list is missing ${s}`);
  }
  assert.equal(new Set(scopes).size, scopes.length, 'scope list has a duplicate');
  assert.ok(!scopes.includes('accounting.settings.read'),
    'accounting.settings already grants settings reads; the .read twin is noise on the consent screen');
  assert.ok(!scopes.includes('accounting.contacts.read'),
    'accounting.contacts already grants contact reads; the .read twin is noise on the consent screen');
});

test('POST /api/connect/init hands xero-node exactly the shared list', async () => {
  process.env.XERO_CLIENT_ID = 'test-client-id';
  const captured = [];
  const { handlers } = loadFunctions(
    'functions/connect.js',
    {
      'services/keyvault.js': KEYVAULT_STUB,
      'services/database.js': {
        getCustomerByEmail: async () => ({ id: '11111111-1111-1111-1111-111111111111', email: 'x@example.com' }),
        saveXeroConnection: async () => ({}),
      },
      'services/xeroConnection.js': { probeConnection: async () => ({ status: 'not_connected' }) },
    },
    { 'xero-node': xeroNodeStub(captured) },
  );
  const scopes = loadScopes();

  const res = await handlers.ConnectInit(
    makeRequest({
      headers: { 'x-api-key': 'stub' },
      json: { email: 'x@example.com', return_url: 'https://www.forit.io/portal/xero-connector' },
    }),
    makeContext(),
  );

  assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
  assert.equal(captured.length, 1, 'connect/init should construct exactly one XeroClient');
  assert.deepEqual(captured[0].scopes, scopes);
  assert.match(res.jsonBody.oauth_url, /accounting\.journals\.read/);
});

test('the refresh path requests the same list, so a refreshed token never narrows the consent', async () => {
  process.env.XERO_CLIENT_ID = 'test-client-id';
  const captured = [];
  const now = Math.floor(Date.now() / 1000);
  loadFunctions(
    'services/xeroConnection.js',
    {
      'services/keyvault.js': KEYVAULT_STUB,
      'services/database.js': {
        getXeroConnection: async () => ({
          id: 'row', customer_id: 'cid', tenant_id: 'tenant', tenant_name: 'Org',
          access_token: 'stale', refresh_token: 'stale-refresh', expires_at: now - 60,
        }),
        updateXeroTokens: async () => {},
        deleteXeroConnectionsByCustomer: async () => {},
        withRefreshLock: async (_customerId, fn) => ({ acquired: true, value: await fn({}) }),
      },
    },
    { 'xero-node': xeroNodeStub(captured) },
  );
  const scopes = loadScopes();
  const svc = require(path.join(DIST, 'services', 'xeroConnection.js'));

  const result = await svc.refreshAndPersist('cid');

  assert.equal(result.status, 'connected', JSON.stringify(result));
  assert.equal(captured.length, 1, 'refresh should construct exactly one XeroClient');
  assert.deepEqual(captured[0].scopes, scopes);
});
