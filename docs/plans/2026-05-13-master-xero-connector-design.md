# Master Xero Connector — Architecture & Consolidation Design

**Date:** 2026-05-13
**Status:** Design approved, awaiting implementation prioritisation
**Owner:** forit-Xero
**Related repos:** forit-Finance, forit-payments, forit-Xero-Connector, forit-Mercury-Connector, forit-dynamics-legacy

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

## Current state (audit, 2026-05-13)

Five repos in `GitProjects/` touch Xero:

| Repo | Client ID | OAuth flow | Role | Status |
|---|---|---|---|---|
| **forit-Xero** | `09AF916B…` | auth-code + refresh_token (xero-node) | Master backend — MCP + PA API + interest accrual | Active, target of consolidation |
| **forit-Xero-Connector** | none hardcoded | auth-code (Power Automate native) | Power Automate **swagger manifest** (OpenAPI def, not a backend) | Active, legitimately separate artifact |
| **forit-Finance** | `354C59DC…` | **client_credentials (custom connection)** | Python ad-hoc bill/payment scripts using `xero-python` | Active — needs migration |
| forit-Mercury-Connector | none (inherits) | via forit-Xero-Connector | Power Automate flows for Xero↔Mercury sync | OK as-is |
| forit-dynamics-legacy | none (inherits) | via forit-Xero-Connector | Archived Power Automate flow (Pivot client invoice digest) | OK as-is, archive only |

Verified to contain **no** Xero code: forit-Finance-Portal, forit-treasury, forit-payments, forit-SaaS, forit-dynamics-functions, forit-Dolores, wma-automation.

## Target architecture

```
                       ┌─────────────────────────────────────────┐
                       │           forit-Xero (master)           │
                       │  Client ID: 09AF916B…                   │
                       │  OAuth: auth-code + refresh_token       │
                       ├─────────────────────────────────────────┤
                       │  connector/  (Azure Functions)          │
                       │    REST API:  /api/connector/*  (x-api-key)
                       │    MCP:       /api/mcp/*        (oauth)
                       │  interest/   (Azure Functions)          │
                       │    Cron + HTTP triggers for accrual     │
                       └─────────────────────────────────────────┘
                                         ▲
                                         │
        ┌────────────────────────────────┼──────────────────────────────┐
        │                                │                              │
┌───────┴───────┐         ┌──────────────┴──────────────┐   ┌───────────┴─────────────┐
│ forit-Finance │         │  Power Automate flows       │   │  Claude / AI consumers  │
│ Python scripts│         │  (forit-Mercury-Connector,  │   │  (MCP)                  │
│ (HTTP+API key)│         │   forit-dynamics-legacy,    │   │                         │
│               │         │   forit-Xero/flows/)        │   │                         │
└───────────────┘         └──────────────┬──────────────┘   └─────────────────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │   forit-Xero-Connector       │
                          │  Power Automate swagger      │
                          │  (calls api.xero.com via PA  │
                          │   native OAuth)              │
                          └──────────────────────────────┘
```

**Surface contract:** every non-Power-Automate consumer (Python scripts, treasury, future products) calls `https://xero.forit.io/api/connector/*` with `x-api-key`. Power Automate continues to use the forit-Xero-Connector swagger manifest with its native OAuth — that path doesn't go through the connector backend because Power Automate handles auth itself.

The MCP surface (`/api/mcp/*`) is for Claude/AI consumers and remains co-located with the REST API in the same Azure Function App. Same backend, two surfaces.

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
- Touching the active forit-Mercury-Connector or forit-dynamics-legacy flow repos. They already route through forit-Xero-Connector and don't own their own Xero credentials.
- Building a Python SDK around the connector REST API. Plain HTTP calls are sufficient for forit-Finance's needs; an SDK can come later if multiple Python consumers emerge.

## Open decisions

None blocking. The MCP-vs-REST question was settled by the existing architecture — both surfaces live in the same backend, no fork needed.

## Success criteria

- One Xero app registration is in active use across all of ForIT's automation (`09AF916B…`).
- `GET /connections` against the active app returns the ForIT tenant — verifiable any time without an admin re-auth flow being needed.
- No repo in `GitProjects/` other than `forit-Xero` makes direct calls to `api.xero.com` or `identity.xero.com`.
- Adding a new Xero consumer (e.g. a new product writing invoices) requires an API key from `forit.io/portal` and zero changes to OAuth wiring.
