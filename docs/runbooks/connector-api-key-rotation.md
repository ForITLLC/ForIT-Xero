# Runbook — Connector API key issuance & rotation

**Scope:** the `x-api-key` credential that machine callers (the ForIT MCP gateway,
Power Automate, scripts) present to `https://xero.forit.io/api/connector/*`.

## Where the accepted key actually lives — read this first

There is **no app setting and no Key Vault secret that the connector compares against**
for `/api/connector/*`. Every ARM-side hunt for "the connector's API key" is a dead end,
and that dead end is what turned WO#1821 into an outage investigation.

`connector/src/functions/connector.ts` → `authenticateRequest()` → `validateApiKey()`
(`connector/src/services/database.ts:226`) does exactly this:

```
sha256(presented key)  ->  SELECT ... FROM xero.api_keys ak
                           JOIN xero.customers c ON c.id = ak.customer_id
                           WHERE ak.key_hash = @hash AND ak.is_active = 1
```

So the **authority is the `xero.api_keys` table** in `forit-saas-sql.database.windows.net` /
database `forit`. Only the *hash* is stored; the plaintext exists exactly once, at issuance.
Losing it means minting a new one — it cannot be recovered.

Do not confuse these three, all of which have been mistaken for "the connector key":

| Secret | Vault | What it actually guards |
|---|---|---|
| `PORTAL-API-KEY` | `forit-xero-mcp-kv` | `/api/connect/*` only (portal→connector). Compared as a string in `connect.ts:50`. **Not** `/api/connector/*`. |
| `MCP-API-KEY` | `forit-xero-mcp-kv` | Legacy. Not referenced by any live code path. |
| `XERO-CONNECTOR-PORTAL-KEY` | `forit-saas-kv` | Legacy `fmcp_` key, no longer an active row. Dead. |

## Reading the 401 — the two bodies mean opposite things

`/api/connector/*` returns 401 for three distinct reasons. **Always read the body before acting:**

| Body | Meaning | Fix |
|---|---|---|
| `{"error":"Missing API key"}` | Caller sent no `x-api-key` header at all | Wire the caller's secret. **Do not rotate anything.** |
| `{"error":"Invalid API key"}` | Header sent; no active row matches the hash | Mint a new key (below) |
| `{"error":"Xero connection expired"}` | Key is fine; the *Xero* refresh token is dead | Re-consent at https://forit.io/portal. **A new API key fixes nothing.** |

A 404 means no Xero connection row — not a key problem. A **403 now has two
causes**, and the body tells them apart:

| Body | Meaning | Fix |
|---|---|---|
| `{"error":"No active subscription"}` | Key is valid; the customer has no active `xero-connector` grant | Grant the product in `xero.customer_products` |
| `{"error":"Read-only API key"}` | Key is valid and entitled, but scoped `read` and the caller attempted a write | Working as intended. Do **not** widen the key to silence it — see below. |

## Issuing a key

`POST /api/keys/new` is **disabled** (410 Gone — `mcpAuth.ts:128`); public signup moved to
the portal. So there are two sanctioned paths:

1. **Portal (preferred, human):** https://forit.io/portal — issues against the signed-in customer.
2. **Direct insert (automation/break-glass):** use the same shape as
   `createApiKey()` (`database.ts:208`) so the row matches what the validator expects:

   - `key = 'fmcp_' + base64url(randomBytes(32))`  → 48 chars total
   - `key_prefix = key.substring(0, 12)`
   - `key_hash = sha256(key)` (hex)
   - `INSERT INTO xero.api_keys (customer_id, key_hash, key_prefix, name, scope) VALUES (...)`
     — omit `scope` and the column defaults to `'full'`. Pass `'read'` deliberately.

   Legacy 37-char `fmcp_` keys predate the current generator. Length is not validated —
   only the hash is — but mint new keys at the current 48-char shape.

   The customer must also hold an active/trial `xero-connector` grant in
   `xero.customer_products`, or every call returns 403 (`checkProductAccess`, `database.ts:385`).

## Key scope — `full` vs `read` (WO#1821B)

`xero.api_keys.scope` (added by `connector/sql/007-add-api-key-scope.sql`) decides what a
key may do. Two values, CHECK-constrained:

| Scope | What it can do |
|---|---|
| `full` (default) | Everything the connector exposes. What every key issued before WO#1821B has. |
| `read` | `GET` only, on every route — **and no Xero tokens at all** (see below). |

