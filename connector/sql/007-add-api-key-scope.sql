-- WO#1821B — give xero.api_keys a scope, so "this consumer is read-only" is a
-- property the API enforces instead of a promise made outside the code.
--
-- Applying this changes no behaviour on its own. The column is NOT NULL with
-- DEFAULT 'full', which SQL Server backfills into every existing row, so every
-- key that works today keeps exactly the capability it has today. The gate only
-- engages for a key explicitly issued with scope = 'read'.
--
-- Deploy order does not matter, deliberately. validateApiKey probes for this
-- column with COL_LENGTH and falls back to the literal 'full' when it is
-- absent, so the code is safe to ship before this runs and this is safe to run
-- before the code ships. That matters because the Power Automate lane is the
-- only healthy consumer of this API, and a SELECT of a column that does not
-- exist yet would fail every single auth call and take that lane down.
--
-- Apply via the Apply SQL Migration workflow, which targets
-- forit-saas-sql.database.windows.net / database `forit`. NOT `forit-saas-db`.

IF COL_LENGTH('xero.api_keys', 'scope') IS NULL
BEGIN
    ALTER TABLE xero.api_keys
        ADD scope NVARCHAR(32) NOT NULL
            CONSTRAINT DF_xero_api_keys_scope DEFAULT 'full';
END
GO

-- Constrain to the two values the gate understands. Without this, a typo like
-- 'readonly' reads as "not 'read'" and silently grants FULL access — failing
-- open, which is the wrong direction for a permission column.
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_xero_api_keys_scope')
BEGIN
    ALTER TABLE xero.api_keys
        ADD CONSTRAINT CK_xero_api_keys_scope CHECK (scope IN ('full', 'read'));
END
GO
