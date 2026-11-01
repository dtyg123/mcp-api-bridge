import type { ApiConfig, McpServerConfig } from "../config.js";
import { buildOpenApiTools } from "../convert/openapi-to-tools.js";
import { loadOpenApiDocument, resolveBaseUrl } from "../openapi/loader.js";
import { McpUpstream } from "../upstream/mcp.js";
import type { Logger } from "../util/logger.js";
import type { SourceKind } from "./store.js";

export type TestedTool = {
  name: string;
  description: string;
};

export type TestSourceResult = {
  ok: boolean;
  kind: SourceKind;
  name: string;
  toolCount: number;
  tools: TestedTool[];
  detail?: Record<string, unknown>;
  error?: string;
  durationMs: number;
};

export type TestSourceOptions = {
  logger: Logger;
  /** Directory used to resolve relative paths inside the entry. */
  configDir: string;
  timeoutMs?: number;
};

function summarize(tools: Array<{ originalName: string; description: string }>): TestedTool[] {
  return tools.slice(0, 50).map((tool) => ({
    name: tool.originalName,
    description: tool.description.replace(/\s+/g, " ").trim().slice(0, 160),
  }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒）`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connect to a candidate MCP server / load a candidate OpenAPI document without
 * touching the live registry. Used by the admin UI's "测试" button.
 */
export async function testSource(
  kind: SourceKind,
  entry: McpServerConfig | ApiConfig,
  options: TestSourceOptions,
): Promise<TestSourceResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 25_000;

  if (kind === "mcp") {
    const config = entry as McpServerConfig;
    const upstream = new McpUpstream(config, options.logger.child(`test:mcp:${config.name}`));
    try {
      const listed = await withTimeout(upstream.listTools(true), timeoutMs, "连接 MCP Server");
      const tools = upstream.toTools(listed);
      return {
        ok: true,
        kind,
        name: config.name,
        toolCount: tools.length,
        tools: summarize(tools),
        detail: upstream.detail,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        kind,
        name: config.name,
        toolCount: 0,
        tools: [],
        detail: upstream.detail,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await upstream.close();
    }
  }

  const api = entry as ApiConfig;
  try {
    const loaded = await withTimeout(
      loadOpenApiDocument(api.spec, {
        configDir: options.configDir,
        headers: api.headers,
        logger: options.logger.child(`test:api:${api.name}`),
      }),
      timeoutMs,
      "加载 OpenAPI 文档",
    );
    const baseUrl = resolveBaseUrl({
      configured: api.baseUrl,
      serverUrl: loaded.serverUrl,
      sourceUri: loaded.sourceUri,
      example: api.name,
    });
    const tools = buildOpenApiTools({
      sourceName: api.name,
      document: loaded.document,
      baseUrl,
      defaultHeaders: api.headers,
      credentials: api.security,
      timeoutMs: api.timeoutMs,
      include: api.include,
      exclude: api.exclude,
      logger: options.logger.child(`test:api:${api.name}`),
    });
    const info = typeof loaded.document.info === "object" && loaded.document.info !== null ? (loaded.document.info as Record<string, unknown>) : {};
    return {
      ok: true,
      kind,
      name: api.name,
      toolCount: tools.length,
      tools: summarize(tools),
      detail: {
        spec: loaded.sourceUri,
        baseUrl,
        documentVersion: String(loaded.document.openapi ?? ""),
        convertedFromSwagger2: loaded.convertedFromSwagger2,
        title: typeof info.title === "string" ? info.title : undefined,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      kind,
      name: api.name,
      toolCount: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}
