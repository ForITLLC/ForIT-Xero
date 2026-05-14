# Portal Xero Auth — Fix Plan

**Date:** 2026-05-14
**Severity:** P1 — portal Xero connect flow is dead for all users
**Owner:** forit-Xero (this repo); forit-Website is downstream collateral damage

## Symptom (reproduced 2026-05-14 03:36 UTC)

```bash
curl -i https://xero.forit.io/api/tokens -H 'x-api-key: anything'
# HTTP/2 500
# {"error":"Invalid object name 'customers'."}
```

Every portal action that calls `xero.forit.io` to look up an API key (`init_xero_connect`, `tokens`, `connector/*`) returns the same error. End user impact: the page at <https://www.forit.io/portal/xero-connector> shows
`Portal API returned 503: { "error": "Service unavailable", "message": "Invalid object name 'customers'." }` and there is no way to reauth Xero from the portal.

## Failing code path

`connector/src/services/database.ts:96` (and `:104`, `:127`, `:142`):
```ts
.query('SELECT * FROM customers WHERE email = @email');
```

Bare reference, no schema prefix. Connection config (`:55-65`):
```ts
server   = SAAS_DB_SERVER || 'forit-saas-sql.database.windows.net'
database = SAAS_DB_NAME   || 'forit'
user     = SAAS_DB_USER   || 'xero_svc'
password = Key Vault: FORIT-SAAS-DB-PASSWORD
```

## Root cause (PROVEN via direct DB inspection 2026-05-14)

Connected to `forit` DB as `foritadmin`. Findings:

1. **`dbo.customers` does not exist.** Nothing named `customers` in `dbo`. No view either (`dbo` has zero views).
2. **The customers table is `quoting.Customers`** — different schema, capitalised, **and the columns don't match the connector's queries:**
   - Connector expects: `id`, `email`, `stripe_customer_id`, `company_name`, `first_name`, `last_name`
   - Actual `quoting.Customers`: `id`, `tenant_id`, `company_id`, `first_name`, `last_name`, `email`, `phone`, `created_at`, `lifecycle_stage`, `notes`, `last_activity_at`
   - Missing: `stripe_customer_id`, `company_name`. Different columns: `tenant_id`/`company_id` instead.
3. **The api_keys table is `support.api_keys`** with a completely different identity model:
   - Connector expects: `id`, `customer_id`, `key_hash`, `key_prefix`, `name`
   - Actual `support.api_keys`: `key_id`, `user_id` (uniqueidentifier), `name`, `key_hash`, `key_prefix`, `scopes`, `created_at`, `last_used_at`, `revoked_at`
   - The FK points to a *user* (Entra ID), not a *customer*. Different domain model.
4. **`products` is `store.products`.** Schema mismatch.
5. **`xero_connections` is `xero.xero_connections`** — the schema rename `xero → finance` (commit `eb94b01`) never moved this table. `finance.xero_connections` does NOT exist; `xero.xero_connections` still does.
6. **`xero_svc` SQL user does not exist** in the `forit` DB. The principal listing shows `crm_svc, dolores, finance_app, forms_app, hr_app, issuelog_svc, proposals_app, quote_bot_svc, support_app, website_app, forit-planner-sync` — no `xero_svc`. So commit `126d416` changed the *code default* but the user was never provisioned.
7. **Old `forit-saas-db` database is gone.** `sys.databases` on the server: `cayres, forit, great-north, master, sign`. No fallback DB.

### What this means

The connector's data-access layer is **fundamentally out of sync** with the consolidated DB. The three migration commits in this repo (`9b70876`, `eb94b01`, `126d416`) changed surface config — connection strings, user defaults, schema name in one module — but did **not** update queries to match the consolidated DB's actual schema layout (`quoting.Customers`, `support.api_keys`, `store.products`, `xero.xero_connections`) nor the new column/identity model.

Worse, the new data model in `forit` is **not equivalent** to the old `forit-saas-db.dbo.customers`/`dbo.api_keys`. `support.api_keys` is keyed on Entra user_id (uniqueidentifier), not customer_id (int). The connector's "customer → api_keys → xero_connections" chain doesn't map to "user → api_keys + ???.xero_connections" without semantic loss.

The portal currently can't reauth Xero, and the in-session MCP `xero` tool's auth path through this connector is silently dead too.

## Fix options (revised after DB inspection)

The original options (A: GRANT, B: revert user, C: roll back consolidation) were based on the assumption that the tables exist at `dbo.*` and only permissions or DB choice were wrong. That assumption is **false**. Real options below.

### Option 1 — Compatibility views in `dbo` + new `xero_svc` user (LOWEST CHANGE)

Create `dbo.customers`, `dbo.api_keys`, `dbo.products`, `dbo.xero_connections` as **views** mapping the connector's expected shape onto the actual schemas. Missing columns get `NULL` literals.

```sql
CREATE OR ALTER VIEW dbo.customers AS
SELECT id, email, first_name, last_name,
       CAST(NULL AS nvarchar(255)) AS stripe_customer_id,
       CAST(NULL AS nvarchar(255)) AS company_name
FROM quoting.Customers;

-- support.api_keys uses user_id (uniqueidentifier) not customer_id (int).
-- The join keys don't line up — a view here would lie.
-- This is the fundamental mismatch we cannot paper over.
```

**Pros:** Minimal code change; deploy resumes working as soon as views land.
**Cons:** The `api_keys` and `customers` are joined on `customer_id` (int). `support.api_keys.user_id` is a uniqueidentifier. **No SQL view can bridge that join.** So this option works for `products` and possibly read-only `customers`, but **NOT for the api_keys lookup that's actually 500ing**.
**Verdict:** Doesn't actually fix the failing endpoint. Reject.

