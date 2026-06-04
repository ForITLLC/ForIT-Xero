import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { validateApiKey, getXeroConnection } from '../services/database';
import { refreshAndPersist } from '../services/xeroConnection';

/**
 * ForIT Xero Connector - MCP Token Endpoint
 * Public signup has been moved to the ForIT portal.
 */

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
        jsonBody: { error: 'Not connected to Xero', portalUrl: 'https://forit.io/portal' },
      };
    }

    if (!connection.tenant_id) {
      return {
        status: 400,
        jsonBody: {
          error: 'Xero connection incomplete',
          message: 'No Xero organization selected. Please re-authorize through the ForIT portal.',
          portalUrl: 'https://forit.io/portal',
        },
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (connection.expires_at && now > connection.expires_at - 300) {
      context.log('Refreshing expired token', { customerId: customer.id });
      const refreshed = await refreshAndPersist(customer.id);
      if (refreshed.status === 'connected') {
        return {
          status: 200,
          jsonBody: {
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken,
            tenant_id: refreshed.tenantId,
            expires_at: refreshed.expiresAt,
          },
        };
      }
      if (refreshed.status === 'expired') {
        // refreshAndPersist already deleted the orphan row + KV secret.
        context.warn('Xero refresh returned invalid_grant — connection cleaned up', { customerId: customer.id });
        return {
          status: 401,
          jsonBody: {
            error: 'Xero connection expired',
            message: 'The Xero refresh token is no longer valid. Please re-authorize through the ForIT portal.',
            portalUrl: 'https://forit.io/portal',
          },
        };
      }
      // transient — leave the row alone, surface 503
      context.error('Xero refresh transient failure', { customerId: customer.id, reason: refreshed.status === 'transient' ? refreshed.reason : 'unknown' });
      return {
        status: 503,
        jsonBody: {
          error: 'Xero refresh temporarily unavailable',
          message: 'Please retry shortly.',
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

// Callback route is now handled by connect.ts

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
