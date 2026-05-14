# Master Xero Connector — Architecture & Consolidation Design

**Date:** 2026-05-13
**Status:** Design approved, awaiting implementation prioritisation
**Owner:** forit-Xero
**Related repos:** forit-Finance, forit-Website, forit-CRM, forit-payments, forit-Xero-Connector, forit-Mercury-Connector, forit-dynamics-legacy, personal-dev (fastmcp-gateway)

> **REVISION 2026-05-13 (same day):** The first cut of this doc claimed comprehensiveness and missed at least 6 Xero ingress paths — most importantly the `forit-Website` portal-driven OAuth flow that's the actual reauth entry point, and `forit-CRM`'s 19-file Xero sync surface. Ben caught it; a cross-repo grep audit followed. Current state section + architecture diagram + cleanup actions have been rewritten. The original out-of-scope claim that "forit-Mercury-Connector and forit-dynamics-legacy don't own their own Xero credentials" was UNVERIFIED and has been corrected to a flagged unknown. The supporting self-letter on what went wrong lives at `docs/letters/2026-05-13-xero-audit-failure.md`.

## Problem

Xero integration is spread across multiple repos with different OAuth flows, different Xero app registrations, and overlapping responsibilities. The current state was producing intermittent outages — most recently the `354C59DC...` custom connection in forit-Finance lost its tenant linkage and started returning `[]` from `GET /connections`, blocking all Python-based invoice automation.

The proliferation isn't an accident — it grew organically as different teams hit Xero from different runtimes (Azure Functions, Python scripts, Power Automate). It now needs to be reined in so there is one place that owns the Xero credential, one rate limit, one tenant lookup, and one OAuth refresh loop.

## The pattern

**One external SaaS = one backend connector repo. Downstream consumers call that connector.**

| External SaaS | Connector repo (owner) | Downstream consumers |
|---|---|---|
| **Xero** (accounting system) | `forit-Xero` | forit-Finance, forit-treasury, forit-Mercury-Connector flows, forit-dynamics-legacy flows, anything else that needs to read/write Xero |
| **Mercury + Wise** (treasury/payments rails) | `forit-payments` | forit-treasury, forit-Finance |

