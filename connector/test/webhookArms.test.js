'use strict';

/**
 * WO#1145 D3 — what each `enabled_events` arm actually DOES.
 *
 * `subscription_webhook_ready` claims subscriptions work. A signature test only
 * proves the door opens. These drive a locally-signed synthetic event of each
 * type the Stripe endpoint is subscribed to (checkout.session.completed,
 * customer.subscription.updated, customer.subscription.deleted) through the
 * real handler, with the database and Stripe's API stubbed, and pin what
 * happens on the other side: provisions, or no-ops with a trace.
 *
 * Signed locally with generated key material. Touches Stripe not at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const { loadFunctions, makeRequest, makeContext, loggedText, DIST } = require('./helpers/harness');

const { SECRETS } = require(path.join(DIST, 'services', 'keyvault.js'));

// Captured before any stub replaces the module in require.cache.
const RealStripe = require('stripe');
const signer = new RealStripe('sk_test_harness_not_a_real_key');

const CUSTOMER_ID = '11111111-2222-3333-4444-555555555555';
const PRODUCT_ID = '99999999-8888-7777-6666-555555555555';
const SUBSCRIPTION_ID = 'sub_wo1145harness';

const PERIOD_START = 1785000000;
const PERIOD_END = 1787592000;

/**
 * A subscription as Stripe actually sends it under the API version this
 * endpoint runs (no pinned api_version -> account default). current_period_*
 * lives on the ITEM: stripe-node 20.1.0's Subscription type carries no
 * current_period field at all.
 */
function subscriptionFixture(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    status: 'active',
    customer: 'cus_harness',
    items: {
      object: 'list',
      data: [
        {
          id: 'si_harness',
          object: 'subscription_item',
          price: { id: 'price_harness' },
          current_period_start: PERIOD_START,
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...overrides,
  };
}

function makeDb(recorded, recordsetFor) {
  const pool = {
    request() {
      const inputs = {};
      const req = {
        input(name, ...rest) {
          inputs[name] = rest.length >= 2 ? rest[1] : rest[0];
          return req;
        },
        async query(text) {
          const flat = String(text).replace(/\s+/g, ' ').trim();
          recorded.push({ sql: flat, inputs });
          return { recordset: recordsetFor(flat) };
        },
      };
      return req;
    },
  };
  return {
    connect: async () => pool,
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
    DateTime2: 'DateTime2',
    Int: 'Int',
    Bit: 'Bit',
  };
}

function makeStripeStub(apiCalls, fixtures) {
  return function StripeStub() {
    return {
      webhooks: signer.webhooks,
      subscriptions: {
        retrieve: async (id) => {
          apiCalls.push(['subscriptions.retrieve', id]);
          return fixtures.subscription ?? subscriptionFixture();
        },
      },
      customers: {
        retrieve: async (id) => {
          apiCalls.push(['customers.retrieve', id]);
          return fixtures.customer ?? { id, metadata: { forit_customer_id: CUSTOMER_ID } };
        },
      },
    };
  };
}

/**
 * Drive one signed event through the real webhook handler.
 * Returns everything observable: the response, the SQL, the Stripe API calls
 * and the logs.
 */
async function deliver(eventPayload, { recordsetFor = () => [], fixtures = {} } = {}) {
  const signingSecret = `whsec_${randomBytes(24).toString('hex')}`;
  const sql = [];
  const apiCalls = [];

  const { handlers } = loadFunctions(
    'functions/subscriptions.js',
    {
      'services/database.js': { validateApiKey: async () => null },
      'services/keyvault.js': {
        SECRETS,
        setSecret: async () => {},
        getSecret: async (name) =>
          name === SECRETS.STRIPE_SECRET_KEY ? 'sk_test_harness_not_a_real_key' : signingSecret,
      },
    },
    {
      mssql: makeDb(sql, recordsetFor),
      stripe: makeStripeStub(apiCalls, fixtures),
      '@azure/identity': { DefaultAzureCredential: class {} },
      '@azure/keyvault-secrets': {
        SecretClient: class {
          async getSecret() { return { value: 'db-password-never-read-by-the-test' }; }
        },
      },
    }
  );

  const body = JSON.stringify(eventPayload);
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret: signingSecret });

  const context = makeContext();
  const response = await handlers.SubscriptionsWebhook(
    makeRequest({ body, headers: { 'stripe-signature': signature } }),
    context
  );

  return { response, sql, apiCalls, context, logs: loggedText(context) };
}

const merges = (sql) => sql.filter((q) => /MERGE xero\.customer_products/i.test(q.sql));

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

