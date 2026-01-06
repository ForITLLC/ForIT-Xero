import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { XeroClient } from 'xero-node';
import { setSecret, SECRETS } from '../services/keyvault';
import { createLogger } from '../utils/logger';

/**
 * OAuth Callback - Handle Xero OAuth Authorization
 *
 * GET /api/auth/callback?code=xxx&state=xxx
 *
 * This is called by Xero after the user authorizes the app.
 * It exchanges the authorization code for tokens and stores them.
 *
 * INITIAL SETUP ONLY - run once to get refresh token, then
 * the timer functions will use the refresh token.
 */
async function authCallback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'AuthCallback');

  try {
    const code = request.query.get('code');
    const state = request.query.get('state');

    if (!code) {
      return {
        status: 400,
        body: 'Missing authorization code',
      };
    }

    logger.info('Received OAuth callback', { hasCode: !!code, state });

    const clientId = process.env.XERO_CLIENT_ID;
    if (!clientId) {
      throw new Error('XERO_CLIENT_ID not configured');
    }

    // Get client secret from Key Vault
    const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);

    const redirectUri = `${process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : 'https://forit-interest-accrual.azurewebsites.net'}/api/auth/callback`;

    const xeroClient = new XeroClient({
      clientId,
      clientSecret,
      redirectUris: [redirectUri],
      scopes: [
        'openid',
        'profile',
        'email',
        'accounting.transactions',
        'accounting.transactions.read',
        'accounting.contacts.read',
        'accounting.settings.read',
        'offline_access',
      ],
    });

    await xeroClient.initialize();

    // Exchange code for tokens
    const tokenSet = await xeroClient.apiCallback(request.url);

    if (!tokenSet.refresh_token) {
      throw new Error('No refresh token received');
    }

    // Get the tenant ID
    await xeroClient.updateTenants();
    const tenants = xeroClient.tenants;

    if (tenants.length === 0) {
      throw new Error('No Xero tenants found');
    }

    // Use the first tenant (or you could let user choose)
    const tenantId = tenants[0].tenantId;
    const tenantName = tenants[0].tenantName;

    // Extract user email from ID token claims (OIDC)
    const idTokenClaims = tokenSet.claims?.() || {};
    const userEmail = idTokenClaims.email as string | undefined;
    const userName = idTokenClaims.name as string | undefined || idTokenClaims.given_name as string | undefined;

    // Store tokens and user info in Key Vault
    await setSecret(SECRETS.XERO_REFRESH_TOKEN, tokenSet.refresh_token);
    await setSecret(SECRETS.XERO_TENANT_ID, tenantId);

    // Store authorizing user's email for failure notifications
    if (userEmail) {
      await setSecret(SECRETS.NOTIFICATION_EMAIL, userEmail);
      logger.info('Stored notification email from Xero user', { email: userEmail });
    }

    logger.info('OAuth setup complete', {
      tenantId,
      tenantName,
      userEmail,
      userName,
      expiresAt: tokenSet.expires_at,
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Xero Authorization Complete</title>
          <style>
            body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .success { color: #22c55e; }
            .info { background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .warning { background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; }
            code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }
          </style>
        </head>
        <body>
          <h1 class="success">✓ Xero Authorization Complete</h1>
          <div class="info">
            <p><strong>Tenant:</strong> ${tenantName}</p>
            <p><strong>Tenant ID:</strong> <code>${tenantId}</code></p>
            ${userEmail ? `<p><strong>Notifications:</strong> ${userEmail}</p>` : ''}
          </div>
          ${userEmail
            ? `<p>Failure alerts will be sent to <strong>${userEmail}</strong>. If the connection expires, you'll receive an email with instructions to re-authorize.</p>`
            : `<div class="warning"><p><strong>Warning:</strong> Could not retrieve your email from Xero. Failure notifications may not work correctly.</p></div>`
          }
          <p>You can close this window.</p>
        </body>
        </html>
      `,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('OAuth callback failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authorization Failed</title>
          <style>
            body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .error { color: #ef4444; }
            .info { background: #fef2f2; padding: 15px; border-radius: 8px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1 class="error">✗ Authorization Failed</h1>
          <div class="info">
            <p><strong>Error:</strong> ${errorMessage}</p>
          </div>
          <p>Please try again or contact support.</p>
        </body>
        </html>
      `,
    };
  }
}

// Helper to get secret (imported function has same name issue)
async function getSecret(secretName: string): Promise<string> {
  const { getSecret: getSecretFromKV } = await import('../services/keyvault');
  return getSecretFromKV(secretName);
}

/**
 * Auth Start - Initiate Xero OAuth Flow
 *
 * GET /api/auth/start
 *
 * Redirects the user to Xero to authorize the app.
 */
async function authStart(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'AuthStart');

  try {
    const clientId = process.env.XERO_CLIENT_ID;
    if (!clientId) {
      throw new Error('XERO_CLIENT_ID not configured');
    }

    const redirectUri = `${process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : 'https://forit-interest-accrual.azurewebsites.net'}/api/auth/callback`;

    const xeroClient = new XeroClient({
      clientId,
      clientSecret: 'placeholder', // Not needed for auth URL
      redirectUris: [redirectUri],
      scopes: [
        'openid',
        'profile',
        'email',
        'accounting.transactions',
        'accounting.transactions.read',
        'accounting.contacts.read',
        'accounting.settings.read',
        'offline_access',
      ],
    });

    await xeroClient.initialize();
    const authUrl = await xeroClient.buildConsentUrl();

    logger.info('Redirecting to Xero for authorization');

    return {
      status: 302,
      headers: {
        Location: authUrl,
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Auth start failed', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      body: `Failed to start authorization: ${errorMessage}`,
    };
  }
}

app.http('AuthCallback', {
  methods: ['GET'],
  authLevel: 'anonymous', // Must be anonymous for OAuth callback
  route: 'auth/callback',
  handler: authCallback,
});

app.http('AuthStart', {
  methods: ['GET'],
  authLevel: 'anonymous', // Needs to be accessible to start flow
  route: 'auth/start',
  handler: authStart,
});
