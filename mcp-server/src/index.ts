#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = 'https://xero.forit.io/api/connector';
const API_KEY = process.env.FORIT_XERO_API_KEY;

if (!API_KEY) {
  console.error('FORIT_XERO_API_KEY environment variable is required');
  process.exit(1);
}

async function xeroRequest(method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const url = `${API_BASE}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      'x-api-key': API_KEY!,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Xero API error ${response.status}: ${error}`);
  }

  return response.json();
}

const server = new Server(
  { name: 'forit-xero', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'xero',
      description: `Make any request to the Xero API via ForIT connector.

Base URL: ${API_BASE}

Available endpoints:
- GET /invoices/{id} - Get invoice details
- GET /invoices/{id}/payments - Get invoice payments
- POST /invoices/{id}/status - Change status (body: {status: "DRAFT"|"SUBMITTED"|"AUTHORISED"})
- POST /invoices/{id}/recode - Recode line items (body: {lineItems: [{lineItemId, accountCode}]})
- POST /invoices - Create invoice (body: {contactId, lineItems: [{description, quantity, unitAmount, accountCode}], ...})
- GET /contacts?email={email} - Search contacts by email
- POST /contacts - Create contact (body: {name, email, firstName, lastName})
- GET /accounts - List chart of accounts
- GET /accounts?type={type} - Filter accounts by type
- POST /payments - Create payment (body: {invoiceId, accountId, amount, date})
- DELETE /payments/{id} - Delete payment`,
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE'],
            description: 'HTTP method',
          },
          endpoint: {
            type: 'string',
            description: 'API endpoint path (e.g., /invoices/INV-0001)',
          },
          body: {
            type: 'object',
            description: 'Request body for POST/PUT requests',
          },
        },
        required: ['method', 'endpoint'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  if (name !== 'xero') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const method = String(a.method || 'GET');
    const endpoint = String(a.endpoint || '/');
    const body = a.body;

    const result = await xeroRequest(method, endpoint, body);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
