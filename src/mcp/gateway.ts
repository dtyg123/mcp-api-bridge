import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeTool, JsonSchema } from "../types.js";
import { isPlainObject } from "../util/json.js";
import { ToolArgumentError, UpstreamError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export type GatewayServerOptions = {
  name: string;
  version?: string;
  instructions?: string;
  listTools: () => Promise<BridgeTool[]> | BridgeTool[];
  getTool: (name: string) => BridgeTool | undefined;
  logger: Logger;
};

function toMcpTool(tool: BridgeTool): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as JsonSchema,
  };
  if (tool.title) payload.title = tool.title;
  if (tool.outputSchema) payload.outputSchema = tool.outputSchema;
  if (tool.annotations && Object.keys(tool.annotations).length > 0) payload.annotations = tool.annotations;
  return payload;
}

/** Create the aggregated MCP server exposing every registered tool. */
export function createGatewayServer(options: GatewayServerOptions): Server {
  const server = new Server(
    { name: options.name, version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} }, instructions: options.instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await options.listTools();
    return { tools: tools.map(toMcpTool) as never };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const tool = options.getTool(toolName);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
    const args = isPlainObject(request.params.arguments) ? request.params.arguments : {};
    try {
      const result = await tool.invoke(args, { signal: extra.signal });
      const payload: Record<string, unknown> = {
        content: result.content,
        isError: result.isError === true,
      };
      if (isPlainObject(result.structuredContent)) payload.structuredContent = result.structuredContent;
      return payload as never;
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${error.message}` }],
          isError: true,
        } as never;
      }
      const message = error instanceof Error ? error.message : String(error);
      options.logger.error(`Tool "${toolName}" failed: ${message}`, {
        upstream: error instanceof UpstreamError ? error.detail : undefined,
      });
      return {
        content: [{ type: "text", text: `Tool "${toolName}" failed: ${message}` }],
        isError: true,
      } as never;
    }
  });

  return server;
}

/** Gateway tool listing as plain JSON (used by the `/tools` REST endpoint). */
export function describeTools(tools: BridgeTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    source: tool.source,
    sourceType: tool.sourceType,
    originalName: tool.originalName,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));
}
