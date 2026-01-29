import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { validateApiKey, checkProductAccess, getXeroConnection, updateXeroTokens } from '../services/database';
import { getSecret, SECRETS } from '../services/keyvault';
import { XeroClient } from 'xero-node';

/**
 * Power Automate Custom Connector Endpoints
 * These endpoints expose Xero operations for Power Automate flows
 */

const BASE_URL = process.env.BASE_URL || 'https://xero.forit.io';
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const PRODUCT_SLUG = 'xero-connector';

async function getXeroClient(): Promise<XeroClient> {
  if (!XERO_CLIENT_ID) {
    throw new Error('XERO_CLIENT_ID not configured');
  }
  const clientSecret = await getSecret(SECRETS.XERO_CLIENT_SECRET);
  return new XeroClient({
    clientId: XERO_CLIENT_ID,
    clientSecret,
    redirectUris: [`${BASE_URL}/api/callback`],
    scopes: ['openid', 'profile', 'email', 'accounting.transactions', 'accounting.settings', 'accounting.contacts', 'offline_access'],
  });
}

type AuthSuccess = { customerId: string; tenantId: string; accessToken: string };
type AuthResult = AuthSuccess | HttpResponseInit;

function isAuthSuccess(result: AuthResult): result is AuthSuccess {
  return 'accessToken' in result;
}

async function authenticateRequest(request: HttpRequest, context: InvocationContext): Promise<AuthResult> {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) {
    return { status: 401, jsonBody: { error: 'Missing API key' } };
  }

  const customer = await validateApiKey(apiKey);
  if (!customer) {
    return { status: 401, jsonBody: { error: 'Invalid API key' } };
  }

  const hasAccess = await checkProductAccess(customer.id, PRODUCT_SLUG);
  if (!hasAccess) {
    return { status: 403, jsonBody: { error: 'No active subscription' } };
  }

  const connection = await getXeroConnection(customer.id);
  if (!connection) {
    return { status: 404, jsonBody: { error: 'Not connected to Xero', portalUrl: 'https://forit.io/portal' } };
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

  // Refresh token if needed
  const now = Math.floor(Date.now() / 1000);
  let accessToken = connection.access_token || '';

  if (connection.expires_at && now > connection.expires_at - 300) {
    context.log('Refreshing expired token', { customerId: customer.id });
    try {
      const xeroClient = await getXeroClient();
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
      accessToken = newTokenSet.access_token || '';
    } catch (error) {
      context.error('Token refresh failed', { customerId: customer.id, error });
      return {
        status: 401,
        jsonBody: {
          error: 'Xero connection expired',
          message: 'The Xero refresh token has expired (tokens expire after 60 days of inactivity). Please re-authorize through the ForIT portal.',
          portalUrl: 'https://forit.io/portal',
        },
      };
    }
  }

  return { customerId: customer.id, tenantId: connection.tenant_id, accessToken };
}

/**
 * Delete Payment - Required to edit paid invoices
 */
