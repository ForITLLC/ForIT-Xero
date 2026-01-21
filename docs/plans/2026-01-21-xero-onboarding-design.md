# ForIT Xero Onboarding Design

**Date:** 2026-01-21
**Status:** Draft
**Projects:** forit-Xero (connector), forit-Website (portal)

## Overview

Design for self-service onboarding to ForIT Xero Connector, with a scalable architecture supporting future products.

### Goals
1. Users can self-service: sign in, generate API keys, connect Xero
2. Dynamic product pages driven by database configuration
3. Reusable component system for future products
4. Partner-ready architecture for future reseller flows

## User Journey

```
1. Sign in (Azure AD)
         ↓
2. /portal shows products as collapsed cards
         ↓
3. Click "Xero Connector" → expands with tabs
         ↓
4. "API Keys" tab → generate key, copy it
         ↓
5. "Xero Orgs" tab → click "Connect Xero"
         ↓
6. OAuth redirect → Xero login → approve → callback
         ↓
7. Back to /portal → card shows "1 org connected"
         ↓
8. Ready to use API
```

## Portal UI: Expandable Product Cards

### Collapsed State

```
┌─────────────────────────────────────────────────────────────────┐
│ Your Products                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🔗 Xero Connector                              ▼ Expand     │ │
│ │    Connect Xero to Power Automate and AI                    │ │
│ │    ● 1 org connected  ● 2 API keys                          │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📦 Other Product                               ▼ Expand     │ │
│ │    Some other product description                           │ │
│ │    ○ Not configured                                         │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Expanded State (Accordion - one at a time)

```
┌─────────────────────────────────────────────────────────────────┐
│ Your Products                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🔗 Xero Connector                              ▲ Collapse   │ │
│ │    Connect Xero to Power Automate and AI                    │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │                                                             │ │
│ │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │ │
│ │  │ API Keys │ │  Xero    │ │  Links   │ │   Docs   │       │ │
│ │  │    ●     │ │  Orgs    │ │          │ │          │       │ │
│ │  └────┬─────┘ └──────────┘ └──────────┘ └──────────┘       │ │
│ │       │                                                     │ │
│ │  ┌────▼────────────────────────────────────────────────┐   │ │
│ │  │                                                      │   │ │
│ │  │  Your API Keys                      [+ Generate]     │   │ │
│ │  │  ┌────────────────────────────────────────────────┐ │   │ │
│ │  │  │ fmcp_a3b2...  Created Jan 15   Last used today │ │   │ │
│ │  │  └────────────────────────────────────────────────┘ │   │ │
│ │  │                                                      │   │ │
│ │  └──────────────────────────────────────────────────────┘   │ │
│ │                                                             │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📦 Other Product                               ▼ Expand     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Behaviors
- Accordion style: only one product expanded at a time
- Tabs inside show available modules (from `portal_components` DB column)
- Quick status shown in collapsed state (connection count, key count)
- Smooth animation on expand/collapse
- URL updates with hash for deep linking: `/portal#xero-connector/api-keys`

## Data Model

### New Column: `product_pages.portal_components`

```sql
ALTER TABLE product_pages ADD portal_components NVARCHAR(MAX) NULL;
```

### Component Schema

```typescript
interface PortalComponent {
  type: 'api-keys' | 'oauth-connect' | 'links' | 'downloads' |
        'documentation' | 'webhook-config' | 'settings' | 'usage-stats'
  order: number
  config?: object  // type-specific configuration
}
```

### Example: Xero Connector Configuration

```json
[
  { "type": "api-keys", "order": 1 },
  { "type": "oauth-connect", "order": 2, "config": {
    "provider": "xero",
    "label": "Xero Organizations",
    "connectUrl": "https://xero.forit.io/api/connect/init"
  }},
  { "type": "links", "order": 3, "config": {
    "title": "Resources",
    "links": [
      { "label": "Power Automate Swagger", "url": "https://xero.forit.io/api/connector/apiDefinition.swagger.json", "icon": "file-json", "description": "Import as custom connector" },
      { "label": "MCP Setup", "url": "https://xero.forit.io/mcp", "icon": "terminal" }
    ]
  }},
  { "type": "documentation", "order": 4 },
  { "type": "usage-stats", "order": 5 }
]
```

## Component Library

| Type | Purpose | Config |
|------|---------|--------|
| `api-keys` | Generate/revoke API keys | None needed |
| `oauth-connect` | Connect external services | `provider`, `label`, `connectUrl`, `scopes?`, `maxConnections?` |
| `links` | External resources, subdomains | `title`, `links[]` with `label`, `url`, `icon?`, `description?` |
| `downloads` | Downloadable files | `files[]` with `label`, `url`, `size?` |
| `documentation` | Rich HTML docs | Uses `product_pages.content_html` |
| `webhook-config` | Configure webhooks | Fields TBD |
| `settings` | Product-specific settings | `fields[]` with `key`, `label`, `type`, `options?` |
| `usage-stats` | API usage metrics | None needed |