### Option 2 — Rewrite connector auth to use `support.api_keys` directly (RECOMMENDED — right architecture)

The consolidated DB already has an api_keys system (`support.api_keys` → Entra user_id). The forit-Website portal already issues these. Switch the connector to validate `x-api-key` against `support.api_keys` and identify the caller as a *user*, not a *customer*. Drop the local `customers/api_keys/products` tables from this connector's worldview entirely.

Concrete changes:
1. New `connector/src/services/auth.ts` that does:
   ```sql
   SELECT user_id, scopes, revoked_at FROM support.api_keys
   WHERE key_hash = @hash AND revoked_at IS NULL
   ```
2. Replace all `customers`/`api_keys` references in `connector/src/services/database.ts` and `connector/src/functions/subscriptions.ts` with the new auth service.
3. The `xero_connections` table stays where it is (`xero.xero_connections`); update queries to use full schema name (or rename to `finance.xero_connections` to match the design-intent rename and update queries).
4. Create the `xero_svc` SQL user with grants:
   ```sql
   CREATE USER xero_svc FROM LOGIN xero_svc;  -- assumes login exists at server level
   GRANT SELECT ON support.api_keys TO xero_svc;
   GRANT SELECT, INSERT, UPDATE, DELETE ON xero.xero_connections TO xero_svc;
   ```
5. Check in as `connector/sql/005-create-xero_svc.sql` and `006-grant-xero_svc.sql`. Idempotent.
6. Rebuild + redeploy connector.

**Pros:** Right architecture. Aligned with how the consolidated platform issues api_keys. Removes a redundant identity store. Least-privilege preserved.
**Cons:** Real code change (1-2 hours). Need to confirm whether existing portal-issued api_keys for Xero use `support.api_keys` already (likely yes since the portal owns that table).
**Open question for Ben:** does the portal's "ForIT-Xero Connector" product issue keys into `support.api_keys`? If yes → straight rewrite. If no → also need to migrate existing keys.

### Option 3 — Restore the old `forit-saas-db` as a separate DB

Recreate `forit-saas-db` with the old schema (`dbo.customers`, `dbo.api_keys`, etc.), point this connector back at it via env var override on the Azure Function. Roll back commits `9b70876`/`126d416` semantically without reverting them.

**Pros:** Fast restore-to-last-known-good for this connector. Doesn't touch the rest of the consolidated platform.
**Cons:** Heavy — recreate a DB with seed data. Splits identity (portal users vs. connector customers). Reintroduces the architectural drift the consolidation just removed. Future-Ben's problem.
**Verdict:** Use only if Option 2 is blocked or too slow.

### Option 4 — Short-circuit auth (EMERGENCY ONLY)

Make `xero.forit.io` trust the portal's `PORTAL_API_KEY` env var (shared secret). Skip DB lookup entirely. Portal proxies always work; direct MCP api_keys break.

**Pros:** 10-line patch. Gets the portal page green in 10 minutes.
**Cons:** Breaks every non-portal caller (in-session MCP, third-party PA flows). Hides the architectural drift.
**Verdict:** Don't ship this. Or ship it ONLY as a rollback-in-15-minutes hotfix while Option 2 is built.

## Recommendation: Option 2

It's the only option that produces a connector aligned with the consolidated platform. Estimated 1-2h of code change + a small SQL migration script + deploy + verify.

## Open questions — must answer before execution

1. **Does the portal's "Xero connector" product already issue api_keys into `support.api_keys`?** If yes, Option 2 is straight. If no, need a migration step. *I can verify this by querying `support.api_keys.scopes` for any Xero-related scope. Will do as Step 1 if you green-light.*
2. **Should `xero.xero_connections` get renamed to `finance.xero_connections`** as commit `eb94b01` intended, or is that a separate piece of work? Probably separate.
3. **Is the existing user_id model (Entra ID) the right scope for Xero connections, or do you need multi-tenancy?** The `support.api_keys.user_id` is per-Entra-user. The old `customers.id` was a SaaS-customer concept. If the SAME Entra user has Xero connections for multiple customer orgs, we need additional scoping. (For ForIT-internal use, one user → one Xero org is fine.)

## Validation criteria (all 3 must pass before I close this out)

1. `curl -i https://xero.forit.io/api/tokens -H 'x-api-key: garbage'` returns HTTP 401 with `{"error":"Invalid portal API key"}` (NOT 500 with "Invalid object name").
2. With a real portal API key in `x-api-key`: HTTP 200 with token JSON.
3. `POST https://www.forit.io/api/portal {action:init_xero_connect}` (past the Easy Auth login) returns a Xero authorize URL, not a 503.

## Honesty note (updated)

DB inspection complete. Root cause is **proven, not hypothesized:** schema/identity-model mismatch between connector code and consolidated DB, plus the `xero_svc` user was never created. The original "GRANT permissions" plan would not have worked — there's nothing to grant *on* because `dbo.customers` doesn't exist.

What I still don't know (and would verify as Step 1 of Option 2):
- Whether the portal's "Xero connector" product issues api_keys into `support.api_keys` (likely yes, but unverified)
- What the deployed Azure Function's actual `SAAS_DB_USER` env var is (the code default `xero_svc` doesn't exist; the function must be using `foritadmin` via env override since it gets SQL responses at all)

These don't block writing Option 2's code, but they do block deploy verification.
