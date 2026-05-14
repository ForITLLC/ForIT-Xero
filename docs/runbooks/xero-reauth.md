# Xero MCP / Custom Connection Reauth Runbook

Mirror of `forit-Finance/docs/session-reference.md:31-49` (as of 2026-05-13).
Keep this in sync — the source of truth lives in finance because that's where the breakage hits first; this copy exists so the connector repo isn't dependent on the finance repo to answer "how do I unbreak Xero auth."

---

**When you see this:** `mcp__xero__*` tool calls return `403 AuthenticationUnsuccessful` with `xero-tenant-id: ""` in the outgoing request header, or Claude Code disconnects the xero MCP server after a few minutes of failing calls. Token JWT will look valid (fresh issue, 30-min lifetime, scopes intact) — the failure is **missing tenant binding**, not token expiry.

**Why it dies:** The MCP uses a **Xero Custom Connection** (Client Credentials grant, client_id `354C59DC…7DDA274B`). Custom Connections must be individually bound to a single organisation, and that binding can be silently revoked / deleted (max 1-year lifetime per Xero). When `GET https://api.xero.com/connections` returns `[]`, the SDK keeps going with `tenantId=""` and every call 403s. Confirmed broken 2026-05-13 by curl diagnostic (token POST → 200, `/connections` → `[]` HTTP 200).

**Portal reauth URL (verified from `forit-Website` source, 2026-05-13):** **<https://www.forit.io/portal/xero-connector>**. NOT `developer.xero.com/app/manage` (the 2026-04-22 post-mortem URL is wrong — do not use it).

Flow when you click "Connect Xero" on that page:
1. Browser POSTs `/api/portal {action: 'init_xero_connect', returnUrl: ...}` (`forit-Website/src/components/portal/components/OAuthConnectComponent.tsx:43-50`).
2. Portal API proxies to `${XERO_CONNECTOR_URL}/api/connect/init` with `x-api-key: PORTAL_API_KEY` (`forit-Website/api/portal/index.js:649-697`).
3. Connector at `xero.forit.io` returns a Xero OAuth URL; browser redirects, user approves, Xero callback fires and the connector saves the tenant binding.
4. Browser returns to `https://www.forit.io/portal/xero-connector?connected=true`.

**Caveat — which app does this reauth?** The portal flow authorises the **09AF916B platform app** (authorization_code grant, the connector at `xero.forit.io` — this repo). It does **NOT** rebind the legacy **354C59DC Custom Connection** that the in-session `mcp__xero__*` tools currently use (`forit-Finance/.mcp.json` → `XERO_CLIENT_ID = 354C59DC48944F1B8CAC7F307DDA274B`). For the MCP, the binding has to be set on the Custom Connection — the page Ben uses for that has **not** been captured in either repo (ask Ben, then update this section).

**Permanent fix is the migration, not the reauth.** [`docs/plans/2026-05-13-forit-finance-migration-plan.md`](../plans/2026-05-13-forit-finance-migration-plan.md) (branch `docs/master-xero-design`) deletes the 354C59DC Custom Connection entirely and switches finance to calling `xero.forit.io/api/connector/*` — the 09AF916B platform app, authorization_code grant, which does not have the silent-binding-revocation lapse. Inventory at `forit-Finance/docs/xero-migration-inventory.csv` (71 files, 12 live / 59 archive).

**Full root-cause + evidence:** `forit-Finance/docs/postmortems/2026-04-22-xero-mcp-death.md` (decoded JWT, captured 403 correlation ids, SDK source line `dist/clients/xero-client.js:79` where the empty-array path is silently swallowed). Prevention items listed there (upstream PR to throw on empty connections, monthly synthetic check, pin MCP version) **have not been actioned** — which is why this re-occurs and why the migration is the better path.
