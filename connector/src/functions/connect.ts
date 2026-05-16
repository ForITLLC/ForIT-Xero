import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { XeroClient } from 'xero-node';
import { getSecret, setSecret, SECRETS } from '../services/keyvault';
import { getCustomerByEmail, saveXeroConnection } from '../services/database';
import { probeConnection } from '../services/xeroConnection';

/**
 * ForIT Xero Connector - OAuth Connect Endpoints
 *
 * These endpoints handle the OAuth flow initiated from the ForIT portal.
 * The portal authenticates users via Azure AD and passes the verified email.
 */

const BASE_URL = process.env.BASE_URL || 'https://xero.forit.io';
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;

interface ConnectState {
  customer_id: string;
  return_url: string;
  timestamp: number;
}

/**
 * Encode state for OAuth flow
 */
function encodeState(state: ConnectState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/**
 * Decode state from OAuth callback
 */
function decodeState(encoded: string): ConnectState | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Validate portal API key
 */
async function validatePortalApiKey(request: HttpRequest): Promise<boolean> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return false;

  const expectedKey = await getSecret(SECRETS.PORTAL_API_KEY);
  return apiKey === expectedKey;
}

/**
 * Create XeroClient for OAuth
 */
async function getXeroClient(state: string): Promise<XeroClient> {
  if (!XERO_CLIENT_ID) {
    throw new Error('XERO_CLIENT_ID not configured');
  }

  const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);

  return new XeroClient({
    clientId: XERO_CLIENT_ID,
    clientSecret,
    redirectUris: [`${BASE_URL}/api/callback`],
    scopes: [
      'openid',
      'profile',
      'email',
      'accounting.transactions',
      'accounting.settings',
      'accounting.contacts',
      'offline_access',
    ],
    state,
  });
}

/**
 * POST /api/connect/init
 *
 * Called by the portal to initiate OAuth flow.
 * Portal passes the verified user email and return URL.
 * Returns the Xero OAuth URL to redirect the user to.
 */
