import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { XeroClient } from 'xero-node';
import { getSecret, setSecret, SECRETS } from '../services/keyvault';
import {
  validateApiKey,
  getXeroConnection,
  updateXeroTokens,
} from '../services/database';

/**
 * ForIT Xero Connector - MCP Token Endpoint
 * Public signup has been moved to the ForIT portal.
 */

const BASE_URL = process.env.BASE_URL || 'https://xero.forit.io';
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;

async function getXeroClient(includeSecret = false, state?: string): Promise<XeroClient> {
  if (!XERO_CLIENT_ID) {
    throw new Error('XERO_CLIENT_ID not configured');
  }

  const clientSecret = includeSecret
    ? await getSecret(SECRETS.XERO_CLIENT_SECRET)
    : 'placeholder';

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
    state: state || 'default-state',
  });
}

/**
 * Disabled Endpoint Handler - Public signup has been moved to portal
 */
async function disabledEndpoint(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: {
      error: 'This endpoint has been disabled',
      message: 'Public signup has been moved to the ForIT portal. Contact support@forit.io for access.',
    },
  };
}

/**
 * MCP Token Endpoint - Simple API key validation
 */
async function mcpGetTokens(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) {
      return { status: 401, jsonBody: { error: 'Missing API key' } };
    }

    const customer = await validateApiKey(apiKey);
    if (!customer) {
      return { status: 401, jsonBody: { error: 'Invalid API key' } };
    }

    const connection = await getXeroConnection(customer.id);
    if (!connection) {
      return {
        status: 404,
        jsonBody: { error: 'Not connected to Xero. Contact support@forit.io for access.' },
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (connection.expires_at && now > connection.expires_at - 300) {
      context.log('Refreshing expired token', { customerId: customer.id });

      const xeroClient = await getXeroClient(true);
      await xeroClient.initialize();
      xeroClient.setTokenSet({
        refresh_token: connection.refresh_token,
        access_token: connection.access_token,
        expires_at: connection.expires_at,
      });

      const newTokenSet = await xeroClient.refreshToken();

      await updateXeroTokens(
        customer.id,
        newTokenSet.access_token || '',
        newTokenSet.refresh_token || connection.refresh_token || '',
        newTokenSet.expires_at || 0
      );

      // Also update Key Vault for interest app
      if (newTokenSet.refresh_token) {
        await setSecret(SECRETS.XERO_REFRESH_TOKEN, newTokenSet.refresh_token);
      }

      return {
        status: 200,
        jsonBody: {
          access_token: newTokenSet.access_token,
          refresh_token: newTokenSet.refresh_token,
          tenant_id: connection.tenant_id,
          expires_at: newTokenSet.expires_at,
        },
      };
    }

    return {
      status: 200,
      jsonBody: {
        access_token: connection.access_token,
        refresh_token: connection.refresh_token,
        tenant_id: connection.tenant_id,
        expires_at: connection.expires_at,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.error('Failed to get tokens', error);

    return {
      status: 500,
      jsonBody: { error: errorMessage },
    };
  }
}

// Register endpoints

// Disabled public signup endpoints - return 410 Gone
app.http('Signup', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'signup',
  handler: disabledEndpoint,
});

app.http('AuthCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'callback',
  handler: disabledEndpoint,
});

app.http('GenerateNewKey', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'keys/new',
  handler: disabledEndpoint,
});

// Active endpoint - protected by API key
app.http('GetTokens', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'tokens',
  handler: mcpGetTokens,
});
