/**
 * ForIT MCP Auth - HTML Templates
 *
 * Shared HTML templates for MCP landing pages.
 */
import type { McpAuthConfig } from '../types/index.js';
/**
 * Email entry form - first step
 */
export declare function emailFormTemplate(config: McpAuthConfig): string;
/**
 * Signup form with pricing - for new customers
 */
export declare function signupFormTemplate(config: McpAuthConfig, email: string): string;
/**
 * Success page with API key
 */
export declare function successTemplate(config: McpAuthConfig, customer: {
    email: string;
}, tenantName: string, apiKey: string): string;
/**
 * Error page
 */
export declare function errorTemplate(config: McpAuthConfig, errorMessage: string): string;
//# sourceMappingURL=index.d.ts.map