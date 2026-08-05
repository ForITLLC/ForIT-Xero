'use strict';
// WO#1250 D3 — TEMPORARY. Proves the PR check actually fails on a break.
// A check that has only ever passed is a check nobody has tested.
// This file is reverted in the next commit and must never reach main.
const test = require('node:test');
const assert = require('node:assert/strict');

test('deliberate failure to prove the PR check goes red', () => {
  assert.equal(1, 2, 'intentional failure — WO#1250 D3 red-phase probe');
});
