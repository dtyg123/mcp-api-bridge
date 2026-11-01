/**
 * Shared types for the MCP <-> API bridge.
 */

export type JsonSchema = Record<string, unknown>;

export type ContentBlock =
  | { type: "text"; text: string; [k: string]: unknown }
  | { type: "image"; data: string; mimeType: string; [k: string]: unknown }
  | { type: "audio"; data: string; mimeType: string; [k: string]: unknown }
  | { type: "resource"; resource: Record<string, unknown>; [k: string]: unknown }
  | { type: "resource_link"; uri: string; [k: string]: unknown };

export interface ToolResult {
  content: ContentBlock[];
  /** Structured JSON payload, when the upstream could produce one. */
  structuredContent?: unknown;
  isError?: boolean;
  /** Free-form metadata surfaced by the REST envelope (status code, url, ...). */
  meta?: Record<string, unknown>;
}

export interface InvokeContext {
  signal?: AbortSignal;
}

export type ToolSourceType = "mcp" | "openapi";

export interface BridgeTool {
  /** Logical upstream this tool belongs to (MCP server name or API name). */
  readonly source: string;
  readonly sourceType: ToolSourceType;
  /** Globally unique tool name exposed by the gateway. */
  readonly name: string;
  /** Tool name as it exists upstream (MCP tool name / OpenAPI operationId). */
  readonly originalName: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly annotations?: Record<string, unknown>;
  invoke(args: Record<string, unknown>, ctx?: InvokeContext): Promise<ToolResult>;
}

export type SourceStatus = "ready" | "error" | "loading";

export interface SourceInfo {
  name: string;
  type: ToolSourceType;
  status: SourceStatus;
  toolCount: number;
  error?: string;
  detail?: Record<string, unknown>;
}