**Where it is enforced.** `authenticateRequest()` (`connector.ts`) refuses a `read` key on
any non-`GET`, before the subscription check, the connection lookup and the token refresh —
so a refused request touches no Xero state. The check is on the HTTP method in the one place
every route funnels through, *not* a per-route allow-list. That is deliberate: the catch-all
`connector/{*path}` proxies whatever method it is handed straight to Xero, so a list that
named the six write routes and missed the catch-all would enforce nothing, and a route added
next month would be unprotected by default.

**`GET /api/tokens` is refused for a `read` key regardless of method.** It is a GET, so a
pure method gate would wave it through — but what it returns is a Xero *access and refresh
token*, a full write credential the holder can use against Xero directly, outside this
connector and outside every gate in it. Handing one to a read-only key makes the scope
cosmetic. `mcpAuth.ts` blocks it separately for exactly that reason.

**Anything that is not exactly `read` resolves to `full`.** A missing, null or misspelled
scope keeps today's access rather than silently losing it mid-request, and `validateApiKey`
probes for the column with `COL_LENGTH` so the code is safe against a database that has not
run `sql/007` yet. The CHECK constraint is what stops a typo becoming a quiet privilege
grant on a newly issued key — do not drop it.

**Choosing a scope at issuance.** Default to `read` for any consumer that only needs to
look at Xero data; that is most of them. Issue `full` only when the consumer has a named,
approved write it must perform. Widening an existing key is a decision, not a fix: if a
`read` key starts returning `{"error":"Read-only API key"}`, find out what write the caller
started attempting before changing the row.

Pinned by `connector/test/apiKeyScope.test.js`, which asserts (among other things) that the
rejection happens *before* any upstream fetch.

**Current production state (2026-09-03).** The gate is deployed (commit `25e4f65`), but
`sql/007` has **not been applied** to `forit-saas-db` yet — that write is gated on Ben's
approval. Until it runs, `COL_LENGTH` reports the column absent, every key resolves to
`full`, and the gate is inert. Nothing is protected by scope in production until the
migration lands and a key is issued with `scope = 'read'`. Applying it is the first step
of turning this on; it is safe to run at any time and changes no existing key's access.

## Handing a key to a consumer — the rule

**The plaintext key is written to Key Vault once, at issuance, and never travels any other way.**
Not in a chat message, a commit, a log line, a tmux pane, an ARM app setting, or a work-order report.
The consuming service references it **by secret name**:

- Naming convention (matches `finance-api-key-for-mcp`, `sms-api-key-for-mcp`):
  **`xero-api-key-for-mcp`** in `forit-saas-kv`.
- The MCP gateway (Azure Container Apps) binds it as a `secretRef` → env var.
  A plain-text app setting or a baked-in env value is a defect, not a shortcut.
- The handoff to the consuming session is **the secret name only**.

## Rotation

1. Mint the new key (above) as a **second active row** for the same customer.
2. Write the plaintext to the consumer's Key Vault secret (new version).
3. Restart / re-resolve the consumer so it picks up the new version.
4. Verify: `GET /api/connector/Organisation` returns 200 for the consumer.
5. Only then set the old row `is_active = 0`. Keep the row — `last_used_at` is the
   audit trail that proves nothing else was still using it.

Overlap before revoke. Revoking first is what produces a silent outage that nobody
notices until an unrelated health probe is added weeks later.

## Monitoring — why this outage went unseen for 26 days

`/api/connector/Organisation` last returned 200 on **2026-08-06 16:40:45Z** and 401'd on
every request afterwards. Nothing detected it until the gateway's upstream-health probe
(WO#1816) started calling that path on **2026-09-01 23:52Z**. The probe did not break
anything — it was the first thing that ever looked.

Per-caller success is the signal that matters; total request volume is not, because the
Power Automate lane stayed green throughout and kept the aggregate healthy.

Useful query (App Insights `forit-xero-mcp`, appId `3b48298d-5557-42c6-a226-3e9ea82d2e96`):

```kusto
requests
| where timestamp > ago(30d)
| where url contains "/api/connector"
| extend p = tostring(split(url, "/api/connector/")[1])
| summarize n = count(), lastSeen = max(timestamp) by p, resultCode
| order by lastSeen desc
```
