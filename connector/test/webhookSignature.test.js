'use strict';

/**
 * WO#1142 D2 — the signature guard.
 *
 * The webhook had never verified a signature in production: it 500'd on secret
 * lookup before reaching the check. Correcting the lookup name is only half the
 * job — nothing bound the verify path, so nothing would notice if it broke or
 * if the lookup name drifted again.
 *
 * The Key Vault stub here mirrors the REAL vault inventory: STRIPE-SECRET-KEY
 * and STRIPE-SUBSCRIPTION-WEBHOOK-SECRET resolve, every other name 404s exactly
 * as Azure does. The handler asks for whichever name `SECRETS` really carries,
 * so this suite fails if that constant points at a name the vault does not
 * hold — which is precisely the production defect.
 *
 * The signing secret is generated per run: never hardcoded, never printed, and
 * never asserted against.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const { loadFunctions, makeRequest, makeContext, clientVisible, DIST } = require('./helpers/harness');

// The real constants — not a copy. If SECRETS.<name> drifts, these tests move with it.
const { SECRETS } = require(path.join(DIST, 'services', 'keyvault.js'));

// Exactly what forit-xero-mcp-kv holds (enumerated 2026-08-04).
const VAULT_CONTENTS = new Set([
  'MCP-API-KEY',
  'PORTAL-API-KEY',
  'STRIPE-SECRET-KEY',
  'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET',
  'XERO-CLIENT-SECRET',
  'xero-refresh-token',
  'xero-tenant-id',
]);

const Stripe = require('stripe');
const signingHelper = new Stripe('sk_test_harness_not_a_real_key');

function freshSigningSecret() {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

function keyvaultMirroringProduction(signingSecret) {
  return {
    SECRETS,
    setSecret: async () => {},
    getSecret: async (name) => {
      if (!VAULT_CONTENTS.has(name)) {
        const error = new Error(`A secret with (name/id) ${name} was not found in this key vault.`);
        error.code = 'SecretNotFound';
        error.statusCode = 404;
        throw error;
      }
      if (name === 'STRIPE-SECRET-KEY') return 'sk_test_harness_not_a_real_key';
      if (name === 'STRIPE-SUBSCRIPTION-WEBHOOK-SECRET') return signingSecret;
      return 'unused';
    },
  };
}

function loadWebhook(signingSecret) {
  const { handlers } = loadFunctions('functions/subscriptions.js', {
    'services/database.js': { validateApiKey: async () => null },
    'services/keyvault.js': keyvaultMirroringProduction(signingSecret),
  });
  return handlers.SubscriptionsWebhook;
}

// An event type the handler does not act on: this suite is about the signature
// check, not about what happens after it.
const EVENT_PAYLOAD = JSON.stringify({
  id: 'evt_wo1142_harness',
  object: 'event',
  type: 'invoice.payment_succeeded',
  data: { object: { id: 'in_harness' } },
});

test('a correctly-signed payload verifies and is accepted', async () => {
  const signingSecret = freshSigningSecret();
  const handler = loadWebhook(signingSecret);

  const signature = signingHelper.webhooks.generateTestHeaderString({
    payload: EVENT_PAYLOAD,
    secret: signingSecret,
  });

  const context = makeContext();
  const response = await handler(
    makeRequest({ body: EVENT_PAYLOAD, headers: { 'stripe-signature': signature } }),
    context
  );

  assert.equal(response.status, 200, `signature verification failed: ${clientVisible(response)}`);
  assert.deepEqual(response.jsonBody, { received: true });
});

test('a payload signed with the wrong secret is rejected', async () => {
  const handler = loadWebhook(freshSigningSecret());

  const signature = signingHelper.webhooks.generateTestHeaderString({
    payload: EVENT_PAYLOAD,
    secret: freshSigningSecret(), // a different secret than the vault holds
  });

  const context = makeContext();
  const response = await handler(
    makeRequest({ body: EVENT_PAYLOAD, headers: { 'stripe-signature': signature } }),
    context
  );

  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error, 'Webhook signature verification failed');
  assert.match(clientVisible(response), /correlation_id/);
});

test('a tampered payload is rejected even with a signature that was once valid', async () => {
  const signingSecret = freshSigningSecret();
  const handler = loadWebhook(signingSecret);

  const signature = signingHelper.webhooks.generateTestHeaderString({
    payload: EVENT_PAYLOAD,
    secret: signingSecret,
  });

  const tampered = JSON.stringify({ ...JSON.parse(EVENT_PAYLOAD), type: 'customer.subscription.deleted' });

  const context = makeContext();
  const response = await handler(
    makeRequest({ body: tampered, headers: { 'stripe-signature': signature } }),
    context
  );

  assert.equal(response.status, 400);
});

test('a request with no signature header is rejected before verification', async () => {
  const handler = loadWebhook(freshSigningSecret());

  const context = makeContext();
  const response = await handler(makeRequest({ body: EVENT_PAYLOAD }), context);

  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error, 'Missing stripe-signature header');
});

test('the signing secret never reaches the caller on any of those paths', async () => {
  const signingSecret = freshSigningSecret();
  const handler = loadWebhook(signingSecret);

  const responses = [
    await handler(makeRequest({ body: EVENT_PAYLOAD }), makeContext()),
    await handler(makeRequest({ body: EVENT_PAYLOAD, headers: { 'stripe-signature': 't=1,v1=bogus' } }), makeContext()),
  ];

  for (const response of responses) {
    assert.ok(!clientVisible(response).includes(signingSecret));
    assert.ok(!clientVisible(response).includes('whsec_'));
  }
});
