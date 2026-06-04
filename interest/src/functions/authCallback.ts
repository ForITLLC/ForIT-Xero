import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

/**
 * Xero OAuth consent surface — DISABLED.
 *
 * The connector (forit-xero-mcp) is now the single owner of the Xero refresh
 * token. This app obtains access tokens from the connector's /api/tokens
 * endpoint and must never run its own OAuth consent flow — minting + rotating
 * a refresh token here would desync the connector and cause invalid_grant
 * (the original bug). Re-consent happens exclusively via the ForIT portal,
 * which drives the connector's callback.
 */
async function disabledConsentEndpoint(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: {
      error: 'This endpoint has been disabled',
      message: 'Xero authorization is handled by the ForIT portal. The connector is the sole owner of the Xero connection.',
      portalUrl: 'https://forit.io/portal',
    },
  };
}

app.http('AuthCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'auth/callback',
  handler: disabledConsentEndpoint,
});

app.http('AuthStart', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'auth/start',
  handler: disabledConsentEndpoint,
});
