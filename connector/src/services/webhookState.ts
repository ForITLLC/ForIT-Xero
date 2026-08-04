/**
 * What this instance has actually observed of Stripe's traffic.
 *
 * A locally-signed test proves the HANDLER is correct. It cannot prove the
 * signing secret in Key Vault is the one Stripe signs with — Stripe does not
 * return a signing secret on list or retrieve, so the mapping is established by
 * elimination and only a real event settles it. This is where that evidence
 * accumulates, so /api/health can say which of the two it is sure of.
 *
 * In-memory and per-instance by design: it is evidence this process has seen,
 * not a durable claim about the deployment. /api/health reports it as such.
 */

let verifiedCount = 0;
let rejectedCount = 0;
let lastVerifiedAt: string | null = null;
let lastRejectedAt: string | null = null;

/** A real Stripe payload verified against the configured signing secret. */
export function recordVerifiedEvent(): void {
  verifiedCount += 1;
  lastVerifiedAt = new Date().toISOString();
}

/**
 * A payload failed signature verification. Note this route is anonymous and
 * public, so this counts internet noise as readily as a genuine mismatch —
 * see health.ts for why it is reported but never alarms on its own.
 */
export function recordRejectedSignature(): void {
  rejectedCount += 1;
  lastRejectedAt = new Date().toISOString();
}

export interface WebhookObservations {
  verifiedCount: number;
  rejectedCount: number;
  lastVerifiedAt: string | null;
  lastRejectedAt: string | null;
}

export function getWebhookObservations(): WebhookObservations {
  return { verifiedCount, rejectedCount, lastVerifiedAt, lastRejectedAt };
}

/** Test seam. */
export function resetWebhookObservations(): void {
  verifiedCount = 0;
  rejectedCount = 0;
  lastVerifiedAt = null;
  lastRejectedAt = null;
}
