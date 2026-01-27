# ForIT Xero Connector

API and MCP server for Xero integration. Enables Power Automate flows and Claude Desktop to interact with Xero accounting data.

## Features

- **Invoice Management** - Get details, change status, recode line items
- **Payment Operations** - Create and delete payments
- **Contact Management** - Search and create contacts
- **Chart of Accounts** - List and filter accounts

## MCP Setup (Claude Desktop)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "forit-xero": {
      "command": "npx",
      "args": ["-y", "github:ForITLLC/ForIT-Xero/mcp-server"],
      "env": {
        "FORIT_XERO_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

**Config locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## API Usage

**Base URL:** `https://xero.forit.io/api/connector`

**Authentication:** API key in `x-api-key` header

```bash
curl -H "x-api-key: YOUR_API_KEY" \
  https://xero.forit.io/api/connector/invoices/INV-0001
```

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/invoices/{id}` | Get invoice details |
| GET | `/invoices/{id}/payments` | Get invoice payments |
| POST | `/invoices/{id}/status` | Change invoice status |
| POST | `/invoices/{id}/recode` | Recode line items |
| POST | `/invoices` | Create invoice |
| GET | `/contacts?email={email}` | Search contacts |
| POST | `/contacts` | Create contact |
| GET | `/accounts` | List chart of accounts |
| POST | `/payments` | Create payment |
| DELETE | `/payments/{id}` | Delete payment |

## Get an API Key

1. Sign in at [forit.io/portal](https://forit.io/portal)
2. Connect your Xero organization
3. Generate an API key

## Resources

- [API Swagger Spec](https://xero.forit.io/api/connector/apiDefinition.swagger.json)
- [ForIT Portal](https://forit.io/portal)

## License

MIT
