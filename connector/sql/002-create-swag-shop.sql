-- ForIT Swag Shop Schema
-- Integrates with Printful for print-on-demand fulfillment
-- Uses Stripe for payment processing

-- ============================================================================
-- SWAG PRODUCTS - Main product catalog
-- ============================================================================
CREATE TABLE swag_products (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

  -- Basic Info
  slug NVARCHAR(100) UNIQUE NOT NULL,
  name NVARCHAR(200) NOT NULL,
  description NVARCHAR(MAX) NULL,

  -- Printful Integration
  printful_product_id BIGINT NULL,           -- Printful's sync product ID
  printful_blueprint_id INT NULL,            -- Printful catalog product (e.g., "Unisex Staple T-Shirt")

  -- Display
  cover_image NVARCHAR(500) NULL,            -- Primary product image
  images NVARCHAR(MAX) NULL,                 -- JSON array of additional images

  -- Pricing (base price, variants may differ)
  base_price_cents INT NOT NULL DEFAULT 0,   -- Base price in cents
  currency NVARCHAR(3) DEFAULT 'USD',

  -- Status
  published BIT DEFAULT 0,
  featured BIT DEFAULT 0,
  sort_order INT DEFAULT 0,

  -- Metadata
  category NVARCHAR(50) NULL,                -- 'apparel', 'drinkware', 'accessories'
  tags NVARCHAR(MAX) NULL,                   -- JSON array of tags

  created_at DATETIME2 DEFAULT GETUTCDATE(),
  updated_at DATETIME2 DEFAULT GETUTCDATE()
);

CREATE INDEX idx_swag_products_slug ON swag_products(slug);
CREATE INDEX idx_swag_products_published ON swag_products(published, sort_order);

-- ============================================================================
-- SWAG VARIANTS - Size/color combinations
-- ============================================================================
CREATE TABLE swag_variants (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  product_id UNIQUEIDENTIFIER NOT NULL REFERENCES swag_products(id) ON DELETE CASCADE,

  -- Variant Info
  sku NVARCHAR(50) NOT NULL,                 -- Our internal SKU
  name NVARCHAR(200) NOT NULL,               -- e.g., "Navy / Large"

  -- Options
  size NVARCHAR(20) NULL,                    -- S, M, L, XL, 2XL, etc.
  color NVARCHAR(50) NULL,                   -- Color name
  color_hex NVARCHAR(7) NULL,                -- Hex code for display

  -- Printful Integration
  printful_variant_id BIGINT NULL,           -- Printful's sync variant ID
  printful_catalog_variant_id INT NULL,      -- Printful's catalog variant ID

  -- Pricing (overrides base if set)
  price_cents INT NULL,                      -- NULL = use product base_price

  -- Inventory (Printful handles actual inventory, this is for display)
  in_stock BIT DEFAULT 1,

  -- Status
  is_active BIT DEFAULT 1,
  sort_order INT DEFAULT 0,

  created_at DATETIME2 DEFAULT GETUTCDATE(),
  updated_at DATETIME2 DEFAULT GETUTCDATE(),

  CONSTRAINT uq_swag_variant_sku UNIQUE (sku)
);

CREATE INDEX idx_swag_variants_product ON swag_variants(product_id);
CREATE INDEX idx_swag_variants_sku ON swag_variants(sku);

-- ============================================================================
-- SWAG ORDERS - Customer orders
-- ============================================================================
CREATE TABLE swag_orders (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),

  -- Customer Info (can be guest checkout)
  customer_id UNIQUEIDENTIFIER NULL REFERENCES customers(id),
  email NVARCHAR(255) NOT NULL,

  -- Shipping Address
  ship_name NVARCHAR(200) NOT NULL,
  ship_address1 NVARCHAR(200) NOT NULL,
  ship_address2 NVARCHAR(200) NULL,
  ship_city NVARCHAR(100) NOT NULL,
  ship_state NVARCHAR(100) NULL,
  ship_zip NVARCHAR(20) NOT NULL,
  ship_country NVARCHAR(2) NOT NULL,         -- ISO 2-letter code
  ship_phone NVARCHAR(30) NULL,

  -- Order Totals
  subtotal_cents INT NOT NULL,
  shipping_cents INT NOT NULL DEFAULT 0,
  tax_cents INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL,
  currency NVARCHAR(3) DEFAULT 'USD',

  -- Stripe Integration
  stripe_checkout_session_id NVARCHAR(255) NULL,
  stripe_payment_intent_id NVARCHAR(255) NULL,

  -- Printful Integration
  printful_order_id BIGINT NULL,
  printful_order_status NVARCHAR(50) NULL,   -- 'draft', 'pending', 'fulfilled', 'canceled'

  -- Status
  status NVARCHAR(50) DEFAULT 'pending',     -- 'pending', 'paid', 'processing', 'shipped', 'delivered', 'canceled', 'refunded'

  -- Tracking
  tracking_number NVARCHAR(100) NULL,
  tracking_url NVARCHAR(500) NULL,
  carrier NVARCHAR(50) NULL,

  -- Timestamps
  paid_at DATETIME2 NULL,
  shipped_at DATETIME2 NULL,
  delivered_at DATETIME2 NULL,
  created_at DATETIME2 DEFAULT GETUTCDATE(),
  updated_at DATETIME2 DEFAULT GETUTCDATE()
);

