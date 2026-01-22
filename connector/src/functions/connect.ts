import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { XeroClient } from 'xero-node';
import { getSecret, setSecret, SECRETS } from '../services/keyvault';
import { getCustomerByEmail, saveXeroConnection } from '../services/database';

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
  try {
    const code = request.query.get('code');
    const stateParam = request.query.get('state');
    const error = request.query.get('error');

    // Handle Xero error
    if (error) {
      const errorDescription = request.query.get('error_description') || 'Unknown error';
      context.error('Xero OAuth error', { error, errorDescription });

      // Try to redirect back to portal with error
      const state = stateParam ? decodeState(stateParam) : null;
      const returnUrl = state?.return_url || 'https://forit.io/portal';

      return {
        status: 302,
        headers: {
          Location: `${returnUrl}?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription)}`,
        },
      };
    }

    if (!code || !stateParam) {
      return {
        status: 400,
        jsonBody: { error: 'Missing code or state parameter' },
      };
    }

    // Decode and validate state
    const state = decodeState(stateParam);
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

    // Save connection to database
    await saveXeroConnection(
      state.customer_id,
      tenant.tenantId!,
      tenant.tenantName || 'Unknown Organization',
      tokenSet.access_token,
      tokenSet.refresh_token,
      tokenSet.expires_at || Math.floor(Date.now() / 1000) + 1800
    );

    // Also save to Key Vault for interest app compatibility
    await setSecret(SECRETS.XERO_REFRESH_TOKEN, tokenSet.refresh_token);
    await setSecret(SECRETS.XERO_TENANT_ID, tenant.tenantId!);

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

    // Try to redirect with error
    return {
      status: 302,
      headers: {
        Location: `https://forit.io/portal?error=callback_failed&error_description=${encodeURIComponent(errorMessage)}`,
      },
    };
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
