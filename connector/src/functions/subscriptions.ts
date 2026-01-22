import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import Stripe from 'stripe';
import sql from 'mssql';
import { getSecret, SECRETS } from '../services/keyvault';
import { validateApiKey } from '../services/database';

// Lazy-initialized Stripe client
let stripeClient: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripeClient) {
    const secretKey = await getSecret(SECRETS.STRIPE_SECRET_KEY);
    stripeClient = new Stripe(secretKey);
  }
  return stripeClient;
}

// Database connection for subscription queries
let dbPool: sql.ConnectionPool | null = null;

async function getDbPool(): Promise<sql.ConnectionPool> {
  if (dbPool) return dbPool;

  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');

  const credential = new DefaultAzureCredential();
  const client = new SecretClient('https://forit-saas-kv.vault.azure.net', credential);
  const secret = await client.getSecret('SAAS-SQL-PASSWORD');
  const password = secret.value || '';

  dbPool = await sql.connect({
    server: process.env.SAAS_DB_SERVER || 'forit-saas-sql.database.windows.net',
    database: 'forit-saas-db',
    user: process.env.SAAS_DB_USER || 'foritadmin',
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  });

  return dbPool;
}

/**
 * Get product by slug including stripe_price_id
 */
interface ProductWithStripe {
  id: string;
  name: string;
  slug: string;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
}

async function getProductBySlugWithStripe(slug: string): Promise<ProductWithStripe | null> {
  const db = await getDbPool();
  const result = await db.request()
    .input('slug', sql.NVarChar, slug)
    .query('SELECT id, name, slug, stripe_price_id, stripe_product_id FROM products WHERE slug = @slug AND is_active = 1');
  return result.recordset[0] || null;
}

/**
 * Get or create Stripe customer for a customer
 */
async function getOrCreateStripeCustomer(customerId: string): Promise<string> {
  const db = await getDbPool();
  const stripe = await getStripe();

  // Check if customer already has a Stripe ID
  const customerResult = await db.request()
    .input('id', sql.UniqueIdentifier, customerId)
    .query('SELECT id, email, stripe_customer_id, company_name, first_name, last_name FROM customers WHERE id = @id');

  const customer = customerResult.recordset[0];
  if (!customer) {
    throw new Error('Customer not found');
  }

  if (customer.stripe_customer_id) {
    return customer.stripe_customer_id;
  }

  // Create new Stripe customer
  const stripeCustomer = await stripe.customers.create({
    email: customer.email,
    name: customer.company_name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || undefined,
    metadata: {
      forit_customer_id: customerId,
    },
  });

  // Save Stripe customer ID
  await db.request()
    .input('id', sql.UniqueIdentifier, customerId)
    .input('stripe_customer_id', sql.NVarChar, stripeCustomer.id)
    .query('UPDATE customers SET stripe_customer_id = @stripe_customer_id, updated_at = GETUTCDATE() WHERE id = @id');

  return stripeCustomer.id;
}

/**
 * Update customer_products with subscription info
 */
async function updateCustomerProductSubscription(
  customerId: string,
  productId: string,
  stripeSubscriptionId: string,
  status: string,
  startsAt: Date | null,
  endsAt: Date | null
): Promise<void> {
  const db = await getDbPool();

  // Upsert customer_products record
  await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('product_id', sql.UniqueIdentifier, productId)
    .input('stripe_subscription_id', sql.NVarChar, stripeSubscriptionId)
    .input('status', sql.NVarChar, status)
    .input('starts_at', sql.DateTime2, startsAt)
    .input('ends_at', sql.DateTime2, endsAt)
    .query(`
      MERGE customer_products AS target
      USING (SELECT @customer_id as customer_id, @product_id as product_id) AS source
      ON target.customer_id = source.customer_id AND target.product_id = source.product_id
      WHEN MATCHED THEN
        UPDATE SET
          stripe_subscription_id = @stripe_subscription_id,
          status = @status,
          starts_at = @starts_at,
          ends_at = @ends_at,
          updated_at = GETUTCDATE()
      WHEN NOT MATCHED THEN
        INSERT (customer_id, product_id, stripe_subscription_id, status, starts_at, ends_at)
        VALUES (@customer_id, @product_id, @stripe_subscription_id, @status, @starts_at, @ends_at);
    `);
}

/**
 * Get customer_product by Stripe subscription ID
 */
