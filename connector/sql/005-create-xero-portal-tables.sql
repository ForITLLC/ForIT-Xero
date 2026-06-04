-- 005-create-xero-portal-tables.sql
-- Creates the connector's expected tables under the `xero` schema in the
-- consolidated `forit` database. Restores portal Xero auth after the
-- 9b70876/eb94b01/126d416 consolidation left these tables un-migrated.
--
-- Idempotent. Safe to re-run.
-- Apply against: forit-saas-sql.database.windows.net / forit

IF SCHEMA_ID('xero') IS NULL EXEC('CREATE SCHEMA xero');
GO

-- customers --------------------------------------------------------------
IF OBJECT_ID('xero.customers', 'U') IS NULL
BEGIN
    CREATE TABLE xero.customers (
        id                    UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_customers_id DEFAULT NEWID(),
        email                 NVARCHAR(255)    NOT NULL,
        first_name            NVARCHAR(255)    NULL,
        last_name             NVARCHAR(255)    NULL,
        company_name          NVARCHAR(255)    NULL,
        stripe_customer_id    NVARCHAR(255)    NULL,
        subscription_status   NVARCHAR(50)     NOT NULL CONSTRAINT DF_xero_customers_substatus DEFAULT 'active',
        subscription_ends_at  DATETIME2        NULL,
        created_at            DATETIME2        NOT NULL CONSTRAINT DF_xero_customers_created DEFAULT SYSUTCDATETIME(),
        updated_at            DATETIME2        NOT NULL CONSTRAINT DF_xero_customers_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_customers PRIMARY KEY (id),
        CONSTRAINT UQ_xero_customers_email UNIQUE (email)
    );
END
GO

-- api_keys ---------------------------------------------------------------
IF OBJECT_ID('xero.api_keys', 'U') IS NULL
BEGIN
    CREATE TABLE xero.api_keys (
        id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_api_keys_id DEFAULT NEWID(),
        customer_id  UNIQUEIDENTIFIER NOT NULL,
        key_hash     NVARCHAR(128)    NOT NULL,
        key_prefix   NVARCHAR(32)     NOT NULL,
        name         NVARCHAR(255)    NOT NULL,
        is_active    BIT              NOT NULL CONSTRAINT DF_xero_api_keys_active DEFAULT 1,
        created_at   DATETIME2        NOT NULL CONSTRAINT DF_xero_api_keys_created DEFAULT SYSUTCDATETIME(),
        last_used_at DATETIME2        NULL,
        CONSTRAINT PK_xero_api_keys PRIMARY KEY (id),
        CONSTRAINT UQ_xero_api_keys_hash UNIQUE (key_hash),
        CONSTRAINT FK_xero_api_keys_customer FOREIGN KEY (customer_id)
            REFERENCES xero.customers (id) ON DELETE CASCADE
    );
END
GO

-- products ---------------------------------------------------------------
IF OBJECT_ID('xero.products', 'U') IS NULL
BEGIN
    CREATE TABLE xero.products (
        id                 UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_products_id DEFAULT NEWID(),
        name               NVARCHAR(255)    NOT NULL,
        slug               NVARCHAR(128)    NOT NULL,
        description        NVARCHAR(MAX)    NULL,
        status             NVARCHAR(32)     NOT NULL CONSTRAINT DF_xero_products_status DEFAULT 'active',
        is_active          BIT              NOT NULL CONSTRAINT DF_xero_products_active DEFAULT 1,
        stripe_price_id    NVARCHAR(255)    NULL,
        stripe_product_id  NVARCHAR(255)    NULL,
        created_at         DATETIME2        NOT NULL CONSTRAINT DF_xero_products_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_products PRIMARY KEY (id),
        CONSTRAINT UQ_xero_products_slug UNIQUE (slug)
    );
END
GO

-- customer_products ------------------------------------------------------
IF OBJECT_ID('xero.customer_products', 'U') IS NULL
BEGIN
    CREATE TABLE xero.customer_products (
        id                      UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_cp_id DEFAULT NEWID(),
        customer_id             UNIQUEIDENTIFIER NOT NULL,
        product_id              UNIQUEIDENTIFIER NOT NULL,
        status                  NVARCHAR(32)     NOT NULL CONSTRAINT DF_xero_cp_status DEFAULT 'trial',
        stripe_subscription_id  NVARCHAR(255)    NULL,
        starts_at               DATETIME2        NULL,
        ends_at                 DATETIME2        NULL,
        created_at              DATETIME2        NOT NULL CONSTRAINT DF_xero_cp_created DEFAULT SYSUTCDATETIME(),
        updated_at              DATETIME2        NOT NULL CONSTRAINT DF_xero_cp_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_customer_products PRIMARY KEY (id),
        CONSTRAINT UQ_xero_cp UNIQUE (customer_id, product_id),
        CONSTRAINT FK_xero_cp_customer FOREIGN KEY (customer_id)
            REFERENCES xero.customers (id) ON DELETE CASCADE,
        CONSTRAINT FK_xero_cp_product  FOREIGN KEY (product_id)
            REFERENCES xero.products (id)
    );