test('checkout.session.completed provisions the subscription with a real billing period', async () => {
  const { response, sql, apiCalls } = await deliver({
    id: 'evt_checkout',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_harness',
        object: 'checkout.session',
        subscription: SUBSCRIPTION_ID,
        metadata: { forit_customer_id: CUSTOMER_ID, forit_product_id: PRODUCT_ID },
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(apiCalls, [['subscriptions.retrieve', SUBSCRIPTION_ID]]);

  const written = merges(sql);
  assert.equal(written.length, 1, 'the arm did not provision anything');

  const { inputs } = written[0];
  assert.equal(inputs.customer_id, CUSTOMER_ID);
  assert.equal(inputs.product_id, PRODUCT_ID);
  assert.equal(inputs.stripe_subscription_id, SUBSCRIPTION_ID);
  assert.equal(inputs.status, 'active');

  // The defect this test exists for: Stripe moved current_period_* onto the
  // subscription ITEM, so reading them off the subscription yields undefined
  // and `new Date(undefined * 1000)` is an Invalid Date written to a DateTime2.
  assert.ok(inputs.starts_at instanceof Date, `starts_at is not a Date: ${inputs.starts_at}`);
  assert.ok(
    !Number.isNaN(inputs.starts_at.getTime()),
    'starts_at is an Invalid Date — the billing period was not read from the subscription item'
  );
  assert.ok(
    !Number.isNaN(inputs.ends_at.getTime()),
    'ends_at is an Invalid Date — the billing period was not read from the subscription item'
  );
  assert.equal(inputs.starts_at.getTime(), PERIOD_START * 1000);
  assert.equal(inputs.ends_at.getTime(), PERIOD_END * 1000);
});

test('checkout.session.completed without metadata no-ops, but leaves a trace naming the session', async () => {
  const { response, sql, apiCalls, logs } = await deliver({
    id: 'evt_checkout_bare',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_no_metadata', object: 'checkout.session', subscription: null, metadata: {} } },
  });

  assert.equal(response.status, 200, 'Stripe must not be told to retry a permanently unusable event');
  assert.equal(merges(sql).length, 0, 'it wrote something despite having no customer or product');
  assert.deepEqual(apiCalls, [], 'it called Stripe despite having nothing to act on');
  // A silent fall-through would be a failure with nothing behind it.
  assert.match(logs, /missing metadata/i);
  assert.match(logs, /cs_no_metadata/, 'the trace does not identify which session was dropped');
});

// ---------------------------------------------------------------------------
// customer.subscription.updated
// ---------------------------------------------------------------------------

test('customer.subscription.updated re-writes the period for a subscription we already track', async () => {
  const { response, sql } = await deliver(
    {
      id: 'evt_updated',
      object: 'event',
      type: 'customer.subscription.updated',
      data: { object: subscriptionFixture({ status: 'past_due' }) },
    },
    {
      recordsetFor: (text) =>
        /SELECT customer_id, product_id FROM xero\.customer_products/i.test(text)
          ? [{ customer_id: CUSTOMER_ID, product_id: PRODUCT_ID }]
          : [],
    }
  );

  assert.equal(response.status, 200);

  const written = merges(sql);
  assert.equal(written.length, 1, 'a tracked subscription update wrote nothing');
  assert.equal(written[0].inputs.status, 'past_due');
  assert.ok(
    !Number.isNaN(written[0].inputs.starts_at.getTime()),
    'starts_at is an Invalid Date on the update arm too'
  );
});

test('customer.subscription.updated for an untracked subscription no-ops with a trace', async () => {
  const { response, sql, logs } = await deliver(
    {
      id: 'evt_updated_unknown',
      object: 'event',
      type: 'customer.subscription.updated',
      data: { object: subscriptionFixture() },
    },
    { recordsetFor: () => [] } // neither the subscription nor its price is known
  );

  assert.equal(response.status, 200);
  assert.equal(merges(sql).length, 0);
  assert.match(logs, /not found in customer_products/i);
  assert.match(logs, new RegExp(SUBSCRIPTION_ID), 'the trace does not name the subscription');
});

// ---------------------------------------------------------------------------
// customer.subscription.deleted
// ---------------------------------------------------------------------------

test('customer.subscription.deleted ends the subscription we track', async () => {
  const endedAt = 1786000000;
  const { response, sql } = await deliver(
    {
      id: 'evt_deleted',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: subscriptionFixture({ status: 'canceled', ended_at: endedAt }) },
    },
    {
      recordsetFor: (text) =>
        /SELECT customer_id, product_id FROM xero\.customer_products/i.test(text)
          ? [{ customer_id: CUSTOMER_ID, product_id: PRODUCT_ID }]
          : [],
    }
  );

  assert.equal(response.status, 200);

  const written = merges(sql);
  assert.equal(written.length, 1);
  assert.equal(written[0].inputs.status, 'ended');
  assert.equal(written[0].inputs.starts_at, null, 'the end path must not overwrite starts_at');
  assert.equal(written[0].inputs.ends_at.getTime(), endedAt * 1000);
});

test('customer.subscription.deleted for an untracked subscription no-ops with a trace', async () => {
  const { response, sql, logs } = await deliver(
    {
      id: 'evt_deleted_unknown',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: subscriptionFixture({ ended_at: 1786000000 }) },
    },
    { recordsetFor: () => [] }
  );

  assert.equal(response.status, 200);
  assert.equal(merges(sql).length, 0);
  assert.match(logs, /not found for deletion/i);
  assert.match(logs, new RegExp(SUBSCRIPTION_ID));
});

// ---------------------------------------------------------------------------

test('an event type outside enabled_events is acknowledged and does nothing', async () => {
  const { response, sql, apiCalls } = await deliver({
    id: 'evt_other',
    object: 'event',
    type: 'invoice.payment_succeeded',
    data: { object: { id: 'in_harness' } },
  });

  assert.equal(response.status, 200);
  assert.equal(sql.length, 0);
  assert.deepEqual(apiCalls, []);
});
