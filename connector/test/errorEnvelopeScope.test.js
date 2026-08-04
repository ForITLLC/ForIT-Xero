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

const WHY_THE_PASSTHROUGH_STAYS =
  "connector.ts has TWO return paths and they are not the same thing. The Xero PASSTHROUGH " +
  '(`!response.ok` -> responseText) carries Xero\'s own validation text at Xero\'s own status ' +
  "code, and Ben's live Power Automate flows branch on it — it must keep flowing through. The " +
  'CATCH blocks never carry Xero text; they fire on internal failures and used to hand an ' +
  'anonymous caller the SQL server and login, a password fragment and a Key Vault secret name. ' +
  'WO#1137 excluded this file believing both paths were Xero\'s; WO#1148 D3 drove all 28 routes ' +
  'and found otherwise. See the header comment in src/functions/connector.ts.';

// true = returns an opaque body via services/errors on internal failure
const EXPECTED_ENVELOPE_USE = {
  'mcpAuth.ts': true,
  'connect.ts': true,
  'subscriptions.ts': true,
  'health.ts': true,
  'connector.ts': true, // catch blocks only — the Xero passthrough is untouched
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

test('connector.ts leaks no raw internal message from any catch block', () => {
  const source = readFunctionSource('connector.ts');

  const rawMessageSites = source.match(/error instanceof Error \? error\.message : String\(error\)/g) ?? [];
  assert.equal(
    rawMessageSites.length,
    0,
    `connector.ts has ${rawMessageSites.length} raw-message sites; they must all go through ` +
    `services/errors. ${WHY_THE_PASSTHROUGH_STAYS}`
  );
});

test("connector.ts keeps passing Xero's own text through — that half is deliberate", () => {
  const source = readFunctionSource('connector.ts');

  // The passthrough is what live flows read. Losing it is as much a defect as
  // the leak was; anonymousErrorPaths.test.js proves it still works end to end.
  const passthroughSites = source.match(/jsonBody: \{ error: responseText \}/g) ?? [];
  assert.ok(
    passthroughSites.length >= 10,
    `the Xero passthrough dropped to ${passthroughSites.length} sites. ${WHY_THE_PASSTHROUGH_STAYS}`
  );
});

test('the reason is written down where someone about to change it will look', () => {
  const source = readFunctionSource('connector.ts');
  assert.match(source, /TWO RETURN PATHS/, 'the rationale header in connector.ts is gone');
  assert.match(source, /Power Automate/, 'the rationale no longer names the consumer at risk');
});
