import { EmailClient } from '@azure/communication-email';
import { getSecret, SECRETS } from './keyvault';

let emailClient: EmailClient | null = null;

/**
 * Get or create the Azure Communication Services Email client
 */
function getEmailClient(): EmailClient {
  if (!emailClient) {
    const connectionString = process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error('AZURE_COMMUNICATION_CONNECTION_STRING not configured');
    }
    emailClient = new EmailClient(connectionString);
  }
  return emailClient;
}

/**
 * Send a failure notification to the user who authorized Xero
 */
export async function sendFailureNotification(
  functionName: string,
  error: Error,
  context?: Record<string, unknown>
): Promise<boolean> {
  try {
    // Get notification email from Key Vault (set during Xero auth)
    let recipientEmail: string;
    try {
      recipientEmail = await getSecret(SECRETS.NOTIFICATION_EMAIL);
    } catch {
      console.error('No notification email configured - skipping alert');
      return false;
    }

    const senderEmail = process.env.NOTIFICATION_SENDER_EMAIL;
    if (!senderEmail) {
      console.error('NOTIFICATION_SENDER_EMAIL not configured - skipping alert');
      return false;
    }

    const appUrl = process.env.WEBSITE_HOSTNAME
      ? `https://${process.env.WEBSITE_HOSTNAME}`
      : 'https://your-function-app.azurewebsites.net';

    const client = getEmailClient();

    const message = {
      senderAddress: senderEmail,
      recipients: {
        to: [{ address: recipientEmail }],
      },
      content: {
        subject: `Interest Accrual Failed: ${functionName}`,
        html: `
          <html>
          <body style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #dc2626;">Interest Accrual Function Failed</h2>

            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Function:</strong> ${functionName}</p>
              <p style="margin: 8px 0 0;"><strong>Error:</strong> ${error.message}</p>
              ${context ? `<p style="margin: 8px 0 0;"><strong>Context:</strong> ${JSON.stringify(context)}</p>` : ''}
            </div>

            <h3>Likely Cause: Xero Token Expired</h3>
            <p>Xero access tokens expire every 30 minutes and refresh tokens can expire if not used for 60 days.</p>

            <div style="margin: 24px 0;">
              <a href="${appUrl}/api/auth/start"
                 style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Re-authorize Xero Connection
              </a>
            </div>

            <p style="color: #6b7280; font-size: 14px;">
              This is an automated message from the Interest Accrual system.
            </p>
          </body>
          </html>
        `,
        plainText: `
Interest Accrual Function Failed

Function: ${functionName}
Error: ${error.message}
${context ? `Context: ${JSON.stringify(context)}` : ''}

Likely Cause: Xero Token Expired

Xero access tokens expire every 30 minutes and refresh tokens can expire if not used for 60 days.

Re-authorize at: ${appUrl}/api/auth/start
        `.trim(),
      },
    };

    const poller = await client.beginSend(message);
    await poller.pollUntilDone();

    console.log(`Failure notification sent to ${recipientEmail}`);
    return true;

  } catch (notifyError) {
    console.error('Failed to send notification:', notifyError);
    return false;
  }
}

/**
 * Wrapper to execute a function with automatic failure notifications
 */
export async function withFailureNotification<T>(
  functionName: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Send notification (don't await - fire and forget to not delay response)
    sendFailureNotification(functionName, err, context).catch(() => {});

    throw error;
  }
}