## OAuth Flow

### Architecture

Portal already has verified user identity via Azure AD (SWA `x-ms-client-principal` header). The connector trusts the portal via API key.

```
Browser                    Portal API                 Connector
   │                          │                          │
   │ POST /api/portal         │                          │
   │ {action: 'init_xero'}    │                          │
   │ ────────────────────────>│                          │
   │                          │                          │
   │    (Portal extracts      │                          │
   │     verified email from  │                          │
   │     x-ms-client-principal)                          │
   │                          │                          │
   │                          │ POST /api/connect/init   │
   │                          │ {email, return_url}      │
   │                          │ x-api-key: portal-key    │
   │                          │ ─────────────────────────>
   │                          │                          │
   │                          │      {oauth_url}         │
   │                          │ <─────────────────────────
   │                          │                          │
   │    {oauth_url}           │                          │
   │ <────────────────────────│                          │
   │                          │                          │
   │ Redirect to Xero ════════════════════════════════════>
   │                          │                          │
   │                          │    Xero callback         │
   │                          │ <══════════════════════════
   │                          │                          │
   │                          │  Save to xero_connections│
   │                          │  Redirect to return_url  │
   │ <═══════════════════════════════════════════════════│
   │    ?connected=true       │                          │
```

### Security
- Portal-to-connector auth via shared API key (`PORTAL_API_KEY` in Key Vault)
- Email is already verified by Azure AD - no additional JWT signing needed
- Connector validates email exists in `customers` table before proceeding
- OAuth state contains `customer_id` + `return_url` - created and verified by connector

### New Connector Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `POST /api/connect/init` | POST | Portal API key | Accept email + return_url, return OAuth URL |
| `GET /api/connect/callback` | GET | None (Xero callback) | Handle Xero callback, save tokens, redirect to portal |

## Implementation Plan

### forit-Xero (Connector)

| File | Change |
|------|--------|
| `src/functions/connect.ts` | NEW - `/api/connect/init` and `/api/connect/callback` endpoints |
| `src/services/database.ts` | No change - `saveXeroConnection()` already exists |
| Key Vault | Add `PORTAL_API_KEY` secret |

### forit-Website (Portal)

| File | Change |
|------|--------|
| `api/portal/index.js` | Add `action: 'init_xero_connect'` handler |
| `src/app/portal/page.tsx` | Refactor to use ProductAccordion |
| `src/components/portal/ProductAccordion.tsx` | NEW - accordion container |
| `src/components/portal/ProductCard.tsx` | NEW - expandable card |
| `src/components/portal/ModuleTabs.tsx` | NEW - tab bar for modules |
| `src/components/portal/ComponentRenderer.tsx` | NEW - renders active module |
| `src/components/portal/components/*.tsx` | NEW - individual module components |

### Database (forit-saas-db)

```sql
-- Add components column
ALTER TABLE product_pages ADD portal_components NVARCHAR(MAX) NULL;

-- Seed Xero Connector config
UPDATE product_pages
SET portal_components = '[
  {"type": "api-keys", "order": 1},
  {"type": "oauth-connect", "order": 2, "config": {
    "provider": "xero",
    "label": "Xero Organizations",
    "connectUrl": "https://xero.forit.io/api/connect/init"
  }},
  {"type": "links", "order": 3, "config": {
    "title": "Resources",
    "links": [
      {"label": "Power Automate Swagger", "url": "https://xero.forit.io/api/connector/apiDefinition.swagger.json", "icon": "file-json", "description": "Import as custom connector"},
      {"label": "MCP Setup", "url": "https://xero.forit.io/mcp", "icon": "terminal"}
    ]
  }},
  {"type": "documentation", "order": 4},
  {"type": "usage-stats", "order": 5}
]'
WHERE slug = 'xero-connector';
```

## Component Details

### OAuthConnectComponent

```typescript
interface OAuthConnectConfig {
  provider: 'xero' | 'quickbooks' | 'google'
  label: string
  connectUrl: string
  scopes?: string[]
  maxConnections?: number  // default 1
}
```

**Behaviors:**
- Shows existing connections with status
- "Connect" button calls portal API → connector → returns OAuth URL
- Handles `?connected=true` or `?error=...` on return from OAuth
- Supports multiple connections if `maxConnections > 1`

### LinksComponent

```typescript
interface LinksConfig {
  title: string
  links: {
    label: string
    url: string
    icon?: string       // Lucide icon name
    description?: string
    external?: boolean  // opens in new tab
  }[]
}
```

**Behaviors:**
- Copy URL button for URLs (useful for Swagger import)
- External links open in new tab with indicator
- Optional description per link

## Future Considerations

### Partner/Reseller Flow (Option 3 from requirements)
- Partners could provision customers via API
- Customers would only need to complete OAuth step
- Same component system works - just different account creation path

### Additional Providers
- OAuth component supports multiple providers
- Each provider just needs `connectUrl` pointing to its init endpoint
- QuickBooks, Google Workspace, etc. follow same pattern
