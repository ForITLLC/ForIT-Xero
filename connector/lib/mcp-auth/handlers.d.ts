/**
 * ForIT MCP Auth - Request Handlers
 *
 * Factory function to create signup, callback, and token endpoints
 * for any OAuth-based MCP product.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { McpAuthConfig } from './types/index.js';
export interface McpAuthHandlers {
    signup: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
    callback: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
    tokens: (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
}
/**
 * Create MCP auth handlers for a product
 */
export declare function createMcpAuthHandlers(config: McpAuthConfig): McpAuthHandlers;
//# sourceMappingURL=handlers.d.ts.map