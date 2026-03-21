-- Fix api_keys.id column missing DEFAULT NEWID() after database migration
-- The DEFAULT was stripped during consolidation to the forit database.
-- Without it, INSERT INTO api_keys (...) fails because id is a uniqueidentifier
-- with no default and the application code doesn't explicitly provide one.
--
-- Applied manually on 2026-03-20 against forit-saas-sql.database.windows.net / forit

ALTER TABLE dbo.api_keys ADD DEFAULT NEWID() FOR id;
