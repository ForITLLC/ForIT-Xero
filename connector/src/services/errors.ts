import { HttpResponseInit, InvocationContext } from '@azure/functions';
import { randomUUID } from 'node:crypto';

/**
 * One way to fail.
 *
 * These handlers used to return `error.message` verbatim to the caller. Every
 * route in this app is `authLevel: 'anonymous'` by design — auth is enforced
 * per-handler by `x-api-key` — so an unauthenticated caller could read whatever
 * the underlying Azure SDK, SQL driver or Xero client happened to put in a
 * message: Key Vault secret names, SQL server and login names, OAuth client and
 * token-exchange detail.
 *
 * The contract now: the caller gets an opaque message plus a correlation id
 * they can quote to support; the full detail goes to `context.error` alone,
 * keyed by that same id.
 */

export const GENERIC_ERROR_MESSAGE = 'Internal server error';

/**
 * Log the failure in full and mint the correlation id that ties the caller's
 * response to this log entry. Use directly when the response is not a JSON
 * body (a redirect, say); prefer `errorResponse` otherwise.
 */
export function reportFailure(context: InvocationContext, label: string, error: unknown): string {
  const correlationId = randomUUID();

  context.error(label, {
    correlationId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return correlationId;
}

/**
 * Log the failure and build the response the caller is allowed to see. The
 * status stays honest — we hide the detail, never the failure.
 */
export function errorResponse(
  context: InvocationContext,
  label: string,
  error: unknown,
  options: { status?: number; publicMessage?: string } = {}
): HttpResponseInit {
  const correlationId = reportFailure(context, label, error);

  return {
    status: options.status ?? 500,
    jsonBody: {
      error: options.publicMessage ?? GENERIC_ERROR_MESSAGE,
      correlation_id: correlationId,
    },
  };
}
