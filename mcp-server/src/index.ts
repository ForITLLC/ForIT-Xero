#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = 'https://xero.forit.io/api/connector';
const API_KEY = process.env.FORIT_XERO_API_KEY;

if (!API_KEY) {
  console.error('FORIT_XERO_API_KEY environment variable required');
  process.exit(1);
}

async function xeroRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'x-api-key': API_KEY!,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Xero API error (${response.status}): ${error}`);
  }

  return response.json();
}

const server = new Server(
  {
    name: 'forit-xero',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_invoice',
      description: 'Get invoice details by ID or invoice number',
      inputSchema: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string', description: 'Invoice ID or number (e.g., INV-0001)' },
        },
        required: ['invoiceId'],
      },
    },
    {
      name: 'get_invoice_payments',
      description: 'Get all payments for an invoice',
      inputSchema: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string', description: 'Invoice ID or number' },
        },
        required: ['invoiceId'],
      },
    },
    {
      name: 'set_invoice_status',
      description: 'Change invoice status (DRAFT, SUBMITTED, AUTHORISED, DELETED, VOIDED)',
      inputSchema: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string', description: 'Invoice ID or number' },
          status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED', 'DELETED', 'VOIDED'] },
        },
        required: ['invoiceId', 'status'],
      },
    },
    {
      name: 'recode_invoice',
      description: 'Recode invoice line items to different accounts',
      inputSchema: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string', description: 'Invoice ID or number' },
          lineItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                LineItemID: { type: 'string' },
                AccountCode: { type: 'string' },
              },
            },
            description: 'Line items with new account codes',
          },
        },
        required: ['invoiceId', 'lineItems'],
      },
    },
    {
      name: 'create_invoice',
      description: 'Create a new invoice',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['ACCREC', 'ACCPAY'], description: 'ACCREC=Sales, ACCPAY=Bills' },
          contactId: { type: 'string', description: 'Contact ID' },
          lineItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                Description: { type: 'string' },
                Quantity: { type: 'number' },
                UnitAmount: { type: 'number' },
                AccountCode: { type: 'string' },
              },
            },
          },
          reference: { type: 'string', description: 'Optional reference' },
          dueDate: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
          status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'AUTHORISED'], default: 'DRAFT' },
        },
        required: ['type', 'contactId', 'lineItems'],
      },
    },
    {
      name: 'search_contacts',
      description: 'Search contacts by email',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address to search' },
        },
        required: ['email'],
      },
    },
    {
      name: 'create_contact',
      description: 'Create a new contact',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Contact/company name' },
          email: { type: 'string', description: 'Email address' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_accounts',
      description: 'List chart of accounts, optionally filtered by type',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Account type: REVENUE, EXPENSE, BANK, ASSET, LIABILITY, EQUITY, or ALL' },
        },
      },
    },
    {
      name: 'create_payment',
      description: 'Create a payment against an invoice',
      inputSchema: {
        type: 'object',
        properties: {
          invoiceId: { type: 'string', description: 'Invoice ID' },
          accountId: { type: 'string', description: 'Bank account ID' },
          amount: { type: 'number', description: 'Payment amount' },
          date: { type: 'string', description: 'Payment date (YYYY-MM-DD)' },
          reference: { type: 'string', description: 'Payment reference' },
        },
        required: ['invoiceId', 'accountId', 'amount'],
      },
    },
    {
      name: 'delete_payment',
      description: 'Delete a payment',
      inputSchema: {
        type: 'object',
        properties: {
          paymentId: { type: 'string', description: 'Payment ID' },
        },
        required: ['paymentId'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {
      case 'get_invoice':
        result = await xeroRequest('GET', `/invoices/${a.invoiceId}`);
        break;

      case 'get_invoice_payments':
        result = await xeroRequest('GET', `/invoices/${a.invoiceId}/payments`);
        break;

      case 'set_invoice_status':
        result = await xeroRequest('POST', `/invoices/${a.invoiceId}/status`, { status: a.status });
        break;

      case 'recode_invoice':
        result = await xeroRequest('POST', `/invoices/${a.invoiceId}/recode`, { lineItems: a.lineItems });
        break;

      case 'create_invoice':
        result = await xeroRequest('POST', '/invoices', {
          Type: a.type,
          Contact: { ContactID: a.contactId },
          LineItems: a.lineItems,
          Reference: a.reference,
          DueDate: a.dueDate,
          Status: a.status || 'DRAFT',
        });
        break;

      case 'search_contacts':
        result = await xeroRequest('GET', `/contacts?email=${encodeURIComponent(String(a.email))}`);
        break;

      case 'create_contact':
        result = await xeroRequest('POST', '/contacts', {
          Name: a.name,
          EmailAddress: a.email,
          FirstName: a.firstName,
          LastName: a.lastName,
        });
        break;

      case 'list_accounts':
        result = await xeroRequest('GET', a.type ? `/accounts?type=${a.type}` : '/accounts');
        break;

      case 'create_payment':
        result = await xeroRequest('POST', '/payments', {
          Invoice: { InvoiceID: a.invoiceId },
          Account: { AccountID: a.accountId },
          Amount: a.amount,
          Date: a.date || new Date().toISOString().split('T')[0],
          Reference: a.reference,
        });
        break;

      case 'delete_payment':
        result = await xeroRequest('DELETE', `/payments/${a.paymentId}`);
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ForIT Xero MCP server running');
}

main().catch(console.error);