END
GO

-- product_interest -------------------------------------------------------
IF OBJECT_ID('xero.product_interest', 'U') IS NULL
BEGIN
    CREATE TABLE xero.product_interest (
        id         UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_pi_id DEFAULT NEWID(),
        product_id UNIQUEIDENTIFIER NOT NULL,
        email      NVARCHAR(255)    NOT NULL,
        name       NVARCHAR(255)    NULL,
        company    NVARCHAR(255)    NULL,
        created_at DATETIME2        NOT NULL CONSTRAINT DF_xero_pi_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_product_interest PRIMARY KEY (id),
        CONSTRAINT UQ_xero_pi UNIQUE (product_id, email)
    );
END
GO

-- product_pages ----------------------------------------------------------
IF OBJECT_ID('xero.product_pages', 'U') IS NULL
BEGIN
    CREATE TABLE xero.product_pages (
        id                UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_pp_id DEFAULT NEWID(),
        product_id        UNIQUEIDENTIFIER NULL,
        slug              NVARCHAR(128)    NOT NULL,
        title             NVARCHAR(255)    NOT NULL,
        subtitle          NVARCHAR(500)    NULL,
        description       NVARCHAR(MAX)    NULL,
        content_html      NVARCHAR(MAX)    NULL,
        cover_image       NVARCHAR(500)    NULL,
        features          NVARCHAR(MAX)    NULL,
        price_display     NVARCHAR(255)    NULL,
        cta_text          NVARCHAR(255)    NOT NULL CONSTRAINT DF_xero_pp_cta DEFAULT 'Get Started',
        cta_url           NVARCHAR(500)    NULL,
        cta_type          NVARCHAR(32)     NOT NULL CONSTRAINT DF_xero_pp_ctype DEFAULT 'portal',
        meta_title        NVARCHAR(255)    NULL,
        meta_description  NVARCHAR(500)    NULL,
        published         BIT              NOT NULL CONSTRAINT DF_xero_pp_pub DEFAULT 0,
        sort_order        INT              NOT NULL CONSTRAINT DF_xero_pp_sort DEFAULT 0,
        portal_components NVARCHAR(MAX)    NULL,
        CONSTRAINT PK_xero_product_pages PRIMARY KEY (id),
        CONSTRAINT UQ_xero_pp_slug UNIQUE (slug)
    );
END
GO

-- swag_products ----------------------------------------------------------
IF OBJECT_ID('xero.swag_products', 'U') IS NULL
BEGIN
    CREATE TABLE xero.swag_products (
        id                       UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_sp_id DEFAULT NEWID(),
        slug                     NVARCHAR(128)    NOT NULL,
        name                     NVARCHAR(255)    NOT NULL,
        description              NVARCHAR(MAX)    NULL,
        printful_product_id      BIGINT           NULL,
        printful_blueprint_id    BIGINT           NULL,
        cover_image              NVARCHAR(500)    NULL,
        images                   NVARCHAR(MAX)    NULL,
        base_price_cents         INT              NOT NULL CONSTRAINT DF_xero_sp_price DEFAULT 0,
        currency                 NVARCHAR(8)      NOT NULL CONSTRAINT DF_xero_sp_curr DEFAULT 'USD',
        published                BIT              NOT NULL CONSTRAINT DF_xero_sp_pub DEFAULT 0,
        featured                 BIT              NOT NULL CONSTRAINT DF_xero_sp_feat DEFAULT 0,
        sort_order               INT              NOT NULL CONSTRAINT DF_xero_sp_sort DEFAULT 0,
        category                 NVARCHAR(128)    NULL,
        tags                     NVARCHAR(MAX)    NULL,
        created_at               DATETIME2        NOT NULL CONSTRAINT DF_xero_sp_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_swag_products PRIMARY KEY (id),
        CONSTRAINT UQ_xero_sp_slug UNIQUE (slug)
    );
END
GO

