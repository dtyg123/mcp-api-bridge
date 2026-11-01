import type { BridgeConfig, ExposureConfig, McpServerConfig } from "./config.js";
import { buildOpenApiTools } from "./convert/openapi-to-tools.js";
import { loadOpenApiDocument, resolveBaseUrl } from "./openapi/loader.js";
import type { BridgeTool, SourceInfo } from "./types.js";
import { McpUpstream } from "./upstream/mcp.js";
import type { Logger } from "./util/logger.js";
import { claimName, sanitizeToolName } from "./util/naming.js";

export type Surface = "rest" | "mcp";

type UpstreamEntry = {
  upstream: McpUpstream;
  /** Transport signature; a change means the connection must be rebuilt. */
  signature: string;
};

function transportSignature(server: McpServerConfig): string {
  return JSON.stringify(server.transport);
}

/**
 * Holds the effective config and the tool catalog derived from it. The config
 * can be swapped at runtime (admin UI), so upstream connections are diffed
 * instead of being recreated blindly.
 */
export class Registry {
  private tools: BridgeTool[] = [];
  private toolByName = new Map<string, BridgeTool>();
  private sources = new Map<string, SourceInfo>();
  private exposures = new Map<string, ExposureConfig>();
  private lastGood = new Map<string, BridgeTool[]>();
  private upstreams = new Map<string, UpstreamEntry>();
  private refreshing: Promise<void> | null = null;
  private initialized = false;

  constructor(
    private config: BridgeConfig,
    private readonly logger: Logger,
  ) {}

  get currentConfig(): BridgeConfig {
    return this.config;
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.initialized = true;
  }

  /**
   * Replace the effective config (e.g. after a source was added in the UI).
   * Upstream clients are reused when their transport did not change. Call
   * `reload()` afterwards to rebuild the tool catalog.
   */
  setConfig(config: BridgeConfig): void {
    this.config = config;
    this.syncUpstreams();
  }

  private syncUpstreams(): void {
    const wanted = new Map(this.config.mcpServers.map((server) => [server.name, server]));
    for (const [name, entry] of [...this.upstreams]) {
      const next = wanted.get(name);
      if (next && transportSignature(next) === entry.signature) continue;
      this.upstreams.delete(name);
      this.lastGood.delete(name);
      void entry.upstream.close();
      if (!next) this.logger.info(`Dropped MCP source "${name}"`);
    }
    for (const server of this.config.mcpServers) {
      if (this.upstreams.has(server.name)) continue;
      this.upstreams.set(server.name, {
        upstream: new McpUpstream(server, this.logger.child(`mcp:${server.name}`)),
        signature: transportSignature(server),
      });
    }
  }