CREATE INDEX idx_swag_orders_customer ON swag_orders(customer_id);
CREATE INDEX idx_swag_orders_email ON swag_orders(email);
CREATE INDEX idx_swag_orders_stripe ON swag_orders(stripe_checkout_session_id);
CREATE INDEX idx_swag_orders_printful ON swag_orders(printful_order_id);
CREATE INDEX idx_swag_orders_status ON swag_orders(status);

-- ============================================================================
-- SWAG ORDER ITEMS - Individual items in an order
-- ============================================================================
CREATE TABLE swag_order_items (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  order_id UNIQUEIDENTIFIER NOT NULL REFERENCES swag_orders(id) ON DELETE CASCADE,
  variant_id UNIQUEIDENTIFIER NOT NULL REFERENCES swag_variants(id),

  -- Snapshot at time of order (prices may change)
  product_name NVARCHAR(200) NOT NULL,
  variant_name NVARCHAR(200) NOT NULL,
  sku NVARCHAR(50) NOT NULL,

  quantity INT NOT NULL DEFAULT 1,
  unit_price_cents INT NOT NULL,
  total_cents INT NOT NULL,

  -- Printful line item ID (for tracking)
  printful_line_item_id BIGINT NULL,

  created_at DATETIME2 DEFAULT GETUTCDATE()
);

CREATE INDEX idx_swag_order_items_order ON swag_order_items(order_id);
CREATE INDEX idx_swag_order_items_variant ON swag_order_items(variant_id);

-- ============================================================================
-- SEED DATA - Initial ForIT swag products
-- ============================================================================

-- ForIT Logo T-Shirt
INSERT INTO swag_products (slug, name, description, base_price_cents, category, published, featured, sort_order)
VALUES (
  'forit-logo-tee',
  'ForIT Logo T-Shirt',
  'Premium cotton t-shirt featuring the ForIT logo. Comfortable, durable, and perfect for showing your automation pride.',
  2500,
  'apparel',
  0,  -- Not published until Printful is set up
  1,
  1
);

-- Get the product ID for variants
DECLARE @tshirt_id UNIQUEIDENTIFIER;
SELECT @tshirt_id = id FROM swag_products WHERE slug = 'forit-logo-tee';

-- Add size variants (will link to Printful later)
INSERT INTO swag_variants (product_id, sku, name, size, color, color_hex, sort_order) VALUES
(@tshirt_id, 'FORIT-TEE-NVY-S', 'Navy / Small', 'S', 'Navy', '#1e3a5f', 1),
(@tshirt_id, 'FORIT-TEE-NVY-M', 'Navy / Medium', 'M', 'Navy', '#1e3a5f', 2),
(@tshirt_id, 'FORIT-TEE-NVY-L', 'Navy / Large', 'L', 'Navy', '#1e3a5f', 3),
(@tshirt_id, 'FORIT-TEE-NVY-XL', 'Navy / XL', 'XL', 'Navy', '#1e3a5f', 4),
(@tshirt_id, 'FORIT-TEE-NVY-2XL', 'Navy / 2XL', '2XL', 'Navy', '#1e3a5f', 5);

-- ForIT Mug
INSERT INTO swag_products (slug, name, description, base_price_cents, category, published, sort_order)
VALUES (
  'forit-mug',
  'ForIT Coffee Mug',
  '11oz ceramic mug with ForIT logo. The perfect vessel for your morning coffee while automating workflows.',
  1800,
  'drinkware',
  0,
  2
);

DECLARE @mug_id UNIQUEIDENTIFIER;
SELECT @mug_id = id FROM swag_products WHERE slug = 'forit-mug';

INSERT INTO swag_variants (product_id, sku, name, color, color_hex, sort_order) VALUES
(@mug_id, 'FORIT-MUG-WHT', 'White', 'White', '#FFFFFF', 1),
(@mug_id, 'FORIT-MUG-BLK', 'Black', 'Black', '#000000', 2);

-- ForIT Sticker Pack
INSERT INTO swag_products (slug, name, description, base_price_cents, category, published, sort_order)
VALUES (
  'forit-sticker-pack',
  'ForIT Sticker Pack',
  'Set of 5 die-cut vinyl stickers featuring ForIT branding. Weather-resistant and perfect for laptops, water bottles, and more.',
  800,
  'accessories',
  0,
  3
);

DECLARE @sticker_id UNIQUEIDENTIFIER;
SELECT @sticker_id = id FROM swag_products WHERE slug = 'forit-sticker-pack';

INSERT INTO swag_variants (product_id, sku, name, sort_order) VALUES
(@sticker_id, 'FORIT-STICKER-5PK', 'Standard Pack', 1);

PRINT 'Swag shop schema created successfully';
PRINT 'Next steps:';
PRINT '1. Create Printful account and get API key';
PRINT '2. Create products in Printful with ForIT designs';
PRINT '3. Link Printful product/variant IDs to this database';
PRINT '4. Set published=1 to make products visible';
