'use strict';

/**
 * WO#1155 D1 — voidInvoices must not be able to sweep.
 *
 * `deleteInvoice` already refuses anything that is not a DRAFT. `voidInvoices`
 * had no dry-run, no confirmation and no scope bound: one POST with a list of
 * ids voided every one of them in the client's accounting record, gated by
 * nothing but a shared function key travelling over a channel that (until this
 * WO) did not even force TLS. The asymmetry was the defect.
 *
 * Established before changing the default: Application Insights shows ZERO
 * VoidInvoices requests in 90 days on forit-interest-insights — the only names
 * that appear at all are DailyAccrual, ReconcileVoided, AuthStart, AuthCallback.
 * No live caller can be broken by making dry-run the default.
 *
 * Nothing here touches Xero: the service is stubbed and asserted against.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFunctions, makeRequest, makeContext } = require('./helpers/harness');

function loadHandler() {
  const voided = [];
  const { handlers } = loadFunctions('functions/voidInvoices.js', {
    'services/xero.js': {
      voidInvoices: async (ids) => {
        voided.push(...ids);
        return { voided: ids, failed: [] };
      },
    },
  });
  return { handler: handlers.VoidInvoices, voided };
}

async function call(body) {
  const { handler, voided } = loadHandler();
  const response = await handler(makeRequest({ json: body }), makeContext());
  return { response, voided };
}

test('the old unguarded call shape no longer voids anything', async () => {
  // This is exactly what a leaked key would send today.
  const { response, voided } = await call({ invoiceIds: ['inv-1', 'inv-2'] });

  assert.deepEqual(voided, [], 'invoices were voided by a call carrying no confirmation');
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.dryRun, true, 'dry-run is not the default');
  assert.equal(response.jsonBody.wouldVoidCount, 2);
});

test('dryRun:false alone is still refused — the confirmation is not a default', async () => {
  const { response, voided } = await call({ invoiceIds: ['inv-1'], dryRun: false });

  assert.deepEqual(voided, []);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.jsonBody), /confirm/i);
});

test('a wrong confirmation is refused', async () => {
  const { response, voided } = await call({ invoiceIds: ['inv-1'], dryRun: false, confirm: 'yes' });

  assert.deepEqual(voided, []);
  assert.equal(response.status, 400);
});

test('dryRun:false with the exact confirmation voids, and only then', async () => {
  const { response, voided } = await call({ invoiceIds: ['inv-1', 'inv-2'], dryRun: false, confirm: 'VOID' });

  assert.deepEqual(voided, ['inv-1', 'inv-2']);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.dryRun, false);
  assert.equal(response.jsonBody.voidedCount, 2);
});

test('no single call can sweep — the batch is bounded', async () => {
  const many = Array.from({ length: 26 }, (_, i) => `inv-${i}`);
  const { response, voided } = await call({ invoiceIds: many, dryRun: false, confirm: 'VOID' });

  assert.deepEqual(voided, [], 'an oversized batch was voided');
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(response.jsonBody), /25/, 'the refusal does not state the bound');
});

test('the bound is inclusive at its limit', async () => {
  const exactly = Array.from({ length: 25 }, (_, i) => `inv-${i}`);
  const { response, voided } = await call({ invoiceIds: exactly, dryRun: false, confirm: 'VOID' });

  assert.equal(response.status, 200);
  assert.equal(voided.length, 25);
});

test('a malformed request is still rejected', async () => {
  const { response, voided } = await call({});
  assert.deepEqual(voided, []);
  assert.equal(response.status, 400);
});
