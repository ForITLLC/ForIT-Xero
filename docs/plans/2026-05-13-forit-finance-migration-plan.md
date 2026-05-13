# forit-Finance → forit-Xero Connector Migration Plan

**Date:** 2026-05-13
**Parent design:** `docs/plans/2026-05-13-master-xero-connector-design.md` (action #1)
**Goal:** Eliminate the broken `354C59DC` Xero custom connection. Route every Xero call from forit-Finance through `xero.forit.io/api/connector/*` instead.

## Why this is smaller than it looks

A naive read of the inventory says "69 Python files in forit-Finance call Xero — that's a huge migration." It isn't. Two findings change the scope:

**Finding 1 — most files are one-shot archeology.** Of the 69, only ~5 are part of an ongoing system. The rest are named after specific bills/payments they fixed once (`create_bill_645.py`, `delete_invoice_0244.py`, `check_1080a.py`, `fix_july_august_payments.py`, …). They ran, did their job, and were never touched again. The right answer for these is **archive or delete**, not migrate.

**Finding 2 — forit-Xero already covers everything via passthrough.** `connector/src/functions/connector.ts:1256-1259` registers a `ConnectorPassthrough` route at `connector/{*path}` accepting all HTTP verbs. The handler at `connector.ts:1190-1260` forwards arbitrary paths to `api.xero.com/api.xro/2.0/{path}` (or `finance.xro/1.0/{path}` when prefixed), adding the Bearer token and `Xero-Tenant-Id` header. **No new endpoints need to be added to forit-Xero** to cover finance's use cases.

Net: migration is a thin Python client + a handful of live-script swaps + an archive sweep.

## Inventory recap

From the survey:

| Category | Count | Disposition |
|---|---|---|
| One-shot bill/payment fix scripts | ~60 | Archive (move to `_archive/` subdir) — DO NOT migrate |
| Ongoing CLI gateway (`xero_auth.py`, `xero_direct.py`) | 2 | Replace with `forit_xero_client.py` helper |
| Read-only utility scripts still in use | ~3 | Migrate using new helper |
| Azure Function automation (`function_app_receipt_routes.py`) | 1 | Migrate using new helper |
| Power Automate flow (`trip-booking-processor/definition.json`) | 1 | Re-point connection reference (no code change to script) |
| **Total active migration targets** | **~7** | |

Confirmation that the ~60 archive candidates are truly dead must come from the user / file mtimes / git log — see step 1.

## Implementation steps

Each step has a verification gate. Steps 2–6 can be done independently of each other once step 1 is done.

### Step 1 — Identify dead vs live scripts

**Scope:** Categorise every file in `forit-Finance` that hits Xero (per task #6 inventory) as one of: `live` (still being run), `archive` (one-shot, completed its job), or `unknown` (need user input).

**Method:**
- For each file: `git log --follow -- <path>` to check whether it's been modified since its initial creation
- Files modified only once and named after a specific bill/payment ID → archive
- Files imported by other files → live (check via `grep -rl "import <module>" forit-Finance`)
- Files referenced in CI / cron / Function App entrypoints → live
- Anything ambiguous → ask the user

**Output:** A CSV at `forit-Finance/docs/xero-migration-inventory.csv` with columns `path,disposition,reason`.

**Verification:** Sum of `live` + `archive` + `unknown` = total file count. User reviews the `unknown` rows.

### Step 2 — Build `forit_xero_client.py` helper

**Scope:** Single Python module in `forit-Finance/` that wraps `requests` calls to `https://xero.forit.io/api/connector/*` with `x-api-key` auth. Exposes a small API mirroring what scripts currently do:

```python
class ForitXeroClient:
    def __init__(self, api_key: str | None = None):
        # reads FORIT_XERO_API_KEY from env if not passed
    def get_invoices(self, where: str | None = None, ...) -> dict
    def get_invoice(self, invoice_id: str) -> dict
    def create_invoice(self, invoice: dict) -> dict
    def update_invoice(self, invoice_id: str, body: dict) -> dict
    def set_invoice_status(self, invoice_id: str, status: str) -> dict
    def get_payments(self, where: str | None = None) -> dict
    def create_payment(self, payment: dict) -> dict
    def get_bank_transactions(self, where: str | None = None) -> dict
    def get_contacts(self, where: str | None = None) -> dict
    def passthrough(self, method: str, path: str, **kwargs) -> dict
```

Implementation note: most methods are 3-line wrappers around `self.passthrough(method, path, ...)`. The point of explicit methods is discoverability + type hints; the passthrough is the escape hatch for anything not yet wrapped.

**Verification:** Unit test against a Xero sandbox tenant. Get one invoice, create one draft invoice, void it. Three round trips, all 2xx, no `Authorization` or `XERO_CLIENT_*` env vars required.

### Step 3 — Migrate the gateway files

**Scope:** Replace `xero_auth.py` and `xero_direct.py` with thin shims that import `ForitXeroClient`. Both are entry points imported by other live scripts, so getting them onto the new client unblocks step 4.

**Verification:** Run any one live downstream script (per step 1's `live` list) through its dry-run mode or a smoke test. No reference to `xero-python`, `identity.xero.com`, `XERO_CLIENT_ID`, or `354C59DC` remains in either file.

### Step 4 — Migrate remaining live CLI scripts

**Scope:** For each file in step 1's `live` category, replace direct Xero SDK calls with `ForitXeroClient` calls. Smallest-first; read-only before write.

**Verification:** Per script — run end-to-end, compare output to known-good (either prior run output committed for reference, or a sandbox tenant comparison).

### Step 5 — Migrate the Azure Function (`function_app_receipt_routes.py`)

**Scope:** The receipt-routing Function App is currently a scheduled/automated caller. Migration is identical to a CLI script but the deploy step matters: it runs in Azure with its own app settings.

**Verification:**
- Local test using the new helper passes
- Deploy to Function App
- Trigger one real receipt-routing event
- Function App logs show 2xx responses from `xero.forit.io` (not `api.xero.com`)
- No `XERO_CLIENT_*` env vars set on the Function App after migration

### Step 6 — Re-point Power Automate flow (`trip-booking-processor`)

**Scope:** The flow definition references `api.xero.com` directly. Update the flow to use the `forit-Xero-Connector` Power Automate connector (which itself routes through the `09AF916B` app, not `354C59DC`). No code change to the flow's business logic, only the connection reference.

**Verification:**
- Open the flow in the Power Automate portal
- Confirm the Xero connection shows `forit-Xero-Connector` as the source
- Trigger one trip booking
- Flow run history shows the action succeeded against the new connection

### Step 7 — Archive dead scripts

**Scope:** Move every file in step 1's `archive` category into `forit-Finance/_archive/xero-migration-2026-05/`. Preserves history without leaving broken scripts callable. Add a `README.md` in the archive folder explaining the archival date and why.

**Verification:** `grep -rli "354C59DC\|identity.xero.com\|api.xero.com\|xero-python" forit-Finance/ | grep -v _archive/ | grep -v node_modules` returns only the migrated live files (plus the new helper).

### Step 8 — Kill the `354C59DC` Xero app

**Scope:** Parent design doc action #2. Only after steps 2–7 are verified and forit-Finance has been running off `xero.forit.io` for at least 7 days with no fallbacks to the old credential.

**Verification:** `curl -u '354C59DC...:<secret>' -X POST https://identity.xero.com/connect/token …` returns 401/invalid_client. Confirms the credential no longer exists.

## Rollout order & risk

1. **Steps 1, 2** — zero production impact (inventory + new helper code, no callers yet)
2. **Step 3** — moderate impact (gateway changes affect all live callers, but no script behaviour changes)
3. **Step 4** — low impact (read-only scripts first, then write scripts, one at a time)
4. **Step 5** — moderate impact (automated system, but already isolated by Function App)
5. **Step 6** — moderate impact (PA flow, easy rollback by reverting the connection reference)
6. **Step 7** — zero runtime impact (archive only)
7. **Step 8** — destructive, irreversible (use `--force` mentality: only when steps 1–7 have been live for a week)

**Rollback path at any point:** Revert the touched file(s) on `feature/forit-finance-xero-migration`. The `354C59DC` credential remains live until step 8, so falling back keeps working until then.

## Open decisions for the user

1. **Branch strategy** — single long-lived `feature/forit-finance-xero-migration` branch, or one PR per step? Recommended: PR per step (1–7), step 8 is a documented one-off operation.
2. **Sandbox tenant** — does ForIT have a Xero sandbox/demo company to test against, or does verification run against the live ForIT org with reversible operations (create-then-void)?
3. **Archive vs delete** — for step 7, archive (preserves git-grep findability) or hard delete (cleaner)? Archive recommended; cost is one `_archive/` dir, benefit is preserved historical context for "how did we fix bill 645 in 2025?"

## Out of scope

- Adding new connector endpoints to forit-Xero. Passthrough covers everything; explicit endpoints are only worth adding for paths called by 3+ scripts after migration (let usage drive the decision).
- Migrating `forit-Mercury-Connector` or `forit-dynamics-legacy` flows — those already route through `forit-Xero-Connector` and don't use the `354C59DC` credential.
- Reworking forit-Xero's `xero_connections` table or tenant lookup. It already works.

## Success criteria

- `grep -rli "354C59DC" /Users/benjaminwesleythomas/GitProjects/forit-Finance` returns zero results outside `_archive/`.
- `grep -rli "identity.xero.com\|xero-python" /Users/benjaminwesleythomas/GitProjects/forit-Finance` returns only `_archive/` paths.
- The `354C59DC` Xero app no longer exists in the Xero developer portal.
- All live forit-Finance scripts and the receipt-routing Function App run successfully against `xero.forit.io` for 7 consecutive days with no fallbacks.
