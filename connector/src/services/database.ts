import sql from 'mssql';
import crypto from 'crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

// Types
export interface Customer {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  stripe_customer_id?: string;
  subscription_status: string;
  subscription_ends_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ApiKey {
  id: string;
  customer_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  is_active: boolean;
  created_at: Date;
  last_used_at?: Date;
}

export interface XeroConnection {
  id: string;
  customer_id: string;
  tenant_id: string;
  tenant_name?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  created_at: Date;
  updated_at: Date;
}

// Single database pool for all tables (consolidated in forit-saas-db)
let dbPool: sql.ConnectionPool | null = null;

async function getDbPassword(): Promise<string> {
  const credential = new DefaultAzureCredential();
  const client = new SecretClient('https://forit-saas-kv.vault.azure.net', credential);
  const secret = await client.getSecret('SAAS-SQL-PASSWORD');
  return secret.value || '';
}

// Unified pool for forit-saas-db (all tables: customers, api_keys, products, xero_connections, etc.)
async function getDbPool(): Promise<sql.ConnectionPool> {
  if (dbPool) return dbPool;

  const password = await getDbPassword();

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

// Aliases for backwards compatibility
const getSaasPool = getDbPool;

// Customer functions (use saasPool - forit-saas-db)
export async function createCustomer(email: string, companyName?: string, firstName?: string, lastName?: string): Promise<Customer> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('email', sql.NVarChar, email)
    .input('company_name', sql.NVarChar, companyName || null)
    .input('first_name', sql.NVarChar, firstName || null)
    .input('last_name', sql.NVarChar, lastName || null)
    .query(`
      INSERT INTO customers (email, company_name, first_name, last_name)
      OUTPUT INSERTED.*
      VALUES (@email, @company_name, @first_name, @last_name)
    `);
  return result.recordset[0];
}

export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('email', sql.NVarChar, email)
    .query('SELECT * FROM customers WHERE email = @email');
  return result.recordset[0] || null;
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('id', sql.UniqueIdentifier, id)
    .query('SELECT * FROM customers WHERE id = @id');
  return result.recordset[0] || null;
}

// API Key functions (use saasPool - forit-saas-db)
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const keyBytes = crypto.randomBytes(32);
  const key = `fmcp_${keyBytes.toString('base64url')}`;
  const prefix = key.substring(0, 12);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, prefix, hash };
}

export async function createApiKey(customerId: string, name = 'Default'): Promise<{ apiKey: ApiKey; plainKey: string }> {
  const { key, prefix, hash } = generateApiKey();

  const db = await getSaasPool();
  const result = await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('key_hash', sql.NVarChar, hash)
    .input('key_prefix', sql.NVarChar, prefix)
    .input('name', sql.NVarChar, name)
    .query(`
      INSERT INTO api_keys (customer_id, key_hash, key_prefix, name)
      OUTPUT INSERTED.*
      VALUES (@customer_id, @key_hash, @key_prefix, @name)
    `);

  return { apiKey: result.recordset[0], plainKey: key };
}

export async function validateApiKey(key: string): Promise<Customer | null> {
  const hash = crypto.createHash('sha256').update(key).digest('hex');

  const db = await getSaasPool();
  const result = await db.request()
    .input('key_hash', sql.NVarChar, hash)
    .query(`
      SELECT c.* FROM customers c
      JOIN api_keys ak ON c.id = ak.customer_id
      WHERE ak.key_hash = @key_hash AND ak.is_active = 1
    `);

  if (result.recordset[0]) {
    // Update last_used_at
    await db.request()
      .input('key_hash', sql.NVarChar, hash)
      .query('UPDATE api_keys SET last_used_at = GETUTCDATE() WHERE key_hash = @key_hash');
  }

  return result.recordset[0] || null;
}