-- swag_variants ----------------------------------------------------------
IF OBJECT_ID('xero.swag_variants', 'U') IS NULL
BEGIN
    CREATE TABLE xero.swag_variants (
        id                            UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_sv_id DEFAULT NEWID(),
        product_id                    UNIQUEIDENTIFIER NOT NULL,
        sku                           NVARCHAR(128)    NOT NULL,
        name                          NVARCHAR(255)    NOT NULL,
        size                          NVARCHAR(32)     NULL,
        color                         NVARCHAR(64)     NULL,
        color_hex                     NVARCHAR(16)     NULL,
        printful_variant_id           BIGINT           NULL,
        printful_catalog_variant_id   BIGINT           NULL,
        price_cents                   INT              NULL,
        in_stock                      BIT              NOT NULL CONSTRAINT DF_xero_sv_stock DEFAULT 1,
        is_active                     BIT              NOT NULL CONSTRAINT DF_xero_sv_active DEFAULT 1,
        sort_order                    INT              NOT NULL CONSTRAINT DF_xero_sv_sort DEFAULT 0,
        CONSTRAINT PK_xero_swag_variants PRIMARY KEY (id),
        CONSTRAINT UQ_xero_sv_sku UNIQUE (sku),
        CONSTRAINT FK_xero_sv_product FOREIGN KEY (product_id)
            REFERENCES xero.swag_products (id) ON DELETE CASCADE
    );
END
GO

-- swag_orders ------------------------------------------------------------
IF OBJECT_ID('xero.swag_orders', 'U') IS NULL
BEGIN
    CREATE TABLE xero.swag_orders (
        id                          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_so_id DEFAULT NEWID(),
        customer_id                 UNIQUEIDENTIFIER NULL,
        email                       NVARCHAR(255)    NOT NULL,
        ship_name                   NVARCHAR(255)    NOT NULL,
        ship_address1               NVARCHAR(500)    NOT NULL,
        ship_address2               NVARCHAR(500)    NULL,
        ship_city                   NVARCHAR(128)    NOT NULL,
        ship_state                  NVARCHAR(64)     NULL,
        ship_zip                    NVARCHAR(32)     NOT NULL,
        ship_country                NVARCHAR(64)     NOT NULL,
        ship_phone                  NVARCHAR(64)     NULL,
        subtotal_cents              INT              NOT NULL,
        shipping_cents              INT              NOT NULL CONSTRAINT DF_xero_so_ship DEFAULT 0,
        tax_cents                   INT              NOT NULL CONSTRAINT DF_xero_so_tax DEFAULT 0,
        total_cents                 INT              NOT NULL,
        currency                    NVARCHAR(8)      NOT NULL CONSTRAINT DF_xero_so_curr DEFAULT 'USD',
        stripe_checkout_session_id  NVARCHAR(255)    NULL,
        stripe_payment_intent_id    NVARCHAR(255)    NULL,
        printful_order_id           BIGINT           NULL,
        printful_order_status       NVARCHAR(64)     NULL,
        status                      NVARCHAR(32)     NOT NULL CONSTRAINT DF_xero_so_status DEFAULT 'pending',
        tracking_number             NVARCHAR(128)    NULL,
        tracking_url                NVARCHAR(500)    NULL,
        carrier                     NVARCHAR(64)     NULL,
        paid_at                     DATETIME2        NULL,
        shipped_at                  DATETIME2        NULL,
        delivered_at                DATETIME2        NULL,
        created_at                  DATETIME2        NOT NULL CONSTRAINT DF_xero_so_created DEFAULT SYSUTCDATETIME(),
        updated_at                  DATETIME2        NOT NULL CONSTRAINT DF_xero_so_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_xero_swag_orders PRIMARY KEY (id)
    );
END
GO

-- swag_order_items -------------------------------------------------------
IF OBJECT_ID('xero.swag_order_items', 'U') IS NULL
BEGIN
    CREATE TABLE xero.swag_order_items (
        id                       UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_xero_soi_id DEFAULT NEWID(),
        order_id                 UNIQUEIDENTIFIER NOT NULL,
        variant_id               UNIQUEIDENTIFIER NOT NULL,
        product_name             NVARCHAR(255)    NOT NULL,
        variant_name             NVARCHAR(255)    NOT NULL,
        sku                      NVARCHAR(128)    NOT NULL,
        quantity                 INT              NOT NULL,
        unit_price_cents         INT              NOT NULL,
        total_cents              INT              NOT NULL,
        printful_line_item_id    BIGINT           NULL,
        CONSTRAINT PK_xero_swag_order_items PRIMARY KEY (id),
        CONSTRAINT FK_xero_soi_order FOREIGN KEY (order_id)
            REFERENCES xero.swag_orders (id) ON DELETE CASCADE
    );
END
GO

-- Permissions ------------------------------------------------------------
-- Broad grant so whichever DB user the Function App runs as can read/write.
-- TODO: tighten to a dedicated xero_svc user once provisioned (see Option 2
-- in docs/plans/2026-05-14-portal-xero-auth-fix-plan.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::xero TO public;
GO