async function deletePayment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const paymentId = request.params.paymentId;
    if (!paymentId) {
      return { status: 400, jsonBody: { error: 'Missing paymentId' } };
    }

    const response = await fetch(`https://api.xero.com/api.xro/2.0/Payments/${paymentId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Status: 'DELETED' }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { status: response.status, jsonBody: { error } };
    }

    return { status: 200, jsonBody: { success: true, message: 'Payment deleted' } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Set Invoice Status - Change between DRAFT and AUTHORISED
 */
async function setInvoiceStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const invoiceId = request.params.invoiceId;
    const body = await request.json() as { status: string };

    if (!invoiceId || !body.status) {
      return { status: 400, jsonBody: { error: 'Missing invoiceId or status' } };
    }

    if (!['DRAFT', 'AUTHORISED', 'SUBMITTED'].includes(body.status)) {
      return { status: 400, jsonBody: { error: 'Invalid status. Must be DRAFT, AUTHORISED, or SUBMITTED' } };
    }

    const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Status: body.status }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: unknown;
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 200, jsonBody: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Recode Invoice Line - Change account code on a line item
 */
async function recodeInvoiceLine(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const invoiceId = request.params.invoiceId;
    const body = await request.json() as { lineItemId: string; accountCode: string };

    if (!invoiceId || !body.lineItemId || !body.accountCode) {
      return { status: 400, jsonBody: { error: 'Missing invoiceId, lineItemId, or accountCode' } };
    }

    // Get current invoice
    const getResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Accept': 'application/json',
      },
    });

    const getResponseText = await getResponse.text();

    if (!getResponse.ok) {
      return { status: getResponse.status, jsonBody: { error: getResponseText } };
    }

    let invoice: { Invoices: Array<{ LineItems: Array<{ LineItemID: string; AccountCode: string }> }> };
    try {
      invoice = JSON.parse(getResponseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: getResponseText.substring(0, 500) } };
    }
    const lineItems = invoice.Invoices[0].LineItems.map(li => {
      if (li.LineItemID === body.lineItemId) {
        return { ...li, AccountCode: body.accountCode };
      }
      return li;
    });

    // Update invoice
    const updateResponse = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ LineItems: lineItems }),
    });

    const updateResponseText = await updateResponse.text();

    if (!updateResponse.ok) {
      return { status: updateResponse.status, jsonBody: { error: updateResponseText } };
    }

    let result: unknown;
    try {
      result = JSON.parse(updateResponseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: updateResponseText.substring(0, 500) } };
    }
    return { status: 200, jsonBody: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Get Invoice Details
 */
async function getInvoice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const invoiceId = request.params.invoiceId;
    if (!invoiceId) {
      return { status: 400, jsonBody: { error: 'Missing invoiceId' } };
    }

    const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Accept': 'application/json',
      },
    });

    const responseText = await response.text();

    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: unknown;
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 200, jsonBody: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Get Invoice Payments
 */
async function getInvoicePayments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const invoiceId = request.params.invoiceId;
    if (!invoiceId) {
      return { status: 400, jsonBody: { error: 'Missing invoiceId' } };
    }

    const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`, {
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
      },
    });

    const responseText = await response.text();

    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let invoice: { Invoices: Array<{ Payments: Array<unknown> }> };
    try {
      invoice = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 200, jsonBody: { payments: invoice.Invoices[0].Payments || [] } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Search Contacts by Email
 */
async function searchContacts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const email = request.query.get('email');
    const where = email ? `EmailAddress!=null AND EmailAddress.Contains("${email}")` : undefined;

    const url = new URL('https://api.xero.com/api.xro/2.0/Contacts');
    if (where) url.searchParams.set('where', where);

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Accept': 'application/json',
      },
    });

    const responseText = await response.text();
    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    // Parse JSON with error handling
    let result: { Contacts: Array<{ ContactID: string; Name: string; EmailAddress: string }> };
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 200, jsonBody: { contacts: result.Contacts } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Create Contact
 */
