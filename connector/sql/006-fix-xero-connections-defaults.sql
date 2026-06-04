-- 006-fix-xero-connections-defaults.sql
-- The `xero.xero_connections` table predates the 005 migration and was
-- created without a DEFAULT for `id`, no PRIMARY KEY, and no indexes.
-- That causes saveXeroConnection() in connector/src/services/database.ts
-- to fail with "Cannot insert the value NULL into column 'id'" on every
-- OAuth callback, so no row is ever written and users land on the error
-- redirect path with "callback_failed".
--
-- This script:
--   1. Adds DEFAULT NEWID() to id
--   2. Adds PRIMARY KEY on id
--   3. Adds UNIQUE (customer_id, tenant_id) — the MERGE upsert key
--   4. Adds DEFAULTs for created_at / updated_at (also missing)
--
-- Idempotent. Safe to re-run.
-- Apply against: forit-saas-sql.database.windows.net / forit

-- 1. Default for id ------------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE name = 'DF_xero_connections_id'
)
ALTER TABLE xero.xero_connections
    ADD CONSTRAINT DF_xero_connections_id DEFAULT NEWID() FOR id;
GO

-- 2. Primary key on id ---------------------------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.key_constraints
    WHERE parent_object_id = OBJECT_ID('xero.xero_connections')
      AND type = 'PK'
)
ALTER TABLE xero.xero_connections
    ADD CONSTRAINT PK_xero_connections PRIMARY KEY (id);
GO

-- 3. Unique upsert key (customer_id, tenant_id) --------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('xero.xero_connections')
      AND name = 'UQ_xero_connections_customer_tenant'
)
CREATE UNIQUE INDEX UQ_xero_connections_customer_tenant
    ON xero.xero_connections (customer_id, tenant_id);
GO

-- 4. Defaults for created_at / updated_at --------------------------------
IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE name = 'DF_xero_connections_created'
)
ALTER TABLE xero.xero_connections
    ADD CONSTRAINT DF_xero_connections_created DEFAULT SYSUTCDATETIME() FOR created_at;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints
    WHERE name = 'DF_xero_connections_updated'
)
ALTER TABLE xero.xero_connections
    ADD CONSTRAINT DF_xero_connections_updated DEFAULT SYSUTCDATETIME() FOR updated_at;
GO
