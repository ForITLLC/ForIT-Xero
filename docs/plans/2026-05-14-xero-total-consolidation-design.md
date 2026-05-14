# Total Xero Consolidation — Scope Design

**Date:** 2026-05-13 (filename uses 2026-05-14 for the planned execution date)
**Status:** SCOPING. Not approved for execution. Awaiting Ben's pick on options A/B/C and the open questions.
**Owner:** forit-Xero
**Parent:** `docs/plans/2026-05-13-master-xero-connector-design.md` (the now-corrected master design, revision 2)
**Why this doc exists:** Ben said "Zero should be under this repo. Totally. Everything repo should be under here." This doc scopes what "totally" means concretely, presents three interpretation options, recommends one, and lists the open questions that block execution.

---

## What we're trying to settle

After the corrected master design audit, Xero code currently lives in **eight repos**. The directive is to consolidate. But "consolidate" has a spectrum:

- **Narrow:** forit-Xero owns the API contract; consumer code stays where it is.
- **Medium:** forit-Xero owns the backend + the Xero-specific UI pieces + the PA connector definition. Consumer business logic stays.
- **Wide:** Everything Xero — including the `api/shared/xero.js` thin wrappers in forit-CRM, the `xero()` proxy in personal-dev, the OAuth UI components in forit-Website — physically moves into forit-Xero.

The Wide reading conflates *infrastructure ownership* with *physical code location* and would force every consumer to publish/import a forit-Xero package just to call APIs. The Narrow reading isn't really consolidation — it's a documentation rename.

The interesting design space is Medium. The rest of this doc unpacks what Medium specifically should contain.

---

## Inventory: what currently lives outside forit-Xero

