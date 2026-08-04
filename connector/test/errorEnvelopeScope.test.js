'use strict';

/**
 * WO#1142 D4 — pin which surfaces use the opaque error envelope, and which
 * deliberately do not.
 *
 * WO#1137 fixed nine raw-error leaks and deliberately left connector.ts's
 * fifteen alone. That judgment currently lives in a commit message and a
 * comment; this makes it fail loudly instead of quietly rotting.
 *
 * If a test here fails, do not "fix" the code until you have read the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONNECTOR_ROOT } = require('./helpers/harness');

const FUNCTIONS_DIR = path.join(CONNECTOR_ROOT, 'src', 'functions');

const WHY_CONNECTOR_IS_EXCLUDED =
  'connector.ts is EXCLUDED ON PURPOSE. Its routes are gated by x-api-key -> an active ' +
  'xero-connector subscription, and the messages they return are Xero validation text that ' +
  "Ben's live Power Automate flows branch on. Making them opaque breaks working flows and " +
  'hardens nothing — the caller is an authenticated customer, not the anonymous internet. ' +
  'See the header comment in src/functions/connector.ts. If you mean to change this, change ' +
  'this pin too, and check the Power Automate consumers first.';

// true  = anonymous surface, must return an opaque body via services/errors
// false = deliberately excluded, see the reason above
const EXPECTED_ENVELOPE_USE = {
  'mcpAuth.ts': true,
  'connect.ts': true,
  'subscriptions.ts': true,
  'health.ts': true,
  'connector.ts': false,
  'keepAlive.ts': false, // timer-triggered, returns nothing to any caller
  'mcp.ts': false,
  'index.ts': false,
};

function readFunctionSource(file) {
  return fs.readFileSync(path.join(FUNCTIONS_DIR, file), 'utf8');
}

function usesEnvelope(source) {
  return /from '\.\.\/services\/errors'/.test(source);
}

test('the set of function modules is the set this pin covers', () => {
  const actual = fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.ts')).sort();
  const expected = Object.keys(EXPECTED_ENVELOPE_USE).sort();

  assert.deepEqual(
    actual,
    expected,
    'a function module was added or removed. Decide whether it is an anonymous surface that ' +
    'must use services/errors, then update EXPECTED_ENVELOPE_USE.'
  );
});

test('every anonymous surface uses the opaque error envelope', () => {
  for (const [file, shouldUse] of Object.entries(EXPECTED_ENVELOPE_USE)) {
    if (!shouldUse) continue;
    assert.ok(
      usesEnvelope(readFunctionSource(file)),
      `${file} no longer imports services/errors. Anonymous surfaces must not return raw ` +
      'internal messages — that was the WO#1137 defect.'
    );
  }
});

test('connector.ts stays on raw Xero messages — deliberately', () => {
  const source = readFunctionSource('connector.ts');

  assert.ok(!usesEnvelope(source), WHY_CONNECTOR_IS_EXCLUDED);

  // Pinned so that adding a route here is a decision, not a drift.
  const rawMessageSites = source.match(/error instanceof Error \? error\.message : String\(error\)/g) ?? [];
  assert.equal(
    rawMessageSites.length,
    15,
    `connector.ts has ${rawMessageSites.length} raw-message sites, pinned at 15. ` +
    WHY_CONNECTOR_IS_EXCLUDED
  );
});

test('the reason is written down where someone about to change it will look', () => {
  const source = readFunctionSource('connector.ts');
  assert.match(source, /DELIBERATE/, 'the rationale header in connector.ts is gone');
  assert.match(source, /Power Automate/, 'the rationale no longer names the consumer at risk');
});
