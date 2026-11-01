import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config.js";
import type { BridgeTool, ContentBlock, ToolResult } from "../types.js";
import { UpstreamError } from "../util/errors.js";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";
import { sanitizeToolName } from "../util/naming.js";

type UpstreamTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

export class McpUpstream {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private cache: { tools: UpstreamTool[]; at: number } | null = null;
  private lastError: string | undefined;

  constructor(
    readonly config: McpServerConfig,
    private readonly logger: Logger,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get status(): "ready" | "error" | "loading" {
    if (this.lastError) return "error";
    return this.client ? "ready" : "loading";
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get detail(): Record<string, unknown> {
    return {
      transport: this.config.transport.type,
      endpoint:
        this.config.transport.type === "stdio"
          ? [this.config.transport.command, ...this.config.transport.args].join(" ")
          : this.config.transport.url,
    };
  }

  private buildTransport(): Transport {
    const transport = this.config.transport;
    if (transport.type === "stdio") {
      return new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: { ...process.env, ...transport.env } as Record<string, string>,
        cwd: transport.cwd,
        stderr: "pipe",
      });
    }
    const url = new URL(transport.url);
    if (transport.type === "sse") {
      return new SSEClientTransport(url, { requestInit: { headers: transport.headers } });
    }
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: transport.headers },
      reconnectionOptions: { maxReconnectionDelay: 5_000, initialReconnectionDelay: 500, reconnectionDelayGrowFactor: 2, maxRetries: 1 },
    });
  }

  async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const transport = this.buildTransport();
      const client = new Client({ name: "mcp-api-bridge", version: "0.1.0" }, { capabilities: {} });
      try {
        await client.connect(transport, { timeout: 45_000 });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to connect to MCP server${this.describeEndpoint()}`, { error: this.lastError });
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        throw new UpstreamError(`MCP server "${this.name}" unavailable: ${this.lastError}`);
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.cache = null;
      });
      client.onclose = () => {
        if (this.client === client) {
          this.client = null;
          this.cache = null;
          this.logger.warn("Upstream MCP connection closed");
        }
      };
      this.client = client;
      this.lastError = undefined;
      this.logger.info(`Connected to MCP server${this.describeEndpoint()}`);
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private describeEndpoint(): string {
    const transport = this.config.transport;
    const endpoint = transport.type === "stdio" ? [transport.command, ...transport.args].join(" ") : transport.url;
    return ` (${this.name}, ${transport.type}: ${endpoint})`;
  }

  async listTools(force = false): Promise<UpstreamTool[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.config.cacheTtlMs) {
      return this.cache.tools;
    }
    const client = await this.getClient();
    try {
      const result = await client.listTools(undefined, { timeout: 30_000 });
      const tools = (result.tools ?? []) as UpstreamTool[];
      this.cache = { tools, at: Date.now() };
      return tools;
    } catch (error) {
      this.cache = null;
      throw new UpstreamError(`tools/list failed for "${this.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const client = await this.getClient();
    try {
      const result = (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: this.config.timeoutMs,
      })) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: boolean;
      };
      return {
        content: normalizeContent(result.content),
        structuredContent: result.structuredContent,
        isError: result.isError === true,
        meta: { source: this.name, tool: name },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A broken connection is worth resetting so the next call reconnects.
      if (/closed|disconnect|ECONNRESET|EPIPE|Not connected/i.test(message)) {
        this.client = null;
        this.cache = null;
      }
      throw new UpstreamError(`tools/call "${name}" failed on "${this.name}": ${message}`);
    }
  }

  toTools(tools: UpstreamTool[]): BridgeTool[] {
    return tools.map((tool) => {
      const inputSchema = normalizeInputSchema(tool.inputSchema);
      return {
        source: this.name,
        sourceType: "mcp" as const,
        name: sanitizeToolName(tool.name),
        originalName: tool.name,
        title: tool.title,
        description: tool.description ?? `MCP tool "${tool.name}" from ${this.name}.`,
        inputSchema,
        outputSchema: normalizeOutputSchema(tool.outputSchema),
        annotations: tool.annotations,
        invoke: (args, ctx) => this.callTool(tool.name, args, ctx?.signal),
      } satisfies BridgeTool;
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.cache = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      this.logger.debug("Error while closing upstream client", { error: String(error) });
    }
  }
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) return { type: "object", additionalProperties: true };
  const cloned = { ...schema };
  if (cloned.type === undefined) cloned.type = "object";
  return cloned;
}

function normalizeOutputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(schema)) return undefined;
  if (schema.type === "object" || isPlainObject(schema.properties)) return schema as Record<string, unknown>;
  return undefined;
}

export function normalizeContent(raw: unknown): ContentBlock[] {
  if (!Array.isArray(raw)) {
    if (raw === undefined || raw === null) return [{ type: "text", text: "" }];
    return [{ type: "text", text: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2) }];
  }
  const blocks: ContentBlock[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      blocks.push({ type: "text", text: String(item) });
      continue;
    }
    const type = item.type;
    if (type === "text" && typeof item.text === "string") {
      blocks.push({ ...item, type: "text", text: item.text } as ContentBlock);
    } else if (type === "image" && typeof item.data === "string") {
      blocks.push({ ...item, type: "image", data: item.data, mimeType: String(item.mimeType ?? "image/png") } as ContentBlock);
    } else if (type === "audio" && typeof item.data === "string") {
      blocks.push({ ...item, type: "audio", data: item.data, mimeType: String(item.mimeType ?? "audio/mpeg") } as ContentBlock);
    } else if (type === "resource" && isPlainObject(item.resource)) {
      blocks.push({ ...item, type: "resource", resource: item.resource } as ContentBlock);
    } else if (type === "resource_link" && typeof item.uri === "string") {
      blocks.push({ ...item, type: "resource_link", uri: item.uri } as ContentBlock);
    } else {
      blocks.push({ type: "text", text: JSON.stringify(item, null, 2) });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