| Location | Lines / Size | What it does | Move? |
|---|---|---|---|
| `forit-Xero-Connector/` (entire repo) | full repo: apiProperties.json, sql/, tests/, .github/workflows/ | Power Automate connector definition + deploy pipelines. Reads `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` for PA-environment provisioning. | **Yes — fold into `forit-Xero/power-automate/`** |
| `forit-Website/api/portal/index.js` lines 16, 94, 613–699 | ~100 of 1424 lines | Portal API actions: `init_xero_connect`, `delete_xero_connection`, the SQL SELECT/DELETE on `xero_connections`. Currently proxies to `xero.forit.io/api/connect/init` with `x-api-key: PORTAL_API_KEY`. | **Maybe — see Option B vs C** |
| `forit-Website/src/components/portal/components/OAuthConnectComponent.tsx` | full file | "Connect Xero" button UI. Calls `POST /api/portal {action: init_xero_connect}`. | **Maybe — see Option B vs C** |
| `forit-Website/src/app/portal/[slug]/ProductConfigClient.tsx` lines 32–45 | ~13 lines | Maps `xero-connector` slug to portal components (api-keys, oauth-connect, documentation). | Stay (it's portal-shell config, not Xero-specific logic) |
| `forit-Website/src/components/ProductsApiKeys.tsx` lines 204–219, 333 | ~20 lines | Lists xero-connector product card; shows tenant binding. | Stay (it's the portal shell rendering Xero state, not owning it) |
| `forit-CRM/api/shared/xero.js` + 18 other files | 271 lines + 18 files | Consumer code. Quote/invoice CRUD pushed to Xero via `xero.forit.io/api/connector/*`. | **No — consumer code stays in the consuming repo** |
| `personal-dev/mcp-servers/fastmcp-gateway/server.py:891-902` | ~12 lines | MCP-gateway `xero()` proxy → `xero.forit.io/api/connector`. | Stay (it's MCP-gateway infrastructure, not a Xero artifact) |
| `forit-Mercury-Connector/flows/*xero*.json` | 2 files | Power Automate flows using a Xero connection. | Stay (consumer flows; the *connector definition* they bind to is what moves) |
| `forit-dynamics-legacy/flows/get-invoices-client.json` | 1 file | PA flow using a Xero connection. Archive candidate. | Stay or delete |

Two of the "stay" rows above need scope confirmation from Ben — those are the ones where the Wide reading would say move.

---

## Three options

### Option A — Wide (everything physically here)

forit-Xero/ grows to contain:
- `power-automate/` ← absorb forit-Xero-Connector
- `portal-ui/` ← absorb the OAuthConnectComponent + ProductConfigClient pieces
- `portal-api/` ← absorb init_xero_connect / delete_xero_connection action handlers
- `npm-packages/xero-client-js/` ← published package for forit-CRM to consume
- `npm-packages/xero-client-py/` ← published package for forit-Finance + future Python consumers

**Pros:** Truly one repo. `grep -r xero ~/GitProjects/` would highlight only forit-Xero plus call-sites.
**Cons:**
- forit-Website's Next.js bundle would import portal-ui from forit-Xero — cross-repo build pipeline complexity
- Publishing internal npm packages is real overhead (versioning, CI, registry auth)
- Wraps the consumer-code/infrastructure boundary in the wrong direction — every CRM line touching Xero would have to go through a package release cycle

### Option B — Medium-strict (forit-Xero owns OAuth state machine end-to-end; portal becomes a redirect target)

Move from forit-Website into forit-Xero:
- `forit-Xero-Connector` entire repo → `forit-Xero/power-automate/`
- The portal Xero actions: instead of `forit-Website/api/portal {action:init_xero_connect}` proxying to `xero.forit.io`, forit-Website **redirects** the user's browser directly to a new `xero.forit.io/portal/start?customer=XXX&returnUrl=YYY` page that's served from forit-Xero. forit-Xero owns the whole OAuth front-door including the consent screen styling.
- The xero_connections SQL table ownership stays in `forit-saas-db` (shared) but all writes happen from forit-Xero Azure Functions only; forit-Website's delete action also moves into forit-Xero as `DELETE /api/connections/:id`.

Stay:
- The "Connect Xero" *button* in forit-Website remains — it's a portal shell concern. Its `onClick` changes from "POST /api/portal" to "redirect to xero.forit.io/portal/start".
- forit-CRM untouched.

**Pros:**
- forit-Xero is the unambiguous owner of every OAuth state transition and every `xero_connections` write
- forit-Website becomes a dumb shell that knows nothing about Xero except "we have a product called xero-connector"
- No npm-package publishing overhead
- forit-Xero-Connector becomes a subdirectory, not a separate repo

**Cons:**
- The hosted portal page in forit-Xero needs styling consistent with forit.io's portal, which means either iframing or a shared style-bundle (more work)
- Crosses a UX boundary — Ben's portal currently feels like one app; this would introduce a redirect to a different subdomain mid-flow

### Option C — Medium-loose (forit-Xero owns code; portal UI keeps the actions but imports from forit-Xero)

Move from forit-Website into forit-Xero:
- `forit-Xero-Connector` entire repo → `forit-Xero/power-automate/`
- The action *handlers* for init_xero_connect / delete_xero_connection: factor them into a small Node module under `forit-Xero/portal-actions/`, published as `@forit/xero-portal-actions` (or pulled in via git submodule). forit-Website's `/api/portal` route imports and calls them. Zero behavior change for the user, but forit-Xero owns the code.

Stay:
- forit-Website's portal UI components and the `/api/portal` route stay — they just thin out to ~5-line callsites.
- forit-CRM untouched.

**Pros:**
- No UX disruption — portal still feels like one app
- forit-Xero owns every line of Xero-specific logic, but doesn't host the UI shell
- Easier rollout than B (no redirect to a new domain mid-flow)

**Cons:**
- The npm-package publishing overhead Option A had, in miniature — `@forit/xero-portal-actions` needs versioning, CI, registry
- Two repos still need to be in sync (forit-Xero ships the actions; forit-Website ships the routes that call them)

---

## Recommendation: **Option B**, with one caveat

Option B is the cleanest expression of "forit-Xero owns Xero, totally." The UX cost (one mid-flow redirect to xero.forit.io) is the price of the architectural clarity, and `xero.forit.io` is *already* a ForIT-branded subdomain — users see it on the Xero consent screen anyway, so the redirect isn't introducing a stranger.

**The caveat:** if the forit.io portal is the only customer-facing surface and product cohesion matters more than backend cleanliness, **Option C** is the right call. C is uglier under the hood (cross-repo package) but invisible to the user.

**My read of Ben's directive ("everything under this repo, totally"):** he's optimizing for repo clarity, not for portal UX cohesion. So I'm recommending **B**. But this is the kind of trade-off where Ben's gut on UX should override my repo-cleanliness reasoning.

---

## What's NOT being proposed

To be explicit about what stays out of scope (so Ben can check whether his "totally" is bigger than mine):

- **forit-CRM consumer code does not move.** The 19 files in CRM aren't Xero infrastructure; they're CRM business logic that happens to call Xero. Moving them would force every CRM commit to touch forit-Xero, which is the opposite of separation of concerns.
- **personal-dev/fastmcp-gateway does not move.** It's a generic MCP gateway that proxies many services, one of which is Xero. The `xero()` function is 12 lines.
- **forit-Mercury-Connector and forit-dynamics-legacy flow JSONs do not move.** They're consumer flows that bind to the PA connector definition (which DOES move into forit-Xero/power-automate/). The flows themselves are Mercury-domain or dynamics-domain logic.
- **The `xero_connections` SQL table doesn't physically move.** It's in `forit-saas-db` because customer + product + tenant-binding all need to live in the same database for join performance. forit-Xero gets exclusive write access; that's the consolidation.

If Ben's "totally" means we ARE moving any of these four, that's a bigger conversation.

---

## Open questions for Ben — required before execution

1. **Option A / B / C — which?** I'm recommending B. Pick.
2. **Does the consolidation include moving forit-CRM's 19 Xero-touching files into forit-Xero?** I assumed no (consumer code stays with consumer). Confirm or override.
3. **Once forit-Xero-Connector is merged in as a subdirectory, do we keep that repo on GitHub for history, archive it, or delete?** Archive is recommended (preserves the git log for the PA connector evolution).
4. **For Option B specifically — is a mid-flow redirect from `forit.io/portal` to `xero.forit.io/portal/start` acceptable UX?** If no, fall back to Option C.
5. **The MCP tool surface (`mcp__xero__*` that this very session uses) currently binds to the 354C59DC Custom Connection.** Should the consolidation also migrate the MCP surface onto the 09AF916B platform app + portal-issued binding? That's a separate piece of work that the finance-migration plan also touches (`docs/plans/2026-05-13-forit-finance-migration-plan.md`). Confirm scope alignment.

---

## If B is approved — implementation phases

(Listed here so the scope is concrete; do not execute until Ben picks an option.)

1. **Phase 1 — Move forit-Xero-Connector into forit-Xero/power-automate/.** Sub-tasks: copy repo contents, port `.github/workflows/` to forit-Xero's CI, update `SETUP_SECRETS.md`, archive the standalone repo. Touches zero runtime — only deploy pipeline.
2. **Phase 2 — Build the hosted Xero portal start page in forit-Xero.** Sub-tasks: new Azure Function route `GET /portal/start` that renders a tiny HTML page with "you are about to connect Xero to ForIT" + a single button that POSTs to `/api/connect/init`. Style it to match forit.io.
3. **Phase 3 — Cut forit-Website's "Connect Xero" button to redirect to the new page.** Sub-tasks: replace the OAuthConnectComponent onClick handler. Keep `delete_xero_connection` in forit-Website for now (it's a small surface).
4. **Phase 4 — Move `delete_xero_connection` action handler into forit-Xero as `DELETE /api/connections/:id`.** Sub-tasks: implement the route, update forit-Website's delete button to call it directly. Remove the action handler from `forit-Website/api/portal/index.js`.
5. **Phase 5 — Documentation sweep.** Update CLAUDE.md in forit-Xero to describe the now-consolidated layout. Update forit-Website's CLAUDE.md to note that Xero actions are no longer hosted there.

Each phase ships independently; each is reversible by reverting one PR.

---

## Honesty note (per the lesson from the 2026-05-13 audit failure letter)

This doc is a scoping doc. It has not been validated against:
- The actual UX flow on forit.io/portal (I have not opened it)
- The forit-Website Next.js build configuration (I do not know if portal pages can split into multiple subdomains gracefully)
- The forit-Xero-Connector repo's CI quirks (I have not read its `.github/workflows/`)

Before phase 1 ships, those three things need a real check. Don't let me write "execute Option B" without first validating them. The audit failure letter at `docs/letters/2026-05-13-xero-audit-failure.md` exists specifically to prevent the next session from skipping verification.