  async reload(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doReload().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doReload(): Promise<void> {
    const used = new Set<string>();
    const tools: BridgeTool[] = [];
    const sources = new Map<string, SourceInfo>();
    const exposures = new Map<string, ExposureConfig>();

    this.syncUpstreams();

    // ---- APIs -> tools -------------------------------------------------------
    for (const api of this.config.apis) {
      exposures.set(api.name, api.exposure);
      try {
        const loaded = await loadOpenApiDocument(api.spec, {
          configDir: this.config.configDir,
          headers: api.headers,
          logger: this.logger.child(`api:${api.name}`),
        });
        const baseUrl = resolveBaseUrl({
          configured: api.baseUrl,
          serverUrl: loaded.serverUrl,
          sourceUri: loaded.sourceUri,
          example: api.name,
        });
        const built = buildOpenApiTools({
          sourceName: api.name,
          document: loaded.document,
          baseUrl,
          defaultHeaders: api.headers,
          credentials: api.security,
          timeoutMs: api.timeoutMs,
          include: api.include,
          exclude: api.exclude,
          logger: this.logger.child(`api:${api.name}`),
        });

        const named = built.map((tool) => this.assignName(tool, api.exposure, used));
        tools.push(...named);
        this.lastGood.set(api.name, named);
        sources.set(api.name, {
          name: api.name,
          type: "openapi",
          status: "ready",
          toolCount: named.length,
          detail: {
            spec: loaded.sourceUri,
            baseUrl,
            documentVersion: loaded.document.openapi,
            convertedFromSwagger2: loaded.convertedFromSwagger2,
          },
        });
        this.logger.info(`Loaded API source "${api.name}"`, {
          operations: named.length,
          baseUrl,
          ...(loaded.convertedFromSwagger2 ? { convertedFrom: "Swagger 2.0" } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = this.lastGood.get(api.name) ?? [];
        const named = fallback.map((tool) => this.assignName(tool, api.exposure, used));
        tools.push(...named);
        sources.set(api.name, {
          name: api.name,
          type: "openapi",
          status: "error",
          toolCount: named.length,
          error: message,
          detail: { spec: api.spec },
        });
        this.logger.error(`Failed to load API source "${api.name}": ${message}`);
      }
    }

    // ---- MCP servers -> tools -----------------------------------------------
    for (const server of this.config.mcpServers) {
      const entry = this.upstreams.get(server.name);
      if (!entry) continue;
      const { upstream } = entry;
      const exposure = server.exposure;
      const name = server.name;
      exposures.set(name, exposure);
      try {
        const listed = await upstream.listTools(true);
        const named = upstream.toTools(listed).map((tool) => this.assignName(tool, exposure, used));
        tools.push(...named);
        this.lastGood.set(name, named);
        sources.set(name, {
          name,
          type: "mcp",
          status: upstream.status === "error" ? "error" : "ready",
          toolCount: named.length,
          error: upstream.error,
          detail: upstream.detail,
        });
        this.logger.info(`Loaded MCP source "${name}"`, { tools: named.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = this.lastGood.get(name) ?? [];
        const named = fallback.map((tool) => this.assignName(tool, exposure, used));
        tools.push(...named);
        sources.set(name, {
          name,
          type: "mcp",
          status: "error",
          toolCount: named.length,
          error: message,
          detail: upstream.detail,
        });
        this.logger.error(`Failed to load MCP source "${name}": ${message}`);
      }
    }

    this.tools = tools;
    this.toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.sources = sources;
    this.exposures = exposures;
    this.logger.info("Registry refreshed", { tools: tools.length, sources: sources.size });
  }

  private assignName(tool: BridgeTool, exposure: ExposureConfig, used: Set<string>): BridgeTool {
    const base = sanitizeToolName(`${exposure.prefix}${tool.source}__${tool.originalName}`, "tool");
    const name = claimName(base, used);
    return { ...tool, name };
  }

  getTools(surface: Surface = "mcp", sourceFilter?: string): BridgeTool[] {
    return this.tools.filter((tool) => {
      if (sourceFilter && tool.source !== sourceFilter) return false;
      const exposure = this.exposures.get(tool.source);
      if (!exposure) return true;
      return surface === "rest" ? exposure.rest : exposure.mcp;
    });
  }

  /** Every registered tool of one source, regardless of exposure (admin UI testing). */
  getToolsForSource(source: string): BridgeTool[] {
    return this.tools.filter((tool) => tool.source === source);
  }

  getTool(name: string): BridgeTool | undefined {
    return this.toolByName.get(name);
  }

  isExposed(tool: BridgeTool, surface: Surface): boolean {
    const exposure = this.exposures.get(tool.source);
    if (!exposure) return true;
    return surface === "rest" ? exposure.rest : exposure.mcp;
  }

  /** Look a tool up by gateway name, MCP name, or `source + originalName`. */
  findTool(source: string, identifier: string): BridgeTool | undefined {
    const direct = this.toolByName.get(identifier);
    if (direct && direct.source === source) return direct;
    return this.tools.find((tool) => tool.source === source && (tool.originalName === identifier || tool.name === identifier));
  }

  getSources(): SourceInfo[] {
    return [...this.sources.values()];
  }

  getSource(name: string): SourceInfo | undefined {
    return this.sources.get(name);
  }

  hasSource(name: string): boolean {
    return this.sources.has(name);
  }

  get toolCount(): number {
    return this.tools.length;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async close(): Promise<void> {
    const entries = [...this.upstreams.values()];
    this.upstreams.clear();
    await Promise.all(entries.map((entry) => entry.upstream.close()));
  }
}
