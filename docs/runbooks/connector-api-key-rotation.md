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

A 403 means the key is valid but the customer lacks an active `xero-connector`
product grant; a 404 means no Xero connection row. Neither is a key problem.

## Issuing a key

`POST /api/keys/new` is **disabled** (410 Gone — `mcpAuth.ts:128`); public signup moved to
the portal. So there are two sanctioned paths:

1. **Portal (preferred, human):** https://forit.io/portal — issues against the signed-in customer.
2. **Direct insert (automation/break-glass):** use the same shape as
   `createApiKey()` (`database.ts:208`) so the row matches what the validator expects:

   - `key = 'fmcp_' + base64url(randomBytes(32))`  → 48 chars total
   - `key_prefix = key.substring(0, 12)`
   - `key_hash = sha256(key)` (hex)
   - `INSERT INTO xero.api_keys (customer_id, key_hash, key_prefix, name) VALUES (...)`

   Legacy 37-char `fmcp_` keys predate the current generator. Length is not validated —
   only the hash is — but mint new keys at the current 48-char shape.

   The customer must also hold an active/trial `xero-connector` grant in
   `xero.customer_products`, or every call returns 403 (`checkProductAccess`, `database.ts:385`).

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