// Xero Connection functions (use xeroPool - forit-xero-db)
export async function saveXeroConnection(
  customerId: string,
  tenantId: string,
  tenantName: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number
): Promise<XeroConnection> {
  const db = await getDbPool();

  // Upsert - update if exists, insert if not
  const result = await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('tenant_id', sql.NVarChar, tenantId)
    .input('tenant_name', sql.NVarChar, tenantName)
    .input('access_token', sql.NVarChar(sql.MAX), accessToken)
    .input('refresh_token', sql.NVarChar(sql.MAX), refreshToken)
    .input('expires_at', sql.BigInt, expiresAt)
    .query(`
      MERGE xero_connections AS target
      USING (SELECT @customer_id as customer_id, @tenant_id as tenant_id) AS source
      ON target.customer_id = source.customer_id AND target.tenant_id = source.tenant_id
      WHEN MATCHED THEN
        UPDATE SET
          tenant_name = @tenant_name,
          access_token = @access_token,
          refresh_token = @refresh_token,
          expires_at = @expires_at,
          updated_at = GETUTCDATE()
      WHEN NOT MATCHED THEN
        INSERT (customer_id, tenant_id, tenant_name, access_token, refresh_token, expires_at)
        VALUES (@customer_id, @tenant_id, @tenant_name, @access_token, @refresh_token, @expires_at)
      OUTPUT INSERTED.*;
    `);

  return result.recordset[0];
}

export async function getXeroConnection(customerId: string): Promise<XeroConnection | null> {
  const db = await getDbPool();
  const result = await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .query('SELECT * FROM xero_connections WHERE customer_id = @customer_id');
  return result.recordset[0] || null;
}

export async function updateXeroTokens(
  customerId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number
): Promise<void> {
  const db = await getDbPool();
  await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('access_token', sql.NVarChar(sql.MAX), accessToken)
    .input('refresh_token', sql.NVarChar(sql.MAX), refreshToken)
    .input('expires_at', sql.BigInt, expiresAt)
    .query(`
      UPDATE xero_connections
      SET access_token = @access_token,
          refresh_token = @refresh_token,
          expires_at = @expires_at,
          updated_at = GETUTCDATE()
      WHERE customer_id = @customer_id
    `);
}

// Customer-Product functions (use saasPool - forit-saas-db)
export async function grantProductAccess(customerId: string, productSlug: string): Promise<void> {
  const db = await getSaasPool();
  await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('product_slug', sql.NVarChar, productSlug)
    .query(`
      INSERT INTO customer_products (customer_id, product_id, status)
      SELECT @customer_id, p.id, 'trial'
      FROM products p WHERE p.slug = @product_slug
      AND NOT EXISTS (
        SELECT 1 FROM customer_products cp
        WHERE cp.customer_id = @customer_id AND cp.product_id = p.id
      )
    `);
}

export async function checkProductAccess(customerId: string, productSlug: string): Promise<boolean> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .input('product_slug', sql.NVarChar, productSlug)
    .query(`
      SELECT 1 FROM customer_products cp
      JOIN products p ON cp.product_id = p.id
      WHERE cp.customer_id = @customer_id
        AND p.slug = @product_slug
        AND cp.status IN ('trial', 'active')
    `);
  return result.recordset.length > 0;
}

export async function hasAnyProductAccess(customerId: string): Promise<boolean> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('customer_id', sql.UniqueIdentifier, customerId)
    .query(`
      SELECT 1 FROM customer_products cp
      JOIN products p ON cp.product_id = p.id
      WHERE cp.customer_id = @customer_id
        AND cp.status IN ('trial', 'active')
        AND p.status = 'active'
    `);
  return result.recordset.length > 0;
}

// Product listing
export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: 'active' | 'coming_soon' | 'deprecated';
  is_active: boolean;
}

export async function getActiveProducts(): Promise<Product[]> {
  const db = await getSaasPool();
  const result = await db.request().query(`
    SELECT id, name, slug, description, status, is_active
    FROM products
    WHERE is_active = 1
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name
  `);
  return result.recordset;
}

export async function getProductBySlug(slug: string): Promise<Product | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('slug', sql.NVarChar, slug)
    .query('SELECT * FROM products WHERE slug = @slug');
  return result.recordset[0] || null;
}

