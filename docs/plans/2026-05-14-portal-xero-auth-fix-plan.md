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

## Root-cause chain (with commit evidence)

| Commit | Change | Risk introduced |
|---|---|---|
| `9b70876` Mar 18 | DB migration: `forit-saas-db` → `forit` consolidated DB | If `customers/api_keys/products/xero_connections` weren't moved, every lookup 500s |
| `eb94b01` Mar 19 | Renamed `xero` schema → `finance` | Only touches interest-side tables. Customers prob still in `dbo`. Probably orthogonal. |
| `126d416` Mar 21 | `foritadmin` → `xero_svc` (least-privilege account) | If `xero_svc` lacks SELECT on `dbo.customers`, Azure SQL returns "Invalid object name" verbatim — same error as a missing table, due to [metadata visibility behavior](https://learn.microsoft.com/sql/relational-databases/security/metadata-visibility-configuration). |

**Primary hypothesis:** commit `126d416` created `xero_svc` but the GRANT statements either (a) weren't run on the consolidated `forit` DB or (b) were scoped only to the `finance` schema, not `dbo.customers`/`dbo.api_keys`/`dbo.products`/`dbo.xero_connections`.

**Secondary hypothesis:** commit `9b70876` migrated the database default but the actual tables in `forit` are under a non-default schema (e.g. `saas.customers`) and the bare `FROM customers` no longer resolves for `xero_svc`'s default schema.

Both produce identical error text. Distinguishing them requires DB access.

## Fix options

### Option A — Restore permissions on `xero_svc`, keep least-privilege design (RECOMMENDED)

1. Connect to `forit-saas-sql.database.windows.net` / DB `forit` as admin.
2. Run, idempotent:
   ```sql
   GRANT SELECT, INSERT, UPDATE ON dbo.customers       TO xero_svc;
   GRANT SELECT, INSERT, UPDATE ON dbo.api_keys        TO xero_svc;
   GRANT SELECT                  ON dbo.products       TO xero_svc;
   GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.xero_connections TO xero_svc;
   GRANT SELECT, INSERT, UPDATE  ON dbo.customer_products TO xero_svc;
   ```
3. Commit the GRANT script to `connector/sql/005-grant-xero_svc.sql` so it's checked in, repeatable, and not lost when somebody recreates the DB.
4. Re-curl `https://xero.forit.io/api/tokens` — expect 401 (invalid key), not 500 (broken query). 401 = the lookup succeeded and rejected an unknown key.

**Pros:** Preserves the security improvement from commit `126d416`. Minimal code change. Idempotent migration script lives in source.
**Cons:** Requires (a) confirming the tables actually exist in `dbo.*` of the `forit` DB, (b) admin access to grant.

### Option B — Revert commit `126d416` (xero_svc → foritadmin)

1. `git revert 126d416 --no-edit`
2. Redeploy.
3. Done; portal works again.

**Pros:** Fastest. Known-working baseline.
**Cons:** Throws away the least-privilege improvement. The shared `foritadmin` account being everywhere is the exact thing that commit was fixing. Comes back to bite when someone audits the SaaS DB credentials.
**Not recommended unless A is blocked.**

### Option C — Move the connector off the consolidated `forit` DB entirely

Roll back DB consolidation (commit `9b70876`) for the connector module, keeping `forit-saas-db` as before.

**Pros:** Goes back to the last known-good architecture.
**Cons:** Throws away the consolidation. Loses the gain. The migration was intentional. Not the fight to pick here.
**Not recommended.**

## Decision: Option A. Question for Ben below.

## Open question — single gate

**Can I (or do you want to) run `GRANT SELECT, INSERT, UPDATE ON dbo.customers TO xero_svc;` (and the 4 sister statements) against the live `forit` DB?**

Options:
- **A1 — I run it.** I need: (a) the `foritadmin` (or other SQL admin) password from 1Password, or (b) a confirmed AAD-admin path from this Mac via `mm_run` (the last `az` call I tried timed out at 300s). If I can sqlcmd in as admin, I can run the GRANT statements and verify in one round.
- **A2 — You run it.** I write `connector/sql/005-grant-xero_svc.sql`, commit it, push it. You run it via Azure Data Studio / SSMS / portal query editor. I then re-curl `xero.forit.io/api/tokens` for verification.
- **A3 — Skip permissions — turn out the table is genuinely missing.** Then I need a one-off `INSERT INTO forit..customers SELECT * FROM forit-saas-db..customers` migration first. Same gate: admin access to run it.

## Validation criteria (all 3 must pass before I close this out)

1. `curl -i https://xero.forit.io/api/tokens -H 'x-api-key: garbage'` returns HTTP 401 with `{"error":"Invalid portal API key"}` (NOT 500 with "Invalid object name").
2. With a real portal API key in `x-api-key`: HTTP 200 with token JSON.
3. `POST https://www.forit.io/api/portal {action:init_xero_connect}` (past the Easy Auth login) returns a Xero authorize URL, not a 503.

## Honesty note

I have not (yet) verified:
- Whether `customers` actually exists in the `forit` DB
- What schema it lives under
- What permissions `xero_svc` currently has

I have **strong direction** (the error text, the commit sequence, the timing) but not **proof**. Phase 4 of the systematic-debugging skill says: prove with a failing test before fixing. The failing test here is the curl above; the proof I'm missing is the DB inspection. **That's why Option A1/A2 starts with a SQL query, not a GRANT.**
