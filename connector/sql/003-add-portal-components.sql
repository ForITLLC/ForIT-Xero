-- Add portal_components column to product_pages table
-- Run against forit-saas-db

ALTER TABLE product_pages ADD portal_components NVARCHAR(MAX) NULL;

GO

-- Seed Xero Connector portal components configuration
UPDATE product_pages
SET portal_components = N'[
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
      {"label": "MCP Setup", "url": "https://xero.forit.io/mcp", "icon": "terminal", "description": "Claude Code / MCP configuration"}
    ]
  }},
  {"type": "documentation", "order": 4},
  {"type": "usage-stats", "order": 5}
]'
WHERE slug = 'xero-connector';

GO