// Interest registration for coming_soon products
export async function registerProductInterest(
  productId: string,
  email: string,
  name?: string,
  company?: string
): Promise<void> {
  const db = await getSaasPool();
  await db.request()
    .input('product_id', sql.UniqueIdentifier, productId)
    .input('email', sql.NVarChar, email)
    .input('name', sql.NVarChar, name || null)
    .input('company', sql.NVarChar, company || null)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM product_interest WHERE product_id = @product_id AND email = @email)
      INSERT INTO product_interest (product_id, email, name, company)
      VALUES (@product_id, @email, @name, @company)
    `);
}

// Product Pages (dynamic content from DB)
export interface ProductPage {
  id: string;
  product_id: string | null;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  content_html: string | null;
  cover_image: string | null;
  features: string[] | null;
  price_display: string | null;
  cta_text: string;
  cta_url: string | null;
  cta_type: 'portal' | 'stripe' | 'contact' | 'external';
  meta_title: string | null;
  meta_description: string | null;
  published: boolean;
  sort_order: number;
}

export async function getPublishedProductPages(): Promise<ProductPage[]> {
  const db = await getSaasPool();
  const result = await db.request().query(`
    SELECT * FROM product_pages
    WHERE published = 1
    ORDER BY sort_order, title
  `);
  return result.recordset.map(parseProductPage);
}

export async function getProductPageBySlug(slug: string): Promise<ProductPage | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('slug', sql.NVarChar, slug)
    .query('SELECT * FROM product_pages WHERE slug = @slug AND published = 1');
  return result.recordset[0] ? parseProductPage(result.recordset[0]) : null;
}

export async function getAllProductPageSlugs(): Promise<string[]> {
  const db = await getSaasPool();
  const result = await db.request().query(`
    SELECT slug FROM product_pages WHERE published = 1
  `);
  return result.recordset.map((r: { slug: string }) => r.slug);
}

// ============================================================================
// SWAG SHOP TYPES AND FUNCTIONS
// ============================================================================

export interface SwagProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  printful_product_id: number | null;
  printful_blueprint_id: number | null;
  cover_image: string | null;
  images: string[] | null;
  base_price_cents: number;
  currency: string;
  published: boolean;
  featured: boolean;
  sort_order: number;
  category: string | null;
  tags: string[] | null;
}

export interface SwagVariant {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  size: string | null;
  color: string | null;
  color_hex: string | null;
  printful_variant_id: number | null;
  printful_catalog_variant_id: number | null;
  price_cents: number | null;
  in_stock: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface SwagProductWithVariants extends SwagProduct {
  variants: SwagVariant[];
}

export interface SwagOrder {
  id: string;
  customer_id: string | null;
  email: string;
  ship_name: string;
  ship_address1: string;
  ship_address2: string | null;
  ship_city: string;
  ship_state: string | null;
  ship_zip: string;
  ship_country: string;
  ship_phone: string | null;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  printful_order_id: number | null;
  printful_order_status: string | null;
  status: string;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SwagOrderItem {
  id: string;
  order_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  sku: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  printful_line_item_id: number | null;
}

// Get all published swag products
export async function getPublishedSwagProducts(): Promise<SwagProduct[]> {
  const db = await getSaasPool();
  const result = await db.request().query(`
    SELECT * FROM swag_products
    WHERE published = 1
    ORDER BY featured DESC, sort_order, name
  `);
  return result.recordset.map(parseSwagProduct);
}

// Get single swag product by slug with variants
export async function getSwagProductBySlug(slug: string): Promise<SwagProductWithVariants | null> {
  const db = await getSaasPool();

  const productResult = await db.request()
    .input('slug', sql.NVarChar, slug)
    .query('SELECT * FROM swag_products WHERE slug = @slug AND published = 1');

  if (!productResult.recordset[0]) return null;

  const product = parseSwagProduct(productResult.recordset[0]);

  const variantsResult = await db.request()
    .input('product_id', sql.UniqueIdentifier, product.id)
    .query(`
      SELECT * FROM swag_variants
      WHERE product_id = @product_id AND is_active = 1
      ORDER BY sort_order, name
    `);

  return {
    ...product,
    variants: variantsResult.recordset.map(parseSwagVariant),
  };
}

// Get variant by SKU
export async function getSwagVariantBySku(sku: string): Promise<SwagVariant | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('sku', sql.NVarChar, sku)
    .query('SELECT * FROM swag_variants WHERE sku = @sku AND is_active = 1');
  return result.recordset[0] ? parseSwagVariant(result.recordset[0]) : null;
}

// Get swag product by ID
export async function getSwagProductById(id: string): Promise<SwagProduct | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('id', sql.UniqueIdentifier, id)
    .query('SELECT * FROM swag_products WHERE id = @id');
  return result.recordset[0] ? parseSwagProduct(result.recordset[0]) : null;
}

// Create a new swag order
export interface CreateSwagOrderInput {
  customer_id?: string;
  email: string;
  ship_name: string;
  ship_address1: string;
  ship_address2?: string;
  ship_city: string;
  ship_state?: string;
  ship_zip: string;
  ship_country: string;
  ship_phone?: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  stripe_checkout_session_id?: string;
  items: { variant_id: string; quantity: number; unit_price_cents: number }[];
}

export async function createSwagOrder(input: CreateSwagOrderInput): Promise<SwagOrder> {
  const db = await getSaasPool();

  // Create the order
  const orderResult = await db.request()
    .input('customer_id', sql.UniqueIdentifier, input.customer_id || null)
    .input('email', sql.NVarChar, input.email)
    .input('ship_name', sql.NVarChar, input.ship_name)
    .input('ship_address1', sql.NVarChar, input.ship_address1)
    .input('ship_address2', sql.NVarChar, input.ship_address2 || null)
    .input('ship_city', sql.NVarChar, input.ship_city)
    .input('ship_state', sql.NVarChar, input.ship_state || null)
    .input('ship_zip', sql.NVarChar, input.ship_zip)
    .input('ship_country', sql.NVarChar, input.ship_country)
    .input('ship_phone', sql.NVarChar, input.ship_phone || null)
    .input('subtotal_cents', sql.Int, input.subtotal_cents)
    .input('shipping_cents', sql.Int, input.shipping_cents)
    .input('tax_cents', sql.Int, input.tax_cents)
    .input('total_cents', sql.Int, input.total_cents)
    .input('stripe_checkout_session_id', sql.NVarChar, input.stripe_checkout_session_id || null)
    .query(`
      INSERT INTO swag_orders (
        customer_id, email, ship_name, ship_address1, ship_address2,
        ship_city, ship_state, ship_zip, ship_country, ship_phone,
        subtotal_cents, shipping_cents, tax_cents, total_cents,
        stripe_checkout_session_id
      )
      OUTPUT INSERTED.*
      VALUES (
        @customer_id, @email, @ship_name, @ship_address1, @ship_address2,
        @ship_city, @ship_state, @ship_zip, @ship_country, @ship_phone,
        @subtotal_cents, @shipping_cents, @tax_cents, @total_cents,
        @stripe_checkout_session_id
      )
    `);

  const order = orderResult.recordset[0];

  // Add order items
  for (const item of input.items) {
    // Get variant details for snapshot
    const variant = await db.request()
      .input('variant_id', sql.UniqueIdentifier, item.variant_id)
      .query(`
        SELECT v.*, p.name as product_name
        FROM swag_variants v
        JOIN swag_products p ON v.product_id = p.id
        WHERE v.id = @variant_id
      `);

    if (variant.recordset[0]) {
      const v = variant.recordset[0];
      await db.request()
        .input('order_id', sql.UniqueIdentifier, order.id)
        .input('variant_id', sql.UniqueIdentifier, item.variant_id)
        .input('product_name', sql.NVarChar, v.product_name)
        .input('variant_name', sql.NVarChar, v.name)
        .input('sku', sql.NVarChar, v.sku)
        .input('quantity', sql.Int, item.quantity)
        .input('unit_price_cents', sql.Int, item.unit_price_cents)
        .input('total_cents', sql.Int, item.quantity * item.unit_price_cents)
        .query(`
          INSERT INTO swag_order_items (
            order_id, variant_id, product_name, variant_name, sku,
            quantity, unit_price_cents, total_cents
          )
          VALUES (
            @order_id, @variant_id, @product_name, @variant_name, @sku,
            @quantity, @unit_price_cents, @total_cents
          )
        `);
    }
  }

  return order;
}

// Update order after payment
export async function updateSwagOrderPayment(
  orderId: string,
  stripePaymentIntentId: string
): Promise<void> {
  const db = await getSaasPool();
  await db.request()
    .input('id', sql.UniqueIdentifier, orderId)
    .input('stripe_payment_intent_id', sql.NVarChar, stripePaymentIntentId)
    .query(`
      UPDATE swag_orders
      SET stripe_payment_intent_id = @stripe_payment_intent_id,
          status = 'paid',
          paid_at = GETUTCDATE(),
          updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

