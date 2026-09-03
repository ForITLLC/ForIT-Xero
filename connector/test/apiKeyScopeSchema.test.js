'use strict';

/**
 * WO#1821B-2 — how validateApiKey discovers whether xero.api_keys has a scope
 * column, and what it does before and after the migration.
 *
 * Two failure modes are pinned here, both silent, both worse than a crash:
 *
 *  1. Selecting `ak.scope` against a database that has not run sql/007 fails
 *     the whole query — every authenticated request 500s, including the Power
 *     Automate lane, which is currently the only healthy consumer of this API.
 *     So the column is probed, not assumed.
 *
 *  2. Caching a NEGATIVE probe result would leave a running instance resolving
 *     every key as 'full' for the rest of its life. Applying a migration
 *     restarts nothing, so the gate would sit inert after the migration until
 *     somebody happened to redeploy — a security control that is switched off
 *     and says nothing. Only the positive may be cached.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadFunctions, DIST } = require('./helpers/harness');

/**
 * A database that answers COL_LENGTH from `state.columnExists`, so a migration
 * can be simulated mid-test by flipping it — exactly what happens in
 * production, where nothing restarts.
 */
function fakeDatabase(state) {
  // NVarChar is callable in mssql (`sql.NVarChar(sql.MAX)`) as well as usable
  // bare, so the stub has to be a function. The types are never inspected here.
  const sql = {
    NVarChar: () => 'NVarChar(MAX)',
    UniqueIdentifier: 'UniqueIdentifier',
    Int: 'Int',
    Bit: 'Bit',
    MAX: 'MAX',
    connect: async () => pool,
  };

  const pool = {
    request() {
      const req = {
        input: () => req,
        query: async (text) => {
          state.queries.push(text);

          if (text.includes('COL_LENGTH')) {
            state.probes += 1;
            return { recordset: [{ scope_column: state.columnExists ? 32 : null }] };
          }

          if (text.includes('FROM xero.customers c')) {
            // The database can only return a real scope if the query asked for
            // one. Anything else is the literal 'full' the fallback selects.
            return {
              recordset: [
                { id: 'cust-1', email: 'probe@forit.io', key_scope: text.includes('ak.scope') ? 'read' : 'full' },
              ],
            };
          }

          return { recordset: [] };
        },
      };
      return req;
    },
  };

  return sql;
}

function loadDatabase(state) {
  const externals = {
    mssql: fakeDatabase(state),
    '@azure/identity': { DefaultAzureCredential: class {} },
    '@azure/keyvault-secrets': {
      SecretClient: class {
        async getSecret() {
          return { value: 'db-password-stub' };
        }
      },
    },
  };

  // loadFunctions purges the compiled tree and seeds the stubs, so each call
  // gets a module with its own fresh module-level probe cache.
  loadFunctions('services/database.js', {}, externals);
  return require(path.join(DIST, 'services', 'database.js'));
}

function newState(columnExists) {
  return { columnExists, probes: 0, queries: [] };
}

test('before the migration it never names the column, and reports full', async () => {
  const state = newState(false);
  const db = loadDatabase(state);

  const customer = await db.validateApiKey('fmcp_whatever');

  assert.equal(customer.key_scope, 'full');
  const select = state.queries.find((q) => q.includes('FROM xero.customers c'));
  assert.ok(
    !select.includes('ak.scope'),
    'selected ak.scope against an unmigrated database — this 500s every authenticated request'
  );
});

test('after the migration it reads the real scope', async () => {
  const state = newState(true);
  const db = loadDatabase(state);

  const customer = await db.validateApiKey('fmcp_whatever');

  assert.equal(customer.key_scope, 'read');
  const select = state.queries.find((q) => q.includes('FROM xero.customers c'));
  assert.ok(select.includes('ak.scope'), 'did not read the scope column that exists');
});

/**
 * The one that matters. Applying a migration restarts nothing, so a live
 * instance MUST notice the column appearing underneath it.
 */
test('an instance that started before the migration picks the column up without a restart', async () => {
  const state = newState(false);
  const db = loadDatabase(state);

  const before = await db.validateApiKey('fmcp_whatever');
  assert.equal(before.key_scope, 'full');

  // The migration runs. Nothing restarts.
  state.columnExists = true;

  const after = await db.validateApiKey('fmcp_whatever');
  assert.equal(
    after.key_scope,
    'read',
    'the gate stayed inert after the migration — a negative probe result was cached'
  );
});

test('once the column exists the probe stops running', async () => {
  const state = newState(true);
  const db = loadDatabase(state);

  await db.validateApiKey('fmcp_whatever');
  const afterFirst = state.probes;
  assert.equal(afterFirst, 1);

  await db.validateApiKey('fmcp_whatever');
  await db.validateApiKey('fmcp_whatever');
  assert.equal(state.probes, afterFirst, 'positive probe result is not cached — one COL_LENGTH per request forever');
});

test('getApiKeyScopeGateState reports what health needs to state', async () => {
  const absent = newState(false);
  assert.deepEqual(await loadDatabase(absent).getApiKeyScopeGateState(), { armed: false });

  const present = newState(true);
  assert.deepEqual(await loadDatabase(present).getApiKeyScopeGateState(), { armed: true });
});

test('an unknown or missing scope value is treated as full, never as read', async () => {
  const db = loadDatabase(newState(true));

  for (const value of [undefined, null, '', 'readonly', 'READ', 'full']) {
    assert.equal(db.normalizeScope(value), 'full', `${String(value)} must not narrow or widen silently`);
  }
  assert.equal(db.normalizeScope('read'), 'read');
});
