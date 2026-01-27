import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

/**
 * MCP Configuration Endpoint
 * Returns setup instructions and config for Claude Desktop / MCP clients
 */
async function getMcpConfig(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const apiKey = request.query.get('apiKey') || 'YOUR_API_KEY';

  const config = {
    name: 'forit-xero',
    description: 'ForIT Xero Connector - Access Xero invoices, payments, contacts via API',
    version: '1.0.0',

    // Claude Desktop config (add to claude_desktop_config.json)
    claude_desktop_config: {
      mcpServers: {
        'forit-xero': {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-fetch'],
          env: {
            MCP_FETCH_BASE_URL: 'https://xero.forit.io/api/connector',
            MCP_FETCH_HEADERS: JSON.stringify({
              'x-api-key': apiKey,
              'Content-Type': 'application/json'
            })
          }
        }
      }
    },

    // Available endpoints
    endpoints: {
      base_url: 'https://xero.forit.io/api/connector',
      authentication: {
        header: 'x-api-key',
        value: apiKey
      },
      operations: [
        { method: 'GET', path: '/invoices/{invoiceId}', description: 'Get invoice details' },
        { method: 'GET', path: '/invoices/{invoiceId}/payments', description: 'Get invoice payments' },
        { method: 'POST', path: '/invoices/{invoiceId}/status', description: 'Change invoice status', body: '{"status": "AUTHORISED|DRAFT|SUBMITTED"}' },
        { method: 'POST', path: '/invoices/{invoiceId}/recode', description: 'Recode line items', body: '{"lineItems": [...]}' },
        { method: 'GET', path: '/contacts?email={email}', description: 'Search contacts by email' },
        { method: 'POST', path: '/contacts', description: 'Create contact', body: '{"Name": "...", "EmailAddress": "..."}' },
        { method: 'GET', path: '/accounts?type={type}', description: 'List chart of accounts' },
        { method: 'POST', path: '/payments', description: 'Create payment' },
        { method: 'DELETE', path: '/payments/{paymentId}', description: 'Delete payment' },
        { method: 'POST', path: '/invoices', description: 'Create invoice' }
      ]
    },

    // Setup instructions
    setup: {
      step1: 'Generate an API key at https://forit.io/portal/xero-connector',
      step2: 'Connect your Xero organization',
      step3: 'Copy the claude_desktop_config above to your Claude Desktop config file',
      step4: 'Restart Claude Desktop',
      config_locations: {
        macos: '~/Library/Application Support/Claude/claude_desktop_config.json',
        windows: '%APPDATA%\\Claude\\claude_desktop_config.json'
      }
    }
  };

  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    jsonBody: config
  };
}

/**
 * MCP Setup Page (HTML)
 * User-friendly setup instructions
 */
async function getMcpSetupPage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const apiKey = request.query.get('apiKey') || 'YOUR_API_KEY';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>ForIT Xero MCP Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    .card { background: white; border-radius: 8px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { color: #1a365d; }
    h2 { color: #2d3748; margin-top: 0; }
    pre { background: #1a202c; color: #68d391; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 14px; }
    code { background: #edf2f7; padding: 2px 6px; border-radius: 4px; font-size: 14px; }
    .step { display: flex; gap: 12px; margin-bottom: 16px; }
    .step-num { background: #3182ce; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0; }
    .copy-btn { background: #3182ce; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-top: 8px; }
    .copy-btn:hover { background: #2c5282; }
  </style>
</head>
<body>
  <h1>🔧 ForIT Xero Connector - MCP Setup</h1>

  <div class="card">
    <h2>Claude Desktop Configuration</h2>
    <p>Add this to your <code>claude_desktop_config.json</code>:</p>
    <pre id="config">{
  "mcpServers": {
    "forit-xero": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-fetch"],
      "env": {
        "MCP_FETCH_BASE_URL": "https://xero.forit.io/api/connector",
        "MCP_FETCH_HEADERS": "{\\"x-api-key\\": \\"${apiKey}\\", \\"Content-Type\\": \\"application/json\\"}"
      }
    }
  }
}</pre>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('config').textContent)">Copy Config</button>
  </div>

  <div class="card">
    <h2>Setup Steps</h2>
    <div class="step">
      <div class="step-num">1</div>
      <div><strong>Generate API Key</strong> - Go to <a href="https://forit.io/portal/xero-connector">forit.io/portal</a> and generate an API key</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div><strong>Connect Xero</strong> - Authorize your Xero organization</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div><strong>Copy Config</strong> - Add the config above to your Claude Desktop config file:
        <br><code>macOS:</code> ~/Library/Application Support/Claude/claude_desktop_config.json
        <br><code>Windows:</code> %APPDATA%\\Claude\\claude_desktop_config.json
      </div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div><strong>Restart Claude Desktop</strong> - The ForIT Xero tools will now be available</div>
    </div>
  </div>

  <div class="card">
    <h2>Available Operations</h2>
    <ul>
      <li><strong>GET /invoices/{id}</strong> - Get invoice details</li>
      <li><strong>POST /invoices/{id}/status</strong> - Change status (DRAFT, SUBMITTED, AUTHORISED)</li>
      <li><strong>POST /invoices/{id}/recode</strong> - Recode line items</li>
      <li><strong>GET /contacts?email={email}</strong> - Search contacts</li>
      <li><strong>POST /contacts</strong> - Create contact</li>
      <li><strong>GET /accounts</strong> - List chart of accounts</li>
      <li><strong>POST /payments</strong> - Create payment</li>
      <li><strong>DELETE /payments/{id}</strong> - Delete payment</li>
    </ul>
  </div>

  <div class="card">
    <h2>API Reference</h2>
    <p><a href="/api/connector/apiDefinition.swagger.json">Swagger/OpenAPI Spec</a> | <a href="https://github.com/ForITLLC/ForIT-Xero">GitHub</a></p>
  </div>
</body>
</html>`;

  return {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html
  };
}

// Register endpoints
app.http('mcpConfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'mcp/config',
  handler: getMcpConfig
});

app.http('mcpSetup', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: getMcpSetupPage
});
