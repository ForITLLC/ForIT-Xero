-- Product Pages table for dynamic product content
-- Run against forit-saas-db

CREATE TABLE product_pages (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  product_id UNIQUEIDENTIFIER NULL REFERENCES products(id),
  slug NVARCHAR(100) UNIQUE NOT NULL,
  title NVARCHAR(200) NOT NULL,
  subtitle NVARCHAR(500) NULL,
  description NVARCHAR(MAX) NULL,
  content_html NVARCHAR(MAX) NULL,
  cover_image NVARCHAR(500) NULL,
  features NVARCHAR(MAX) NULL,              -- JSON array of feature strings
  price_display NVARCHAR(100) NULL,         -- "$99/mo" or "Contact us" or "Free"
  cta_text NVARCHAR(100) DEFAULT 'Get Started',
  cta_url NVARCHAR(500) NULL,               -- checkout link, contact page, or null for portal
  cta_type NVARCHAR(50) DEFAULT 'portal',   -- 'portal', 'stripe', 'contact', 'external'
  meta_title NVARCHAR(200) NULL,
  meta_description NVARCHAR(500) NULL,
  published BIT DEFAULT 0,
  sort_order INT DEFAULT 0,
  created_at DATETIME2 DEFAULT GETUTCDATE(),
  updated_at DATETIME2 DEFAULT GETUTCDATE()
);

-- Index for fast slug lookups
CREATE INDEX IX_product_pages_slug ON product_pages(slug) WHERE published = 1;

-- Index for listing published products
CREATE INDEX IX_product_pages_published ON product_pages(published, sort_order);

GO

-- Seed the Xero Connector product page
INSERT INTO product_pages (
  product_id,
  slug,
  title,
  subtitle,
  description,
  content_html,
  cover_image,
  features,
  price_display,
  cta_text,
  cta_url,
  cta_type,
  meta_title,
  meta_description,
  published,
  sort_order
)
SELECT
  p.id,
  'xero-connector',
  'Xero Connector',
  'Connect Xero to Power Automate and AI assistants',
  'Enterprise-grade Xero integration for Microsoft Power Automate and Claude Code. Manage invoices, payments, and contacts programmatically.',
  '<h2>What You Can Do</h2>
<p>The ForIT Xero Connector gives you full programmatic access to Xero accounting data through a secure API. Built for Power Automate flows and AI coding assistants like Claude Code.</p>

<h3>Invoice Management</h3>
<ul>
<li>Get invoice details with line items and payment history</li>
<li>Change invoice status (Draft → Authorised → Submitted)</li>
<li>Recode line items to different accounts</li>
<li>Delete payments to unlock paid invoices</li>
</ul>

<h3>Payment Operations</h3>
<ul>
<li>Create payments against invoices</li>
<li>Delete payments (with proper audit trail)</li>
<li>Batch payment processing</li>
</ul>

<h3>Integration Options</h3>
<ul>
<li><strong>Power Automate</strong> - Custom connector with full Swagger/OpenAPI spec</li>
<li><strong>Claude Code (MCP)</strong> - AI-assisted Xero operations</li>
<li><strong>Direct API</strong> - REST endpoints with API key auth</li>
</ul>

<h2>Getting Started</h2>
<ol>
<li>Sign in to the <a href="/portal">ForIT Portal</a></li>
<li>Generate an API key from My Products</li>
<li>Connect your Xero organization</li>
<li>Start building automations</li>
</ol>

<h2>API Authentication</h2>
<p>All requests require an API key in the <code>x-api-key</code> header:</p>
<pre><code>curl -H "x-api-key: fmcp_your_key_here" \
  https://xero.forit.io/api/connector/invoices/INV-001</code></pre>',
  '/images/products/xero-connector.png',
  '["Power Automate custom connector", "Claude Code MCP integration", "Invoice status management", "Payment creation & deletion", "Line item recoding", "Secure API key authentication", "Full audit trail", "Priority support"]',
  'Free during beta',
  'Get Started',
  '/portal',
  'portal',
  'Xero Connector - ForIT',
  'Connect Xero to Power Automate and AI assistants. Manage invoices, payments, and contacts programmatically.',
  1,
  1
FROM products p
WHERE p.slug = 'xero-connector';

GO
