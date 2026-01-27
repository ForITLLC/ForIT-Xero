import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

/**
 * MCP Configuration Endpoint
 * Returns JSON config for Claude Desktop / MCP clients
 * Documentation is in the portal - this just returns machine-readable config
 */
async function getMcpConfig(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const apiKey = request.query.get('apiKey') || 'YOUR_API_KEY';

  const config = {
    mcpServers: {
      'forit-xero': {
        command: 'npx',
        args: ['-y', 'github:ForITLLC/ForIT-Xero/mcp-server'],
        env: {
          FORIT_XERO_API_KEY: apiKey
        }
      }
    }
  };

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    jsonBody: config
  };
}

// Single endpoint - just JSON config
app.http('mcpConfig', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'mcp',
  handler: getMcpConfig
});