async function getCustomerProductBySubscription(stripeSubscriptionId: string): Promise<{ customer_id: string; product_id: string } | null> {
  const db = await getDbPool();
  const result = await db.request()
    .input('stripe_subscription_id', sql.NVarChar, stripeSubscriptionId)
    .query('SELECT customer_id, product_id FROM customer_products WHERE stripe_subscription_id = @stripe_subscription_id');
  return result.recordset[0] || null;
}

/**
 * Get product ID by Stripe price ID
 */
async function getProductByStripePrice(stripePriceId: string): Promise<string | null> {
  const db = await getDbPool();
  const result = await db.request()
    .input('stripe_price_id', sql.NVarChar, stripePriceId)
    .query('SELECT id FROM products WHERE stripe_price_id = @stripe_price_id');
  return result.recordset[0]?.id || null;
}

/**
 * Extract period dates from a Stripe subscription
 */
function getSubscriptionPeriod(subscription: Stripe.Subscription): { startsAt: Date; endsAt: Date } {
  // Access the subscription properties - they exist on the object even if TypeScript types are incomplete
  const sub = subscription as unknown as {
    current_period_start: number;
    current_period_end: number;
  };
  return {
    startsAt: new Date(sub.current_period_start * 1000),
    endsAt: new Date(sub.current_period_end * 1000),
  };
}

// ============================================================================
// POST /api/subscriptions/checkout
// Create Stripe checkout session
// ============================================================================

interface CheckoutRequest {
  product_slug: string;
  quantity?: number;
  success_url: string;
  cancel_url: string;
}

async function subscriptionsCheckout(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    // Validate API key and get customer
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return {
        status: 401,
        jsonBody: { error: 'Missing x-api-key header' },
      };
    }

    const customer = await validateApiKey(apiKey);
    if (!customer) {
      return {
        status: 401,
        jsonBody: { error: 'Invalid API key' },
      };
    }

    // Parse request body
    const body = await request.json() as CheckoutRequest;
    const { product_slug, quantity = 1, success_url, cancel_url } = body;

    if (!product_slug || !success_url || !cancel_url) {
      return {
        status: 400,
        jsonBody: { error: 'Missing required fields: product_slug, success_url, cancel_url' },
      };
    }

    // Get product with Stripe price ID
    const product = await getProductBySlugWithStripe(product_slug);
    if (!product) {
      return {
        status: 404,
        jsonBody: { error: 'Product not found' },
      };
    }

    if (!product.stripe_price_id) {
      return {
        status: 400,
        jsonBody: { error: 'Product does not have a Stripe price configured' },
      };
    }

    // Get or create Stripe customer
    const stripeCustomerId = await getOrCreateStripeCustomer(customer.id);

    // Create Stripe checkout session
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: product.stripe_price_id,
          quantity,
        },
      ],
      mode: 'subscription',
      success_url,
      cancel_url,
      metadata: {
        forit_customer_id: customer.id,
        forit_product_id: product.id,
        forit_product_slug: product_slug,
      },
    });

    context.log('Checkout session created', {
      customerId: customer.id,
      productSlug: product_slug,
      sessionId: session.id,
    });

    return {
      status: 200,
      jsonBody: { checkout_url: session.url },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Checkout failed', error);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

// ============================================================================
// POST /api/subscriptions/webhook
// Handle Stripe webhooks
// ============================================================================

async function subscriptionsWebhook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const stripe = await getStripe();
    const webhookSecret = await getSecret(SECRETS.STRIPE_WEBHOOK_SECRET);

    // Get the raw body and signature
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return {
        status: 400,
        jsonBody: { error: 'Missing stripe-signature header' },
      };
    }

    // Verify webhook signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      context.error('Webhook signature verification failed', err);
      return {
        status: 400,
        jsonBody: { error: `Webhook signature verification failed: ${message}` },
      };
    }

    context.log('Webhook received', { type: event.type, id: event.id });

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session, context);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription, context);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription, context);
        break;
      }

      default:
        context.log('Unhandled event type', { type: event.type });
    }

    return {
      status: 200,
      jsonBody: { received: true },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Webhook processing failed', error);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

/**
 * Handle checkout.session.completed event
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session, context: InvocationContext): Promise<void> {
  const customerId = session.metadata?.forit_customer_id;
  const productId = session.metadata?.forit_product_id;
  const subscriptionId = session.subscription as string;

  if (!customerId || !productId || !subscriptionId) {
    context.warn('Checkout session missing metadata', { sessionId: session.id });
    return;
  }

  // Get subscription details
  const stripe = await getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const { startsAt, endsAt } = getSubscriptionPeriod(subscription);

  // Map Stripe status to our status
  const status = mapStripeStatus(subscription.status);

  await updateCustomerProductSubscription(
    customerId,
    productId,
    subscriptionId,
    status,
    startsAt,
    endsAt
  );

  context.log('Subscription created from checkout', {
    customerId,
    productId,
    subscriptionId,
    status,
  });
}

/**
 * Handle customer.subscription.updated event
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription, context: InvocationContext): Promise<void> {
  const customerProduct = await getCustomerProductBySubscription(subscription.id);

  if (!customerProduct) {
    // Try to find by metadata or price
    const priceId = subscription.items.data[0]?.price.id;
    if (priceId) {
      const productId = await getProductByStripePrice(priceId);
      const stripeCustomer = subscription.customer as string;

      // Get ForIT customer ID from Stripe customer
      const stripe = await getStripe();
      const customer = await stripe.customers.retrieve(stripeCustomer);
      const foritCustomerId = (customer as Stripe.Customer).metadata?.forit_customer_id;

      if (productId && foritCustomerId) {
        const { startsAt, endsAt } = getSubscriptionPeriod(subscription);
        const status = mapStripeStatus(subscription.status);

        await updateCustomerProductSubscription(
          foritCustomerId,
          productId,
          subscription.id,
          status,
          startsAt,
          endsAt
        );

        context.log('Subscription updated (new tracking)', {
          customerId: foritCustomerId,
          productId,
          subscriptionId: subscription.id,
          status,
        });
        return;
      }
    }

    context.warn('Subscription not found in customer_products', { subscriptionId: subscription.id });
    return;
  }

  const { startsAt, endsAt } = getSubscriptionPeriod(subscription);
  const status = mapStripeStatus(subscription.status);

  await updateCustomerProductSubscription(
    customerProduct.customer_id,
    customerProduct.product_id,
    subscription.id,
    status,
    startsAt,
    endsAt
  );

  context.log('Subscription updated', {
    customerId: customerProduct.customer_id,
    productId: customerProduct.product_id,
    subscriptionId: subscription.id,
    status,
  });
}

/**
 * Handle customer.subscription.deleted event
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription, context: InvocationContext): Promise<void> {
  const customerProduct = await getCustomerProductBySubscription(subscription.id);

  if (!customerProduct) {
    context.warn('Subscription not found for deletion', { subscriptionId: subscription.id });
    return;
  }

  const sub = subscription as unknown as { ended_at?: number };
  const endsAt = sub.ended_at ? new Date(sub.ended_at * 1000) : new Date();

  await updateCustomerProductSubscription(
    customerProduct.customer_id,
    customerProduct.product_id,
    subscription.id,
    'ended',
    null, // Keep starts_at as is
    endsAt
  );

  context.log('Subscription ended', {
    customerId: customerProduct.customer_id,
    productId: customerProduct.product_id,
    subscriptionId: subscription.id,
  });
}

/**
 * Map Stripe subscription status to our status
 */
function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): string {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trial';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
      return 'ended';
    case 'incomplete':
    case 'incomplete_expired':
      return 'pending';
    case 'paused':
      return 'paused';
    default:
      return 'unknown';
  }
}