// Update order with Printful details
export async function updateSwagOrderPrintful(
  orderId: string,
  printfulOrderId: number,
  printfulStatus: string
): Promise<void> {
  const db = await getSaasPool();
  await db.request()
    .input('id', sql.UniqueIdentifier, orderId)
    .input('printful_order_id', sql.BigInt, printfulOrderId)
    .input('printful_order_status', sql.NVarChar, printfulStatus)
    .query(`
      UPDATE swag_orders
      SET printful_order_id = @printful_order_id,
          printful_order_status = @printful_order_status,
          status = 'processing',
          updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

// Update order shipping info
export async function updateSwagOrderShipping(
  orderId: string,
  trackingNumber: string,
  trackingUrl: string,
  carrier: string
): Promise<void> {
  const db = await getSaasPool();
  await db.request()
    .input('id', sql.UniqueIdentifier, orderId)
    .input('tracking_number', sql.NVarChar, trackingNumber)
    .input('tracking_url', sql.NVarChar, trackingUrl)
    .input('carrier', sql.NVarChar, carrier)
    .query(`
      UPDATE swag_orders
      SET tracking_number = @tracking_number,
          tracking_url = @tracking_url,
          carrier = @carrier,
          status = 'shipped',
          shipped_at = GETUTCDATE(),
          updated_at = GETUTCDATE()
      WHERE id = @id
    `);
}

// Get order by ID
export async function getSwagOrderById(orderId: string): Promise<SwagOrder | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('id', sql.UniqueIdentifier, orderId)
    .query('SELECT * FROM swag_orders WHERE id = @id');
  return result.recordset[0] || null;
}

// Get order by Stripe session ID
export async function getSwagOrderByStripeSession(sessionId: string): Promise<SwagOrder | null> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('session_id', sql.NVarChar, sessionId)
    .query('SELECT * FROM swag_orders WHERE stripe_checkout_session_id = @session_id');
  return result.recordset[0] || null;
}

// Get order items
export async function getSwagOrderItems(orderId: string): Promise<SwagOrderItem[]> {
  const db = await getSaasPool();
  const result = await db.request()
    .input('order_id', sql.UniqueIdentifier, orderId)
    .query('SELECT * FROM swag_order_items WHERE order_id = @order_id');
  return result.recordset;
}

// Helper parsers
function parseSwagProduct(row: Record<string, unknown>): SwagProduct {
  let images: string[] | null = null;
  let tags: string[] | null = null;

  if (row.images) {
    try { images = JSON.parse(row.images as string); } catch { images = null; }
  }
  if (row.tags) {
    try { tags = JSON.parse(row.tags as string); } catch { tags = null; }
  }

  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: row.description as string | null,
    printful_product_id: row.printful_product_id as number | null,
    printful_blueprint_id: row.printful_blueprint_id as number | null,
    cover_image: row.cover_image as string | null,
    images,
    base_price_cents: row.base_price_cents as number,
    currency: (row.currency as string) || 'USD',
    published: row.published === true || row.published === 1,
    featured: row.featured === true || row.featured === 1,
    sort_order: (row.sort_order as number) || 0,
    category: row.category as string | null,
    tags,
  };
}

function parseSwagVariant(row: Record<string, unknown>): SwagVariant {
  return {
    id: row.id as string,
    product_id: row.product_id as string,
    sku: row.sku as string,
    name: row.name as string,
    size: row.size as string | null,
    color: row.color as string | null,
    color_hex: row.color_hex as string | null,
    printful_variant_id: row.printful_variant_id as number | null,
    printful_catalog_variant_id: row.printful_catalog_variant_id as number | null,
    price_cents: row.price_cents as number | null,
    in_stock: row.in_stock === true || row.in_stock === 1,
    is_active: row.is_active === true || row.is_active === 1,
    sort_order: (row.sort_order as number) || 0,
  };
}

function parseProductPage(row: Record<string, unknown>): ProductPage {
  let features: string[] | null = null;
  if (row.features) {
    try {
      features = JSON.parse(row.features as string);
    } catch {
      features = null;
    }
  }
  return {
    id: row.id as string,
    product_id: row.product_id as string | null,
    slug: row.slug as string,
    title: row.title as string,
    subtitle: row.subtitle as string | null,
    description: row.description as string | null,
    content_html: row.content_html as string | null,
    cover_image: row.cover_image as string | null,
    features,
    price_display: row.price_display as string | null,
    cta_text: (row.cta_text as string) || 'Get Started',
    cta_url: row.cta_url as string | null,
    cta_type: (row.cta_type as ProductPage['cta_type']) || 'portal',
    meta_title: row.meta_title as string | null,
    meta_description: row.meta_description as string | null,
    published: row.published === true || row.published === 1,
    sort_order: (row.sort_order as number) || 0,
  };
}
