-- Update xero-connector product page with documentation
UPDATE product_pages
SET content_html = '
<h2>Getting Started</h2>
<p>The ForIT Xero Connector provides API access to your Xero organization for Power Automate flows and AI assistants.</p>

<h3>1. Connect Your Xero Organization</h3>
<p>Click "Connect Xero" above to authorize access to your Xero organization.</p>

<h3>2. Generate an API Key</h3>
<p>Create an API key to authenticate your requests. Give it a descriptive name like "Power Automate" or "Claude".</p>

<hr />

<h2>API Reference</h2>
<p><strong>Base URL:</strong> <code>https://xero.forit.io/api</code></p>
<p><strong>Authentication:</strong> Include your API key in the <code>x-api-key</code> header.</p>

<h3>Endpoints</h3>
<ul>
<li><code>GET /connector/invoices/{id}</code> - Get invoice details</li>
<li><code>GET /connector/invoices/{id}/payments</code> - Get invoice payments</li>
<li><code>POST /connector/invoices/{id}/status</code> - Change invoice status</li>
<li><code>POST /connector/invoices/{id}/recode</code> - Recode line items</li>
<li><code>GET /connector/contacts?email={email}</code> - Search contacts</li>
<li><code>POST /connector/contacts</code> - Create contact</li>
<li><code>GET /connector/accounts</code> - List accounts</li>
<li><code>POST /connector/payments</code> - Create payment</li>
<li><code>DELETE /connector/payments/{id}</code> - Delete payment</li>
</ul>

<p><a href="https://xero.forit.io/api/connector/apiDefinition.swagger.json" target="_blank">Swagger Spec</a> | <a href="https://github.com/ForITLLC/ForIT-Xero" target="_blank">GitHub</a></p>

<hr />

<h2>Example Request</h2>
<pre><code>curl -H "x-api-key: YOUR_API_KEY" \
  https://xero.forit.io/api/connector/invoices/INV-0001</code></pre>

<hr />

<h2>FAQ</h2>

<details>
<summary><strong>How do I refresh my Xero connection?</strong></summary>
<p>Tokens refresh automatically. If issues persist, disconnect and reconnect your organization.</p>
</details>

<details>
<summary><strong>Can I connect multiple Xero organizations?</strong></summary>
<p>Yes, up to 5 organizations per account.</p>
</details>

<details>
<summary><strong>What permissions are required?</strong></summary>
<p>Read/write access to invoices, payments, contacts, and accounts.</p>
</details>
'
WHERE slug = 'xero-connector';
