"use strict";
/**
 * ForIT MCP Auth - HTML Templates
 *
 * Shared HTML templates for MCP landing pages.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailFormTemplate = emailFormTemplate;
exports.signupFormTemplate = signupFormTemplate;
exports.successTemplate = successTemplate;
exports.errorTemplate = errorTemplate;
const baseStyles = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 500px;
    margin: 50px auto;
    padding: 20px;
    line-height: 1.6;
  }
  input {
    width: 100%;
    padding: 12px;
    margin: 10px 0;
    border: 1px solid #ddd;
    border-radius: 6px;
    box-sizing: border-box;
    font-size: 16px;
  }
  input:focus {
    outline: none;
    border-color: #13b5ea;
    box-shadow: 0 0 0 3px rgba(19, 181, 234, 0.1);
  }
  button {
    background: #13b5ea;
    color: white;
    padding: 14px 24px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    width: 100%;
    font-size: 16px;
    font-weight: 500;
    transition: background 0.2s;
  }
  button:hover {
    background: #0d94c0;
  }
  .card {
    background: #f8fafc;
    padding: 20px;
    border-radius: 8px;
    margin: 20px 0;
  }
  .success { color: #22c55e; }
  .error { color: #ef4444; }
  .warning {
    background: #fef3c7;
    border: 1px solid #f59e0b;
    padding: 15px;
    border-radius: 8px;
    margin: 15px 0;
  }
  code {
    background: #1f2937;
    color: #10b981;
    padding: 12px;
    border-radius: 6px;
    display: block;
    word-break: break-all;
    font-size: 14px;
    font-family: 'SF Mono', Monaco, monospace;
  }
  pre {
    background: #1f2937;
    color: #e5e7eb;
    padding: 15px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 13px;
  }
  ul { padding-left: 20px; }
  li { margin: 8px 0; }
  .price {
    font-size: 28px;
    font-weight: 600;
    color: #13b5ea;
    margin: 20px 0;
  }
  .muted { color: #6b7280; font-size: 13px; }
`;
/**
 * Email entry form - first step
 */
function emailFormTemplate(config) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.productName}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${baseStyles}</style>
    </head>
    <body>
      <h1>${config.productName}</h1>
      <p>Enter your email to get started</p>
      <form method="GET" action="/api/mcp/signup">
        <input type="email" name="email" placeholder="you@company.com" required autofocus />
        <button type="submit">Continue</button>
      </form>
    </body>
    </html>
  `;
}
/**
 * Signup form with pricing - for new customers
 */
function signupFormTemplate(config, email) {
    const features = config.features.map(f => `<li>${f}</li>`).join('\n');
    const priceDisplay = config.pricing.monthly === 0
        ? 'Free'
        : `$${config.pricing.monthly}/month`;
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.productName} - Sign Up</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${baseStyles}</style>
    </head>
    <body>
      <h1>${config.productName}</h1>
      <p>Connect to use with Claude Code.</p>
      <div class="price">${priceDisplay}</div>
      <ul>
        ${features}
      </ul>
      <form method="GET" action="/api/mcp/signup">
        <input type="hidden" name="email" value="${escapeHtml(email)}" />
        <input type="text" name="company" placeholder="Company name" required />
        <button type="submit">Start ${config.pricing.trialDays}-Day Free Trial</button>
      </form>
      <p class="muted" style="text-align: center; margin-top: 20px;">
        ${config.pricing.trialDays}-day free trial. No credit card required.
      </p>
    </body>
    </html>
  `;
}
/**
 * Success page with API key
 */
function successTemplate(config, customer, tenantName, apiKey) {
    const features = config.features.map(f => `<li>${f}</li>`).join('\n');
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.productName} - Setup Complete</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${baseStyles}</style>
    </head>
    <body>
      <h1 class="success">✓ Setup Complete!</h1>

      <div class="card">
        <p><strong>Connected:</strong> ${escapeHtml(tenantName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(customer.email)}</p>
      </div>

      <h2>Your API Key</h2>
      <div class="warning">
        <strong>⚠️ Save this now!</strong> This is the only time you'll see your full API key.
      </div>
      <code>${escapeHtml(apiKey)}</code>

      <h2>Claude Code Configuration</h2>
      <p>Add this to your <code style="display: inline; padding: 2px 6px;">~/.claude/settings.json</code>:</p>
      <pre>{
  "mcpServers": {
    "forit-${config.oauthProvider}": {
      "command": "npx",
      "args": ["-y", "${config.npmPackage}"],
      "env": {
        "MCP_API_KEY": "${escapeHtml(apiKey)}"
      }
    }
  }
}</pre>

      <h2>What You Can Do</h2>
      <ul>
        ${features}
      </ul>

      <p><strong>Next:</strong> Restart Claude Code to start using the MCP.</p>
    </body>
    </html>
  `;
}
/**
 * Error page
 */
function errorTemplate(config, errorMessage) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${config.productName} - Error</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${baseStyles}</style>
    </head>
    <body>
      <h1 class="error">✗ Authorization Failed</h1>
      <div class="card" style="background: #fef2f2;">
        <p><strong>Error:</strong> ${escapeHtml(errorMessage)}</p>
      </div>
      <p><a href="/api/mcp/signup">← Try again</a></p>
    </body>
    </html>
  `;
}
/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
//# sourceMappingURL=index.js.map