async function createContact(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const body = await request.json() as { Name: string; EmailAddress?: string; FirstName?: string; LastName?: string };

    if (!body.Name) {
      return { status: 400, jsonBody: { error: 'Missing Name' } };
    }

    const response = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Name: body.Name, EmailAddress: body.EmailAddress, FirstName: body.FirstName, LastName: body.LastName }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: { Contacts: Array<{ ContactID: string }> };
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 201, jsonBody: result.Contacts[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Create Invoice
 */
async function createInvoice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const body = await request.json() as {
      Type: 'ACCREC' | 'ACCPAY';
      Contact: { ContactID: string };
      LineItems: Array<{ Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType?: string }>;
      Status?: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED';
      Reference?: string;
      CurrencyCode?: string;
      DueDate?: string;
      LineAmountTypes?: 'Exclusive' | 'Inclusive' | 'NoTax';
    };

    if (!body.Type || !body.Contact?.ContactID || !body.LineItems?.length) {
      return { status: 400, jsonBody: { error: 'Missing Type, Contact.ContactID, or LineItems' } };
    }

    // Default due date to 30 days from now if not specified
    const dueDate = body.DueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Add TaxType to line items if not specified
    const lineItems = body.LineItems.map(li => ({
      ...li,
      TaxType: li.TaxType || 'NONE',
    }));

    const invoice = {
      Type: body.Type,
      Contact: body.Contact,
      LineItems: lineItems,
      Status: body.Status || 'DRAFT',
      Reference: body.Reference,
      CurrencyCode: body.CurrencyCode || 'USD',
      DueDate: dueDate,
      LineAmountTypes: body.LineAmountTypes || 'NoTax',
    };

    const response = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(invoice),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: { Invoices: Array<{ InvoiceID: string }> };
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 201, jsonBody: result.Invoices[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * List Accounts
 */
async function listAccounts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const type = request.query.get('type') || 'REVENUE';

    const response = await fetch('https://api.xero.com/api.xro/2.0/Accounts', {
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Accept': 'application/json',
      },
    });

    const responseText = await response.text();
    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: { Accounts: Array<{ Code: string; Name: string; Type: string }> };
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }

    const filtered = type === 'ALL' ? result.Accounts : result.Accounts.filter(a => a.Type === type);
    return { status: 200, jsonBody: { accounts: filtered.map(a => ({ Code: a.Code, Name: a.Name, Type: a.Type })) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Create Payment
 * Supports both Xero-style format (Invoice.InvoiceID, Account.Code) and simple format (invoiceId, accountId)
 */
async function createPayment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const auth = await authenticateRequest(request, context);
    if (!isAuthSuccess(auth)) return auth;

    const body = await request.json() as {
      // Xero-style format (from Power Automate flow)
      Invoice?: { InvoiceID: string };
      Account?: { Code?: string; AccountID?: string };
      Amount?: number;
      Date?: string;
      Reference?: string;
      // Simple format (legacy)
      invoiceId?: string;
      accountId?: string;
      amount?: number;
      date?: string;
    };

    // Support both formats
    const invoiceId = body.Invoice?.InvoiceID || body.invoiceId;
    const accountCode = body.Account?.Code;
    const accountId = body.Account?.AccountID || body.accountId;
    const amount = body.Amount ?? body.amount;
    const date = body.Date || body.date || new Date().toISOString().split('T')[0];
    const reference = body.Reference;

    if (!invoiceId || (!accountCode && !accountId) || amount === undefined) {
      return { status: 400, jsonBody: { error: 'Missing Invoice/invoiceId, Account/accountId, or Amount/amount' } };
    }

    const payment: Record<string, unknown> = {
      Invoice: { InvoiceID: invoiceId },
      Amount: amount,
      Date: date,
    };

    // Use Code if provided, otherwise use AccountID
    if (accountCode) {
      payment.Account = { Code: accountCode };
    } else {
      payment.Account = { AccountID: accountId };
    }

    if (reference) {
      payment.Reference = reference;
    }

    const response = await fetch('https://api.xero.com/api.xro/2.0/Payments', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${auth.accessToken}`,
        'Xero-Tenant-Id': auth.tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payment),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return { status: response.status, jsonBody: { error: responseText } };
    }

    let result: { Payments: Array<{ PaymentID: string }> };
    try {
      result = JSON.parse(responseText);
    } catch {
      return { status: 500, jsonBody: { error: 'Invalid JSON from Xero', raw: responseText.substring(0, 500) } };
    }
    return { status: 201, jsonBody: result.Payments[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, jsonBody: { error: message } };
  }
}

/**
 * Serve OpenAPI/Swagger definition for Power Automate
 */
async function getApiDefinition(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const swagger = {
    swagger: '2.0',
    info: {
      title: 'ForIT Xero Connector',
      description: 'Advanced Xero operations for Power Automate - delete payments, recode invoices, change status',
      version: '1.0.0',
      contact: { name: 'ForIT', url: 'https://forit.io' },
    },
    host: 'xero.forit.io',
    basePath: '/api/connector',
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    securityDefinitions: {
      apiKey: {
        type: 'apiKey',
        name: 'x-api-key',
        in: 'header',
        description: 'API key from ForIT Portal (https://forit.io/portal)',
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      '/contacts': {
        get: {
          operationId: 'SearchContacts',
          summary: 'Search contacts by email',
          parameters: [{ name: 'email', in: 'query', required: false, type: 'string', description: 'Email to search for' }],
          responses: { '200': { description: 'List of contacts' } },
        },
        post: {
          operationId: 'CreateContact',
          summary: 'Create a new contact',
          parameters: [
            { name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { Name: { type: 'string' }, EmailAddress: { type: 'string' }, FirstName: { type: 'string' }, LastName: { type: 'string' } }, required: ['Name'] } },
          ],
          responses: { '201': { description: 'Contact created' } },
        },
      },
      '/accounts': {
        get: {
          operationId: 'ListAccounts',
          summary: 'List chart of accounts',
          parameters: [{ name: 'type', in: 'query', required: false, type: 'string', description: 'Account type filter (REVENUE, EXPENSE, BANK, etc. or ALL)' }],
          responses: { '200': { description: 'List of accounts' } },
        },
      },
      '/invoices': {
        post: {
          operationId: 'CreateInvoice',
          summary: 'Create a new invoice',
          parameters: [
            { name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { Type: { type: 'string', enum: ['ACCREC', 'ACCPAY'] }, Contact: { type: 'object', properties: { ContactID: { type: 'string' } } }, LineItems: { type: 'array', items: { type: 'object', properties: { Description: { type: 'string' }, Quantity: { type: 'number' }, UnitAmount: { type: 'number' }, AccountCode: { type: 'string' } } } }, Status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED'] }, Reference: { type: 'string' }, CurrencyCode: { type: 'string' }, DueDate: { type: 'string' } }, required: ['Type', 'Contact', 'LineItems'] } },
          ],
          responses: { '201': { description: 'Invoice created' } },
        },
      },
      '/invoices/{invoiceId}': {
        get: {
          operationId: 'GetInvoice',
          summary: 'Get invoice details',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, type: 'string' }],
          responses: { '200': { description: 'Invoice details' } },
        },
      },
      '/invoices/{invoiceId}/payments': {
        get: {
          operationId: 'GetInvoicePayments',
          summary: 'Get payments for an invoice',
          parameters: [{ name: 'invoiceId', in: 'path', required: true, type: 'string' }],
          responses: { '200': { description: 'List of payments' } },
        },
      },
      '/invoices/{invoiceId}/status': {
        post: {
          operationId: 'SetInvoiceStatus',
          summary: 'Change invoice status (DRAFT, AUTHORISED, SUBMITTED)',
          parameters: [
            { name: 'invoiceId', in: 'path', required: true, type: 'string' },
            { name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { status: { type: 'string', enum: ['DRAFT', 'AUTHORISED', 'SUBMITTED'] } }, required: ['status'] } },
          ],
          responses: { '200': { description: 'Updated invoice' } },
        },
      },
      '/invoices/{invoiceId}/recode': {
        post: {
          operationId: 'RecodeInvoiceLine',
          summary: 'Change account code on a line item',
          parameters: [
            { name: 'invoiceId', in: 'path', required: true, type: 'string' },
            { name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { lineItemId: { type: 'string' }, accountCode: { type: 'string' } }, required: ['lineItemId', 'accountCode'] } },
          ],
          responses: { '200': { description: 'Updated invoice' } },
        },
      },
      '/payments/{paymentId}': {
        delete: {
          operationId: 'DeletePayment',
          summary: 'Delete a payment (required to edit paid invoices)',
          parameters: [{ name: 'paymentId', in: 'path', required: true, type: 'string' }],
          responses: { '200': { description: 'Payment deleted' } },
        },
      },
      '/payments': {
        post: {
          operationId: 'CreatePayment',
          summary: 'Create a payment for an invoice',
          parameters: [
            { name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { Invoice: { type: 'object', properties: { InvoiceID: { type: 'string' } } }, Account: { type: 'object', properties: { Code: { type: 'string' } } }, Amount: { type: 'number' }, Date: { type: 'string' }, Reference: { type: 'string' } }, required: ['Invoice', 'Account', 'Amount'] } },
          ],
          responses: { '201': { description: 'Payment created' } },
        },
      },
    },
  };

  return { status: 200, jsonBody: swagger };
}

// Register Power Automate connector endpoints
app.http('ConnectorApiDefinition', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connector/apiDefinition.swagger.json',
  handler: getApiDefinition,
});

app.http('ConnectorGetInvoice', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connector/invoices/{invoiceId}',
  handler: getInvoice,
});

app.http('ConnectorGetInvoicePayments', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connector/invoices/{invoiceId}/payments',
  handler: getInvoicePayments,
});

app.http('ConnectorSetInvoiceStatus', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connector/invoices/{invoiceId}/status',
  handler: setInvoiceStatus,
});

app.http('ConnectorRecodeInvoiceLine', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connector/invoices/{invoiceId}/recode',
  handler: recodeInvoiceLine,
});

app.http('ConnectorDeletePayment', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'connector/payments/{paymentId}',
  handler: deletePayment,
});

app.http('ConnectorCreatePayment', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connector/payments',
  handler: createPayment,
});

app.http('ConnectorListAccounts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connector/accounts',
  handler: listAccounts,
});

app.http('ConnectorSearchContacts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'connector/contacts',
  handler: searchContacts,
});

app.http('ConnectorCreateContact', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connector/contacts',
  handler: createContact,
});

app.http('ConnectorCreateInvoice', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'connector/invoices',
  handler: createInvoice,
});
