// Function app entry point - imports all function definitions
// Azure Functions v4 programming model auto-registers via app.* calls
// Import executes the side effects (app.http() registrations)

import './mcpAuth';
import './connector';
import './connect';
import './subscriptions';
import './mcp';
// products and swag moved to forit-saas-api
