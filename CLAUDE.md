# ForIT Xero Platform

Unified Xero integration platform for ForIT. Single Xero app, two products.

## Project Structure

```
ForIT-Xero/
├── connector/        # MCP server + Power Automate API (Azure Functions)
├── interest/         # Interest Accrual system (Azure Functions)
└── CLAUDE.md
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   ForIT Xero Platform                        │
│               (1 Xero App Registration)                      │
│                Client ID: 09AF916B...                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐    │
│  │       connector/        │  │       interest/         │    │
│  │  MCP Server + PA API    │  │   Interest Accrual      │    │
│  │  xero.forit.io          │  │   System                │    │
│  └───────────┬─────────────┘  └───────────┬─────────────┘    │
│              │                            │                  │
│              └────────────┬───────────────┘                  │
│                           ▼                                  │
│              ┌─────────────────────────┐                     │
│              │  forit-saas-db          │                     │
│              │  (customers, api_keys,  │                     │
│              │   xero_connections)     │                     │
│              └─────────────────────────┘                     │
└──────────────────────────────────────────────────────────────┘
```

## Components

### 1. connector/ - MCP Server + Power Automate API
Azure Functions backend serving MCP tools and Power Automate custom connector.

**Deploy to:** `forit-xero-mcp` (Azure Functions)
**URL:** https://xero.forit.io

**Endpoints:**
- `GET /api/tokens` - Get Xero tokens (API key auth)
- `GET /api/connector/apiDefinition.swagger.json` - Power Automate swagger
- `GET /api/connector/invoices/{id}` - Get invoice details
- `POST /api/connector/invoices/{id}/status` - Change invoice status
- `POST /api/connector/invoices/{id}/recode` - Recode line items
- `DELETE /api/connector/payments/{id}` - Delete payment
- `POST /api/connector/payments` - Create payment

**Authentication:** API key in `x-api-key` header
**Get API key:** https://forit.io/portal

### 2. interest/ - Interest Accrual System
ForIT internal tool for automated interest calculation on overdue invoices.

**Deploy to:** `forit-interest-accrual` (Azure Functions)

**Endpoints:**
- Timer: MonthlyAccrual, ReconcileVoided
- HTTP: DryRun, ManualRun, CreditInterest, Report
- OAuth: AuthStart, AuthCallback (for Xero connection)

**Features:**
- Payment-date-aware interest calculation
- Self-correcting when payments change
- Consolidated monthly invoices per client
- Automatic credit notes for voided invoices

## Database

**Server:** forit-saas-sql.database.windows.net
**Database:** forit-saas-db

| Table | Purpose |
|-------|---------|
| customers | Customer accounts (linked to Entra ID) |
| products | Product catalog (xero-connector, etc.) |
| customer_products | Product access grants |
| api_keys | API keys for authentication |
| xero_connections | Xero OAuth tokens per customer |

Interest-specific tables (forit-xero-db):
- interest_configs - Per-client interest settings
- interest_ledger - Interest calculation history

## Xero App

- **Name:** ForIT Xero Platform
- **Client ID:** `09AF916BFDF94BEB92ABFAA2738FDE98`
- **Redirect URI:** `https://xero.forit.io/api/callback`

## Azure Resources

**Resource Group:** `rg-forit-xero`

| Resource | Type | Component |
|----------|------|-----------|
| forit-xero-mcp | Function App | connector/ |
| forit-interest-accrual | Function App | interest/ |
| forit-xero-mcp-kv | Key Vault | connector/ |
| forit-interest-kv | Key Vault | interest/ |
| foritxeromcpstorage | Storage | connector/ |
| foritintereststore | Storage | interest/ |

## Development

```bash
# Connector
cd connector && npm install && npm run build

# Interest
cd interest && npm install && npm run build
```

## Deploy

### Connector (Azure Functions)
```bash
cd connector
npm run build
rm -f deploy.zip && zip -r deploy.zip dist host.json package.json package-lock.json node_modules
az functionapp deployment source config-zip --name forit-xero-mcp --resource-group rg-forit-xero --src deploy.zip
```

### Interest (Azure Functions)
```bash
cd interest
npm run build
rm -f deploy.zip && zip -r deploy.zip dist host.json package.json package-lock.json node_modules
az functionapp deployment source config-zip --name forit-interest-accrual --resource-group rg-forit-xero --src deploy.zip
```

## Xero API Notes

- **PUT = Create, POST = Update** (backwards from REST)
- **Delete = POST with Status: DELETED** (not DELETE verb)
- **Tokens are single-use** - must save new refresh token after each API call