Mercury and Wise live together in `forit-payments` not because their APIs are similar (they aren't) but because they serve the same business purpose — moving money from bank accounts. A single business workflow often spans both ("sweep funds from Mercury, send via Wise"), so grouping them simplifies cross-rail logic. Xero doesn't share a business purpose with anything else — it's the system of record everything else writes *to* — so it earns its own boundary.

## Why centralise Xero specifically

1. **Refresh tokens are stateful.** Only one process can safely refresh a Xero OAuth token at a time without race conditions. N consumers each running their own refresh → guaranteed collision.
2. **Tenant lookup belongs in one place.** Every Xero API call needs the `xero-tenant-id` header. One owner of "which tenant is the org connected to" is simpler than N.
3. **Rate limits are per-app.** Xero applies API quotas per app registration. Centralising means one rate limiter; decentralising means N teams quietly stepping on each other.
4. **Webhooks (if added later) only deliver to one endpoint.** Already-centralised receivers are easier to add than to retrofit.
5. **System of record.** Invoice IDs, contact IDs, line-item codes — everything that needs to be referenced consistently across products lives in Xero and should flow through one channel.

## Current state (audit, 2026-05-13 — corrected after cross-repo grep)

**Audit method (this time, actually):** grepped `xero`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `09AF916B`, `354C59DC`, `xero.forit.io`, `api.xero.com`, `identity.xero.com`, `init_xero_connect`, `xero-connector` across every directory in `GitProjects/`. Excluded `node_modules`, `dist`, `build`, `.next`, `.venv`. Counted matches per repo. Then for each file with a hit, opened it and noted what it actually does.

**Eight repos touch Xero:**

| Repo | Client ID | OAuth flow | Role | Status |
|---|---|---|---|---|
| **forit-Xero** (this repo) | `09AF916B…` | auth-code + refresh_token (xero-node) | Master backend — MCP + PA API + interest accrual | Active, target of consolidation |
| **forit-Xero-Connector** | none hardcoded | auth-code (Power Automate native) | Power Automate **swagger manifest** (OpenAPI def, not a backend) — *separate repo, 387 grep matches* | Active, legitimately separate artifact |
| **forit-Website** | none | none (delegates) | **User-facing portal OAuth ingress** at `https://www.forit.io/portal/xero-connector` → `/api/portal` action `init_xero_connect` → proxies to `xero.forit.io/api/connect/init` with `x-api-key: PORTAL_API_KEY`. Stores tenant bindings in local `xero_connections` SQL table. *This is the real reauth flow — the one previously missing from this doc.* | Active, critical |
| **forit-Finance** | `354C59DC…` | **client_credentials (custom connection)** | Python ad-hoc bill/payment scripts using `xero-python`; `.mcp.json` declares the broken Custom Connection that MCP tools use | Active — needs migration (see `2026-05-13-forit-finance-migration-plan.md`) |
| **forit-CRM** | none (delegates) | none (delegates) | **19 files**: `api/shared/xero.js` is the core helper; `api/xero-sync/` is an Azure Function pulling Invoices/Quotes/Contacts on schedule; quote/contract/invoice CRUD all push to Xero via `${XERO_CONNECTOR_URL}/api/connector/*` with `XERO_API_KEY` header. *Major consumer previously missing from this doc.* | Active, critical |
| **personal-dev** (fastmcp-gateway) | none (delegates) | none | `mcp-servers/fastmcp-gateway/server.py:891-902` defines an `xero()` proxy that forwards to `https://xero.forit.io/api/connector`. This is the MCP-tool surface my own session uses. *Previously missing from this doc.* | Active |
| **forit-Mercury-Connector** | **UNVERIFIED** | Power Automate Custom Connection (`@parameters('$connections')['xero']`) | 4 files with bidirectional Xero↔Mercury sync flows (`flows/xero-to-mercury-sync.json`, `flows/mercury-to-xero-sync.json`) + `ContactMapping-schema.json`. Which Xero client_id the PA connection binds to has not been read out of the deployed flow. | Active — needs client_id confirmation |
| **forit-dynamics-legacy** | **UNVERIFIED** | Power Automate Custom Connection | `flows/get-invoices-client.json` (Pivot invoice digest) + architecture doc. Same client_id uncertainty as Mercury-Connector. | Archive candidate — confirm before deletion |

**Also referenced but not active consumers:**
- `forit-Support` — `scripts/import-infrastructure.js` lists `forit-xero-mcp` / `forit-xero-mcp-kv` Azure resources in an infrastructure snapshot; `productResolver.ts` mentions "Xero integrations" in a category displayName. No active Xero API calls.
- `forit-agile-transformation` — Two docs mention Xero in requirements/seed data. No code.

**Not yet grepped (the original doc claimed "verified to contain no Xero code" without actually checking these — that claim is retracted):**
- forit-Finance-Portal, forit-treasury, forit-payments, forit-SaaS, forit-dynamics-functions, forit-Dolores, wma-automation.

**Out-of-scope assertion retracted:** the original doc said "forit-Mercury-Connector and forit-dynamics-legacy don't own their own Xero credentials." That was inferred, not grepped. The actual Power Automate flow JSON references `@parameters('$connections')['xero']` — which client_id Power Automate has bound to that connection name in each environment is a deployed-state question, not a source-tree question. Treat both as unknown until somebody opens Power Automate and reads the connection binding.

## Target architecture

```
                                                            ┌──────────────────┐
                                                            │  Customer admin  │
                                                            │  (browser)       │
                                                            └────────┬─────────┘
                                                                     │ "Connect Xero"
                                                                     ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │  forit-Website  (portal)                                                   │
   │  /portal/xero-connector  →  POST /api/portal {action: init_xero_connect}   │
   │  proxies to xero.forit.io/api/connect/init  (x-api-key: PORTAL_API_KEY)    │
   │  stores tenant binding in saas SQL xero_connections                        │
   └────────────────────────────────────┬───────────────────────────────────────┘
                                        │ OAuth redirect
                                        ▼
                       ┌─────────────────────────────────────────┐
                       │           forit-Xero (master)           │
                       │  Client ID: 09AF916B…                   │
                       │  OAuth: auth-code + refresh_token       │
                       ├─────────────────────────────────────────┤
                       │  connector/  (Azure Functions)          │
                       │    OAuth:   /api/connect/init           │
                       │             /api/callback               │
                       │    REST:    /api/connector/*  (x-api-key)
                       │    MCP:     /api/mcp/*        (oauth)   │
                       │  interest/   (Azure Functions)          │
                       │    Cron + HTTP triggers for accrual     │
                       └─────────────────────────────────────────┘
                                         ▲
            ┌────────────────────────────┼─────────────────────────────┬───────────────────────┐
            │                            │                             │                       │
   ┌────────┴────────┐         ┌─────────┴─────────┐         ┌─────────┴─────────┐    ┌────────┴─────────┐
   │ forit-Finance   │         │  forit-CRM        │         │ personal-dev      │    │ Power Automate   │
   │ (post-migration)│         │  19 files, active │         │ fastmcp-gateway   │    │  flows           │
   │ HTTP+API key    │         │  xero-sync FA,    │         │ xero() proxy in   │    │ (Mercury,        │
   │ to /api/        │         │  contract→invoice │         │ server.py:891-902 │    │  dynamics-legacy,│
   │ connector/*     │         │  push, etc.       │         │ → /api/connector/*│    │  forit-Xero/flows│
   └─────────────────┘         └───────────────────┘         └───────────────────┘    └────────┬─────────┘
                                                                                               │
                                                                                               ▼
                                                                            ┌──────────────────────────────┐
                                                                            │   forit-Xero-Connector       │
                                                                            │  Power Automate swagger      │
                                                                            │  (PA calls api.xero.com      │
                                                                            │   via PA-native OAuth — does │
                                                                            │   NOT pass through forit-    │
                                                                            │   Xero backend)              │
                                                                            └──────────────────────────────┘
```

**Surface contract:**
- **Non-PA consumers** (forit-Finance post-migration, forit-CRM, personal-dev fastmcp-gateway, future products) call `https://xero.forit.io/api/connector/*` with `x-api-key`.
- **MCP consumers** (Claude/AI) call `/api/mcp/*` on the same backend (OAuth-protected).
- **User-facing OAuth** (admin "connect my Xero org") flows through `forit-Website → /api/portal → xero.forit.io/api/connect/init → api.xero.com → callback → xero_connections row`. The portal owns the UI; the backend owns the OAuth state machine.
- **Power Automate** flows continue using `forit-Xero-Connector` swagger manifest with PA-native OAuth — does NOT pass through the forit-Xero backend. This is the one consumer path that doesn't share the backend's rate limiter / tenant store, by necessity (PA owns its own OAuth).

The MCP surface, REST surface, and OAuth callback all live in the same Azure Function App. Same backend, three surfaces (auth, REST, MCP).

## Cleanup actions

Ordered by safety/independence — each is its own piece of work.

### 1. Migrate forit-Finance Python scripts onto forit-Xero connector API

**Scope:** Replace every `xero-python` SDK call in forit-Finance with HTTP requests to `https://xero.forit.io/api/connector/*` using an API key from `forit.io/portal`.

**Verification:** No remaining references to `xero-python`, `XERO_CLIENT_ID` in `.env.local`, or `identity.xero.com` in the forit-Finance repo. Smoke test one bill creation flow end-to-end.

**Dependency on next step:** None — finance migration can complete before the legacy Xero app is killed.

### 2. Delete the `354C59DC…` Xero app in the Xero developer portal

**Scope:** Only after step 1 verification. Remove the custom-connection app entirely so it can't drift back into use.

**Verification:** `curl -u 'CLIENT_ID:SECRET' -X POST https://identity.xero.com/connect/token …` returns 401/invalid_client.

### 3. Delete `forit-Xero/mcp-server/`

**Scope:** This subdirectory is a local CLI MCP client that just proxies HTTP to `xero.forit.io/api/connector/*`. The connector itself now exposes MCP endpoints directly (`/api/mcp/*`), so the proxy is redundant. Last commit Jan 2026; not deployed to Azure.

**Verification:** No `claude_desktop_config.json` in active use references `@forit/xero-mcp`. Search npm for any published package and unpublish if present.

### 4. Review `forit-Xero/flows/`

**Scope:** Only `swag-order-to-xero.json` exists, last touched Jan 2026. Either it's live (and should move into a flows repo with the rest), or it's dead (delete). Confirm with whoever owns SWAG orders before deleting.

**Verification:** If migrated, the flow runs from its new home; if deleted, no Power Automate run history shows it firing in the last 30 days.

### 5. Unify `xero-node` SDK version

**Scope:** `connector/package.json` pins `xero-node@5.x`, `interest/package.json` pins `xero-node@9.x`. Pick one (prefer 9.x, current) and align. Two versions in the same repo invites subtle behaviour drift.

**Verification:** Both subdirs' package.json show same version. `npm run build` passes for both. One smoke test per subdir against a Xero sandbox tenant.

### 6. Update `forit-Xero/CLAUDE.md`

**Scope:** Current CLAUDE.md documents `connector/` and `interest/` but not `mcp-server/` or `flows/`. After steps 3–4, CLAUDE.md should reflect the post-cleanup directory layout.

**Verification:** CLAUDE.md describes every top-level directory that exists on disk.

## Out of scope

- Merging forit-Xero-Connector into forit-Xero. The swagger manifest is a different artifact type with a different deployment pipeline (Power Automate environments) and adds no value by moving.
- Building a Python SDK around the connector REST API. Plain HTTP calls are sufficient for forit-Finance's needs; an SDK can come later if multiple Python consumers emerge.
- Re-platforming forit-CRM's existing 19-file Xero integration. It already routes through `xero.forit.io/api/connector/*`, which is the desired pattern. Don't touch what's working.
- Re-platforming the forit-Website portal flow. It already delegates correctly. Documentation gap in *this* doc was the only issue.

## Newly added action items (from the cross-repo audit)

- **A1: Read out the Power Automate connection bindings** for forit-Mercury-Connector and forit-dynamics-legacy flows. Open Power Automate portal, find the `xero` connection used by each flow, note the client_id it's bound to. If `354C59DC…`, those flows are also broken by the same outage; if `09AF916B…` (or a third client_id), the original "OK as-is" assessment holds.
- **A2: Grep the remaining repos** the original doc claimed were clean but never actually checked: forit-Finance-Portal, forit-treasury, forit-payments, forit-SaaS, forit-dynamics-functions, forit-Dolores, wma-automation. Spawn an Explore agent per repo.
- **A3: Confirm forit-CRM consumes a portal-issued API key.** The audit found `XERO_API_KEY` as the header value; confirm it's an `x-api-key` issued via the portal flow, not a Xero-app secret leaking through. If the latter, that's a finding to raise.

## Open decisions

None blocking. The MCP-vs-REST question was settled by the existing architecture — both surfaces live in the same backend, no fork needed.

## Success criteria

- One Xero app registration is in active use across all of ForIT's automation (`09AF916B…`).
- `GET /connections` against the active app returns the ForIT tenant — verifiable any time without an admin re-auth flow being needed.
- No repo in `GitProjects/` other than `forit-Xero` makes direct calls to `api.xero.com` or `identity.xero.com`.
- Adding a new Xero consumer (e.g. a new product writing invoices) requires an API key from `forit.io/portal` and zero changes to OAuth wiring.