// ============================================================================
// POST /api/subscriptions/portal
// Get Stripe customer portal URL
// ============================================================================

interface PortalRequest {
  return_url?: string;
}

async function subscriptionsPortal(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    // Validate API key and get customer
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return {
        status: 401,
        jsonBody: { error: 'Missing x-api-key header' },
      };
    }

    const customer = await validateApiKey(apiKey);
    if (!customer) {
      return {
        status: 401,
        jsonBody: { error: 'Invalid API key' },
      };
    }

    // Parse optional return URL
    let returnUrl = 'https://forit.io/portal';
    try {
      const body = await request.json() as PortalRequest;
      if (body.return_url) {
        returnUrl = body.return_url;
      }
    } catch {
      // Body is optional, use default return URL
    }

    // Get or create Stripe customer
    const stripeCustomerId = await getOrCreateStripeCustomer(customer.id);

    // Create billing portal session
    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });

    context.log('Portal session created', {
      customerId: customer.id,
      stripeCustomerId,
    });

    return {
      status: 200,
      jsonBody: { portal_url: session.url },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Portal session failed', error);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

// ============================================================================
// Register endpoints
// ============================================================================

app.http('SubscriptionsCheckout', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'subscriptions/checkout',
  handler: subscriptionsCheckout,
});

app.http('SubscriptionsWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'subscriptions/webhook',
  handler: subscriptionsWebhook,
});

app.http('SubscriptionsPortal', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'subscriptions/portal',
  handler: subscriptionsPortal,
});