async function connectInit(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    // Validate portal API key
    const isValidPortal = await validatePortalApiKey(request);
    if (!isValidPortal) {
      return {
        status: 401,
        jsonBody: { error: 'Invalid portal API key' },
      };
    }

    // Parse request body
    const body = await request.json() as { email?: string; return_url?: string };
    const { email, return_url } = body;

    if (!email || !return_url) {
      return {
        status: 400,
        jsonBody: { error: 'Missing email or return_url' },
      };
    }

    // Look up customer by email
    const customer = await getCustomerByEmail(email);
    if (!customer) {
      return {
        status: 404,
        jsonBody: { error: 'Customer not found for this email' },
      };
    }

    // Create state for OAuth callback
    const state: ConnectState = {
      customer_id: customer.id,
      return_url,
      timestamp: Date.now(),
    };
    const encodedState = encodeState(state);

    // Build Xero OAuth URL
    const xeroClient = await getXeroClient(encodedState);
    const consentUrl = await xeroClient.buildConsentUrl();

    context.log('OAuth init for customer', { customerId: customer.id, email });

    return {
      status: 200,
      jsonBody: { oauth_url: consentUrl },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Connect init failed', error);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

/**
 * GET /api/connect/callback
 *
 * Xero redirects here after user approves.
 * Exchange code for tokens, save to database, redirect back to portal.
 */
async function connectCallback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const stateParam = request.query.get('state');
  // Decode state up front so the outer catch can redirect back to the
  // originating customer portal page instead of the bare /portal route
  // (which is the employee portal).
  const state = stateParam ? decodeState(stateParam) : null;
  const fallbackReturnUrl = state?.return_url || 'https://www.forit.io/portal/xero-connector';

  try {
    const code = request.query.get('code');
    const error = request.query.get('error');

    // Handle Xero error
    if (error) {
      const errorDescription = request.query.get('error_description') || 'Unknown error';
      context.error('Xero OAuth error', { error, errorDescription });

      return {
        status: 302,
        headers: {
          Location: `${fallbackReturnUrl}?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription)}`,
        },
      };
    }

    if (!code || !stateParam) {
      return {
        status: 400,
        jsonBody: { error: 'Missing code or state parameter' },
      };
    }

    if (!state) {
      return {
        status: 400,
        jsonBody: { error: 'Invalid state parameter' },
      };
    }

    // Check state isn't too old (1 hour max)
    const stateAge = Date.now() - state.timestamp;
    if (stateAge > 60 * 60 * 1000) {
      return {
        status: 400,
        jsonBody: { error: 'OAuth session expired. Please try again.' },
      };
    }

    // Exchange code for tokens
    const xeroClient = await getXeroClient(stateParam);
    const tokenSet = await xeroClient.apiCallback(request.url);

    if (!tokenSet.access_token || !tokenSet.refresh_token) {
      throw new Error('Failed to get tokens from Xero');
    }

    // Get tenant info
    await xeroClient.updateTenants();
    const tenants = xeroClient.tenants;

    if (!tenants || tenants.length === 0) {
      return {
        status: 302,
        headers: {
          Location: `${state.return_url}?error=no_tenants&error_description=${encodeURIComponent('No Xero organizations found. Please ensure you have access to at least one organization.')}`,
        },
      };
    }

    // Use first tenant (most users have one)
    // TODO: Support multi-tenant selection in future
    const tenant = tenants[0];

    if (!tenant.tenantId) {
      context.error('Xero tenant missing tenantId', { tenant });
      return {
        status: 302,
        headers: {
          Location: `${state.return_url}?error=invalid_tenant&error_description=${encodeURIComponent('Xero organization data incomplete. Please try again or contact support.')}`,
        },
      };
    }

    // Save connection to database. CRITICAL: at this point Xero has
    // already rotated the refresh token in their server-side state —
    // if we fail to persist, the user's previous token is dead AND we
    // have no new token, so the portal will lie unless we cleanup.
    // Retry once on any failure, then surface loudly so the next
    // refresh attempt cleans up via the invalid_grant path.
    const expiresAt = tokenSet.expires_at || Math.floor(Date.now() / 1000) + 1800;
    let saveError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await saveXeroConnection(
          state.customer_id,
          tenant.tenantId!,
          tenant.tenantName || 'Unknown Organization',
          tokenSet.access_token,
          tokenSet.refresh_token,
          expiresAt
        );
        saveError = null;
        break;
      } catch (err) {
        saveError = err;
        context.error('saveXeroConnection failed', {
          attempt,
          customerId: state.customer_id,
          tenantId: tenant.tenantId,
          refreshTokenHead: tokenSet.refresh_token.slice(0, 12),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (saveError) {
      const msg = saveError instanceof Error ? saveError.message : String(saveError);
      return {
        status: 302,
        headers: {
          Location: `${state.return_url}?error=save_failed&error_description=${encodeURIComponent(`Xero authorization succeeded but the connection could not be saved (${msg}). Please try again.`)}`,
        },
      };
    }

    // Mirror to Key Vault for interest app compatibility. Failure
    // here is non-fatal — DB is the truth source — but log it.
    try {
      await setSecret(SECRETS.XERO_REFRESH_TOKEN, tokenSet.refresh_token);
      await setSecret(SECRETS.XERO_TENANT_ID, tenant.tenantId!);
    } catch (err) {
      context.error('Key Vault mirror write failed (non-fatal)', {
        customerId: state.customer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    context.log('OAuth complete for customer', {
      customerId: state.customer_id,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
    });

    // Redirect back to portal with success
    return {
      status: 302,
      headers: {
        Location: `${state.return_url}?connected=true&tenant=${encodeURIComponent(tenant.tenantName || '')}`,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Connect callback failed', error);

    return {
      status: 302,
      headers: {
        Location: `${fallbackReturnUrl}?error=callback_failed&error_description=${encodeURIComponent(errorMessage)}`,
      },
    };
  }
}

/**
 * GET /api/connection-status?email=...
 *
 * Real Xero token probe for the portal. Authoritative answer to
 * "is this customer's Xero connection actually usable right now?"
 *
 * Behavior:
 *   - 200 {connected: true,  tenantName} — Xero accepts our token
 *   - 200 {connected: false, reason: 'not_connected'}      — no row
 *   - 200 {connected: false, reason: 'expired'}            — Xero
 *       returned invalid_grant; orphan row + KV secret cleaned up
 *   - 200 {connected: false, reason: 'transient'}          — network
 *       blip or Xero 5xx; row left intact, retry later
 *
 * Auth: portal API key (same as /api/connect/init).
 *
 * Why this exists: the portal previously did
 * `SELECT id FROM xero.xero_connections WHERE customer_id=?` which
 * confuses "row exists" with "connection works". If an OAuth callback
 * crashed AFTER apiCallback rotated the refresh token (NULL-id INSERT,
 * DB blip, anything), the row was left holding a stale refresh token
 * Xero no longer honors — the portal kept reporting "connected" while
 * every actual API call 401'd. This endpoint closes that gap.
 */
async function connectionStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const isValidPortal = await validatePortalApiKey(request);
    if (!isValidPortal) {
      return { status: 401, jsonBody: { error: 'Invalid portal API key' } };
    }

    const email = request.query.get('email');
    if (!email) {
      return { status: 400, jsonBody: { error: 'Missing email query parameter' } };
    }

    const customer = await getCustomerByEmail(email);
    if (!customer) {
      return { status: 200, jsonBody: { connected: false, reason: 'no_customer' } };
    }

    const result = await probeConnection(customer.id);

    switch (result.status) {
      case 'connected':
        return {
          status: 200,
          jsonBody: {
            connected: true,
            tenantId: result.tenantId,
            tenantName: result.tenantName,
          },
        };
      case 'not_connected':
        return { status: 200, jsonBody: { connected: false, reason: 'not_connected' } };
      case 'expired':
        context.warn('Xero connection expired — cleaned up', {
          customerId: customer.id,
          reason: result.reason,
        });
        return { status: 200, jsonBody: { connected: false, reason: 'expired' } };
      case 'transient':
        context.warn('Xero probe transient failure — connection left intact', {
          customerId: customer.id,
          reason: result.reason,
        });
        return {
          status: 200,
          jsonBody: { connected: false, reason: 'transient', transient: true },
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('connection-status failed', error);
    return { status: 500, jsonBody: { error: errorMessage } };
  }
}

// Register endpoints
app.http('ConnectInit', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connect/init',
  handler: connectInit,
});

app.http('ConnectCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'callback',
  handler: connectCallback,
});

app.http('ConnectionStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connection-status',
  handler: connectionStatus,
});
