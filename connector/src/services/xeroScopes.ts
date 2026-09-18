/**
 * The ONE Xero OAuth scope list this connector requests — at consent
 * (POST /api/connect/init) and at refresh (xeroConnection). It used to be
 * two hand-copied arrays; two copies drift, and a refresh that requests
 * fewer scopes than the consent did is a silent way to narrow a grant.
 * test/xeroOAuthScopes.test.js drives both real call sites against this.
 *
 * Xero grants exactly what is requested and scopes are additive on
 * re-consent, so ADDING a scope here changes nothing until each connected
 * customer re-consents: the stored token keeps the scope claim it was
 * minted with. .github/workflows/read-xero-token-scope.yml reads the live
 * claim without exposing the token.
 *
 * WO#2073 (2026-09-18) added the three *.read scopes so for-Finance's X4
 * archive can read Journals, Reports and Attachments through the
 * passthrough. accounting.settings.read is deliberately NOT listed — the
 * broad accounting.settings already grants it — and the same goes for
 * accounting.contacts.read. The broad accounting.transactions and
 * accounting.reports.read stay valid for this app (created before
 * 2026-03-02) until September 2027; moving to the granular replacements is
 * a separate migration with its own re-consent.
 *
 * Journals is additionally tier-gated by Xero (Advanced tier plus a
 * security assessment under the 2026 pricing model). Requesting the scope
 * is necessary, not sufficient: if GET /Journals still answers 401/403
 * after a re-consent whose token carries accounting.journals.read, that is
 * the tier gate, not this list.
 */
export const XERO_OAUTH_SCOPES: readonly string[] = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.transactions',
  'accounting.settings',
  'accounting.contacts',
  'accounting.journals.read',
  'accounting.reports.read',
  'accounting.attachments.read',
]);
