import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { XeroClient } from 'xero-node';
import { getSecret, SECRETS } from '../services/keyvault';
import { createLogger } from '../utils/logger';

/**
 * OAuth Start - Begin Xero Authorization Flow
 *
 * GET /api/auth/start
 *
 * Redirects user to Xero login page to authorize the app.
 */
async function authStart(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context, 'AuthStart');

  try {
    const clientId = process.env.XERO_CLIENT_ID;
    if (!clientId) {
      throw new Error('XERO_CLIENT_ID not configured');
    }

    const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);
    const baseUrl = process.env.WEBSITE_HOSTNAME
      ? `https://${process.env.WEBSITE_HOSTNAME}`
      : 'https://forit-interest-accrual.azurewebsites.net';
    const redirectUri = `${baseUrl}/api/auth/callback`;

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
    const consentUrl = await xeroClient.buildConsentUrl();

    logger.info('Redirecting to Xero authorization', { redirectUri });

    return {
      status: 302,
      headers: {
        Location: consentUrl,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start auth flow', error instanceof Error ? error : new Error(errorMessage));

    return {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html>
        <head><title>Auth Error</title></head>
        <body>
          <h1>Authorization Error</h1>
          <p>${errorMessage}</p>
        </body>
        </html>
      `,
    };
  }
}

app.http('AuthStart', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'auth/start',
  handler: authStart,
});
