import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { parse as parseYaml } from "yaml";
import type { BridgeConfig, OutputConfig } from "../config.js";
import { ConfigError, applyCredentialRefs, normalizeOutput, type ApiConfig } from "../config.js";
import { buildPrompt } from "../admin/prompts.js";
import { testSource } from "../admin/service.js";
import { maskCredential, type CredentialStore } from "../admin/credentials.js";
import type { SourceKind, SourceStore } from "../admin/store.js";
import { applyTransform, discoverFields, type TransformConfig, type TransformStore } from "../admin/transforms.js";
import { buildOpenApiDocument } from "../convert/tools-to-openapi.js";
import { createGatewayServer } from "../mcp/gateway.js";
import { loadOpenApiDocument } from "../openapi/loader.js";
import type { Registry } from "../registry.js";
import { coerceQueryArgs, validateArgs } from "../util/args.js";
import { ToolArgumentError } from "../util/errors.js";
import { isPlainObject, safeJsonParse } from "../util/json.js";
import type { Logger } from "../util/logger.js";
import type { BridgeTool, ToolResult } from "../types.js";
import { SERVER_NAME, VERSION } from "../version.js";
import { McpHttpEndpoint } from "./mcp-endpoint.js";

export type GatewayRuntime = {
  config: BridgeConfig;
  registry: Registry;
  /** Persists sources added through the web UI. */
  store: SourceStore;
  /** Reusable authentication material (管理台「认证信息」). */
  credentials: CredentialStore;
  /** Per-tool response reshaping (管理台「数据编排」). */
  transforms: TransformStore;
  logger: Logger;
  startedAt: number;
  version: string;
};

export type HttpApp = {
  app: express.Express;
  close: () => Promise<void>;
};

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requireToken(expected: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return next();
    const header = req.headers.authorization ?? "";
    const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : String(req.headers["x-api-key"] ?? "");
    if (provided && safeCompare(provided, expected)) return next();
    res.status(401).json({ ok: false, error: "unauthorized", message: "Provide a valid bearer token." });
  };
}

function publicBaseUrl(config: BridgeConfig, req: Request): string {
  if (config.server.publicBaseUrl) return config.server.publicBaseUrl.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.get("host") ?? `localhost:${config.server.port}`;
  const base = config.server.basePath.replace(/\/+$/, "");
  return `${proto}://${host}${base}`;
}

function textOf(result: { content: ReadonlyArray<{ type: string; text?: unknown }> }): string {
  return result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n");
}

/** Uniform response envelope shared by the REST surface and the admin tester. */
function toolEnvelope(tool: BridgeTool, result: ToolResult): Record<string, unknown> {
  const text = textOf(result);
  const data =
    result.structuredContent !== undefined
      ? result.structuredContent
      : (() => {
          const parsed = safeJsonParse(text);
          return parsed.ok ? parsed.value : text;
        })();
  return {
    ok: result.isError !== true,
    source: tool.source,
    tool: tool.originalName,
    name: tool.name,
    isError: result.isError === true,
    text,
    data,
    content: result.content,
    meta: result.meta,
  };
}

/** HTTP method + path for OpenAPI-backed tools (undefined for MCP tools). */
function toolHttpMeta(tool: BridgeTool): { method?: string; path?: string } {
  const meta = tool as { method?: unknown; pathTemplate?: unknown };
  if (typeof meta.method !== "string" || typeof meta.pathTemplate !== "string") return {};
  return { method: meta.method.toUpperCase(), path: meta.pathTemplate };
}

export function createHttpApp(runtime: GatewayRuntime): HttpApp {
  const { config, registry, store, credentials, transforms, logger } = runtime;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  /**
   * Envelope + optional 数据编排 transform. The transform replaces `data`
   * (and its text projection) with the blocks the user configured, so an API
   * consumer only sees the fields the admin decided to expose.
   */
  const envelopeFor = (
    tool: BridgeTool,
    result: ToolResult,
    envelope: Record<string, unknown> = toolEnvelope(tool, result),
  ): Record<string, unknown> => {
    const transform = transforms.get(tool.source, tool.originalName);
    if (!transform) return envelope;
    try {
      const { value } = applyTransform(transform, envelope.data);
      return {
        ...envelope,
        data: value,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
        transformed: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Transform failed (${tool.source}/${tool.originalName}): ${message}`);
      return { ...envelope, transformed: false, transformError: message };
    }
  };

  app.use(
    express.json({
      limit: config.server.bodyLimit,
      strict: false,
      type: ["application/json", "application/*+json"],
      // Kept for `proxy` outputs, which forward the request body untouched.
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

  const router = express.Router();

  router.use((req, res, next) => {
    if (config.server.cors) {
      res.setHeader("access-control-allow-origin", (req.headers.origin as string) ?? "*");
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader(
        "access-control-allow-headers",
        "content-type,authorization,x-api-key,mcp-session-id,mcp-protocol-version,last-event-id,accept",
      );
      res.setHeader("access-control-expose-headers", "mcp-session-id");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const adminAuth = requireToken(config.server.adminToken);

  const outputs = (): OutputConfig[] => store.config.outputs;
  const findOutput = (name: string): OutputConfig | undefined => outputs().find((output) => output.name === name);

  const providedToken = (req: Request): string => {
    const header = req.headers.authorization ?? "";
    return header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : String(req.headers["x-api-key"] ?? "");
  };

  /**
   * Bearer / x-api-key auth for one output: its own token or the global token
   * of that surface. No token anywhere means the output is open (default).
   */
  const authorizeOutput = (output: OutputConfig, surface: "mcp" | "api", req: Request, res: Response): boolean => {
    const globalToken = surface === "mcp" ? config.server.auth.mcpToken : config.server.auth.restToken;
    const allowed = [output.token, globalToken].filter(Boolean) as string[];
    if (allowed.length === 0) return true;
    const provided = providedToken(req);
    if (provided && allowed.some((token) => safeCompare(provided, token))) return true;
    res.status(401).json({ ok: false, error: "unauthorized", message: "Provide a valid bearer token." });
    return false;
  };

  const outputAuth = (surface: "mcp" | "api"): RequestHandler => {
    return (req, res, next) => {
      const output = findOutput(String(req.params.output ?? ""));
      if (!output) {
        res.status(404).json({ ok: false, error: "unknown_output", message: `No output named "${req.params.output}".` });
        return;
      }
      if (!authorizeOutput(output, surface, req, res)) return;
      res.locals.output = output;
      next();
    };
  };

  const mcpOutputAuth = outputAuth("mcp");
  const apiOutputAuth = outputAuth("api");

  const mcpEndpoints = new Map<string, McpHttpEndpoint>();

  const closeEndpoints = async (): Promise<void> => {
    const endpoints = [...mcpEndpoints.values()];
    mcpEndpoints.clear();
    await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));
  };

  const buildEndpoint = (output: OutputConfig): McpHttpEndpoint => {
    const existing = mcpEndpoints.get(output.name);
    if (existing) return existing;
    const endpoint = new McpHttpEndpoint({
      name: `bridge:${output.name}`,
      mode: config.server.mcp.sessionMode,
      jsonResponse: config.server.mcp.jsonResponse,
      logger: logger.child(`mcp-http:${output.name}`),
      createServer: () =>
        createGatewayServer({
          name: `bridge-${output.name}`,
          version: VERSION,
          instructions: `MCP bridge output "${output.name}" (${output.mode}).`,
          listTools: () => registry.getOutputTools(output),
          getTool: (name) => registry.findOutputTool(output, name),
          logger: logger.child(`mcp:${output.name}`),
        }),
    });
    mcpEndpoints.set(output.name, endpoint);
    return endpoint;
  };

  // ---------------------------------------------------------------------------
  // Meta endpoints
  // ---------------------------------------------------------------------------

  router.get("/health", (req, res) => {
    const sources = registry.getSources();
    const ready = sources.filter((source) => source.status === "ready").length;
    const healthy = sources.length === 0 || ready > 0;
    const strict = String(req.query.strict ?? "") === "1" || String(req.query.strict ?? "") === "true";
    res.status(healthy || !strict ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
      tools: registry.toolCount,
      sources: sources.map((source) => ({
        name: source.name,
        type: source.type,
        status: source.status,
        toolCount: source.toolCount,
        error: source.error,
      })),
    });
  });

  router.get("/", (req, res) => {
    const base = publicBaseUrl(config, req);
    const outputLinks = (output: OutputConfig) => ({
      name: output.name,
      mode: output.mode,
      mcp:
        output.form.includes("mcp") && output.mode !== "proxy"
          ? `${base}${config.server.mcp.path}/${output.name}`
          : undefined,
      api: output.form.includes("api") ? `${base}${config.server.rest.path}/${output.name}` : undefined,
      openapi:
        output.mode === "convert" && output.form.includes("api")
          ? `${base}/openapi/${output.name}.json`
          : undefined,
    });
    res.json({
      name: "mcp-api-bridge",
      version: VERSION,
      description: "Bidirectional MCP <-> API gateway.",
      endpoints: {
        outputs: outputs().map(outputLinks),
        health: `${base}/health`,
        admin: config.server.admin.enabled ? `${base}${adminPath}` : undefined,
      },
      tools: registry.toolCount,
      sources: registry.getSources(),
    });
  });

  /** Per-output OpenAPI document (convert outputs with the API form only). */
  router.get("/openapi/:file", (req, res) => {
    const name = String(req.params.file ?? "").replace(/\.json$/i, "");
    const output = findOutput(name);
    if (!output || output.mode !== "convert" || !output.form.includes("api")) {
      res.status(404).json({ ok: false, error: "unknown_output", message: `No API output named "${name}".` });
      return;
    }
    if (!authorizeOutput(output, "api", req, res)) return;
    const requested = String(req.query.version ?? config.openapi.version);
    const version: "3.0" | "3.1" = requested === "3.0" ? "3.0" : "3.1";
    const document = buildOpenApiDocument({
      tools: registry.getOutputTools(output),
      title: `${config.openapi.title} · ${output.name}`,
      description: config.openapi.description,
      version,
      serverUrl: publicBaseUrl(config, req),
      basePath: `${config.server.rest.path}/${output.name}`,
      versionString: VERSION,
    });
    res.type("application/json").send(JSON.stringify(document, null, 2));
  });

  // ---------------------------------------------------------------------------
  // MCP surface: one endpoint per output
  // ---------------------------------------------------------------------------

  router.all(`${config.server.mcp.path}/:output`, mcpOutputAuth, async (req, res) => {
    const output = res.locals.output as OutputConfig;
    if (!output.form.includes("mcp") || output.mode === "proxy") {
      res.status(404).json({ ok: false, error: "unsupported", message: `输出 "${output.name}" 没有 MCP 形态。` });
      return;
    }
    await buildEndpoint(output).handle(req, res);
  });

  // ---------------------------------------------------------------------------
  // REST surface (MCP -> API and API -> API)
  // ---------------------------------------------------------------------------

  const invokeHandler = async (req: Request, res: Response): Promise<void> => {
    const output = res.locals.output as OutputConfig;
    const identifier = String(req.params[0] ?? "");
    const tool = registry.findOutputTool(output, identifier);
    if (!tool) {
      res.status(404).json({
        ok: false,
        error: "unknown_tool",
        message: `输出 "${output.name}" 上没有工具 "${identifier}".`,
        hint: `${publicBaseUrl(config, req)}${config.server.rest.path}/${output.name}`,
      });
      return;
    }

    const rawArgs = req.method === "GET" ? coerceQueryArgs(tool.inputSchema, req.query as Record<string, unknown>) : req.body;
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (!isPlainObject(args)) {
      res.status(400).json({ ok: false, error: "invalid_arguments", message: "Request body must be a JSON object." });
      return;
    }

    const issues = validateArgs(tool.inputSchema, args);
    if (issues.length > 0) {
      res.status(400).json({ ok: false, error: "invalid_arguments", issues, inputSchema: tool.inputSchema });
      return;
    }

    // Optional per-request credential switch (only when the output allows it,
    // and only among the credentials the tool's source already references).
    const requestedCredential = req.get("x-bridge-credential");
    let overrideHeaders: Record<string, string> | undefined;
    if (requestedCredential) {
      const apiConfig = store.config.apis.find((api) => api.name === tool.source);
      if (!output.allowCredentialSwitch || !apiConfig) {
        res.status(403).json({
          ok: false,
          error: "credential_switch_disabled",
          message: `输出 "${output.name}" 未允许调用方切换凭证（allowCredentialSwitch=false）。`,
        });
        return;
      }
      if (!apiConfig.credentialRefs.includes(requestedCredential)) {
        res.status(400).json({
          ok: false,
          error: "credential_not_allowed",
          message: `凭证 "${requestedCredential}" 未被来源 "${tool.source}" 引用。`,
        });
        return;
      }
      overrideHeaders = credentials.headersFor([requestedCredential]);
    }

    try {
      res.json(envelopeFor(tool, await tool.invoke(args, { headers: overrideHeaders })));
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        res.status(400).json({ ok: false, error: "invalid_arguments", message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`REST invocation failed (${output.name}/${identifier}): ${message}`);
      res.status(502).json({ ok: false, error: "upstream_error", message });
    }
  };

  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-encoding",
    "content-length",
  ]);

  /**
   * `proxy` outputs forward the original HTTP call to one API source: same
   * method, path, query and body. The client only ever sees the bridge URL;
   * upstream credentials and the upstream host stay on this side.
   */
  const proxyHandler = async (req: Request, res: Response): Promise<void> => {
    const output = res.locals.output as OutputConfig;
    const sourceName = output.sources[0]?.source ?? "";
    const apiConfig = store.config.apis.find((api) => api.name === sourceName);
    const detailBase = registry.getSource(sourceName)?.detail?.baseUrl;
    const baseUrl = (typeof detailBase === "string" && detailBase) || apiConfig?.baseUrl || "";
    if (!baseUrl) {
      res.status(502).json({ ok: false, error: "upstream_unavailable", message: `来源 "${sourceName}" 没有可用的 baseUrl。` });
      return;
    }
    const suffix = String(req.params[0] ?? "");
    const queryIndex = req.originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
    const target = `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}${query}`;

    // shortcut: OpenAPI `security` credentials are only applied by tool mode;
    // proxy outputs forward `headers` + saved credentialRefs, so use those
    // (or a source with header auth) when proxying a secured API.
    const headers: Record<string, string> = { ...(apiConfig?.headers ?? {}) };
    const contentType = req.get("content-type");
    if (contentType) headers["content-type"] = contentType;
    const accept = req.get("accept");
    if (accept) headers.accept = accept;

    const method = req.method.toUpperCase();
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : rawBody
          ? new Uint8Array(rawBody)
          : req.body === undefined
            ? undefined
            : JSON.stringify(req.body);

    try {
      const upstream = await fetch(target, {
        method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(apiConfig?.timeoutMs ?? config.server.requestTimeoutMs),
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("content-length", String(buffer.length));
      res.send(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Proxy invocation failed (${output.name}): ${message}`);
      res.status(502).json({ ok: false, error: "upstream_error", message });
    }
  };

  const notApiOutput = (res: Response, output: OutputConfig): boolean => {
    if (output.form.includes("api")) return false;
    res.status(404).json({ ok: false, error: "unsupported", message: `输出 "${output.name}" 没有 API 形态。` });
    return true;
  };

  router.all(`${config.server.rest.path}/:output`, apiOutputAuth, (req, res) => {
    const output = res.locals.output as OutputConfig;
    if (notApiOutput(res, output)) return;
    if (output.mode === "proxy") {
      void proxyHandler(req, res);
      return;
    }
    res.status(404).json({
      ok: false,
      error: "unknown_tool",
      message: `需要指定工具：${config.server.rest.path}/${output.name}/{tool}`,
    });
  });

  router.all(`${config.server.rest.path}/:output/*`, apiOutputAuth, (req, res) => {
    const output = res.locals.output as OutputConfig;
    if (notApiOutput(res, output)) return;
    if (output.mode === "proxy") {
      void proxyHandler(req, res);
      return;
    }
    void invokeHandler(req, res);
  });

  // ---------------------------------------------------------------------------
  // Web admin UI + admin API
  // ---------------------------------------------------------------------------

  const adminPath = config.server.admin.path.replace(/\/+$/, "") || "/admin";
  const adminApi = `${adminPath}/api`;
  const adminEnabled = config.server.admin.enabled;
  const adminAuthRequired = config.server.adminToken !== "";

  let adminHtmlCache: string | null = null;
  const loadAdminHtml = async (): Promise<string> => {
    if (adminHtmlCache) return adminHtmlCache;
    const file = new URL("../web/admin.html", import.meta.url);
    adminHtmlCache = await readFile(file, "utf8");
    return adminHtmlCache;
  };

  const kindOf = (value: unknown): SourceKind | undefined => {
    const raw = String(value ?? "").toLowerCase();
    if (raw === "mcp") return "mcp";
    if (raw === "api" || raw === "rest" || raw === "openapi") return "api";
    return undefined;
  };

  /** Accepts `{kind, entry}`, `{type: "mcp"|"api", ...}` or a bare entry. */
  const readEntry = (body: unknown): { kind?: SourceKind; entry: unknown } => {
    if (!isPlainObject(body)) return { entry: body };
    const kind = kindOf(body.kind ?? body.type);
    const entry = isPlainObject(body.entry) ? body.entry : body;
    return { kind, entry };
  };

  const sourceSummaries = () =>
    registry.getSources().map((source) => {
      const kind: SourceKind = source.type === "mcp" ? "mcp" : "api";
      return {
        ...source,
        kind,
        managed: store.isManaged(kind, source.name),
      };
    });

  const outputUrls = (output: OutputConfig) => ({
    mcp:
      output.form.includes("mcp") && output.mode !== "proxy"
        ? `${config.server.mcp.path}/${output.name}`
        : undefined,
    api: output.form.includes("api") ? `${config.server.rest.path}/${output.name}` : undefined,
    openapi:
      output.mode === "convert" && output.form.includes("api")
        ? `/openapi/${output.name}.json`
        : undefined,
  });

  const outputSummary = (output: OutputConfig) => {
    const tools = registry.getOutputTools(output);
    return {
      ...output,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        originalName: tool.originalName,
        source: tool.source,
        description: tool.description,
      })),
      missingTools: output.sources.flatMap((ref) =>
        ref.tools
          .filter((name) => !registry.getToolsForSource(ref.source).some((tool) => tool.originalName === name))
          .map((name) => `${ref.source}/${name}`),
      ),
      urls: outputUrls(output),
      managed: store.isManagedOutput(output.name),
    };
  };

  const applyStoreConfig = async (): Promise<void> => {
    // Output configs live inside the endpoint closures, so rebuild them.
    await closeEndpoints();
    registry.setConfig(store.config);
    await registry.reload();
  };

  router.get(adminPath, async (req, res, next) => {
    if (!adminEnabled) return next();
    try {
      const html = await loadAdminHtml();
      const bootstrap = {
        version: VERSION,
        baseUrl: publicBaseUrl(config, req),
        adminPath,
        adminApi,
        mcpPath: config.server.mcp.path,
        restPath: config.server.rest.path,
        authRequired: adminAuthRequired,
        restToken: config.server.auth.restToken !== "",
        mcpToken: config.server.auth.mcpToken !== "",
        configFile: path.join(config.configDir, "bridge.config.yaml"),
        storeFile: store.filePath,
      };
      const injected = html.replace(
        "__BRIDGE_BOOTSTRAP__",
        JSON.stringify(bootstrap).replace(/</g, "\\u003c"),
      );
      res.type("html").send(injected);
    } catch (error) {
      logger.error("Failed to serve admin page", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).type("text").send("Admin UI asset missing. Run the build (npm run build) first.");
    }
  });

  router.get(`${adminApi}/overview`, adminAuth, (_req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - runtime.startedAt) / 1000),
      tools: registry.toolCount,
      sources: sourceSummaries(),
      outputs: outputs().map(outputSummary),
      endpoints: {
        mcp: `${config.server.mcp.path}/{output}`,
        rest: `${config.server.rest.path}/{output}`,
      },
      admin: {
        enabled: adminEnabled,
        tokenRequired: adminAuthRequired,
        storeFile: store.filePath,
        specsDir: store.specsDir,
        credentialsFile: credentials.filePath,
        transformsFile: transforms.filePath,
        credentialCount: credentials.list().length,
        transformCount: transforms.list().length,
      },
    });
  });

  router.get(`${adminApi}/sources`, adminAuth, (_req, res) => {
    res.json({
      ok: true,
      sources: sourceSummaries(),
      config: {
        mcpServers: store.config.mcpServers,
        apis: store.config.apis,
      },
      managed: {
        mcpServers: store.listManaged("mcp"),
        apis: store.listManaged("api"),
      },
    });
  });

  /**
   * Tools of one source, with schemas, for the admin "接口测试" panel and the
   * output editor's tool checkboxes. Ignores exposure so a source can be tested
   * or published before it is exposed anywhere.
   */
  router.get(`${adminApi}/sources/:kind/:name/tools`, adminAuth, (req: Request, res: Response) => {
    const kind = kindOf(req.params.kind);
    if (!kind) {
      res.status(400).json({ ok: false, error: "invalid_kind", message: 'kind 必须是 "mcp" 或 "api"。' });
      return;
    }
    const source = registry.getSource(req.params.name);
    if (!source) {
      res.status(404).json({ ok: false, error: "unknown_source", message: `没有名为 "${req.params.name}" 的来源。` });
      return;
    }
    if ((kind === "mcp" ? "mcp" : "openapi") !== source.type) {
      res.status(400).json({ ok: false, error: "kind_mismatch", message: `来源 "${source.name}" 的类型是 ${source.type}。` });
      return;
    }
    const tools = registry.getToolsForSource(source.name).map((tool) => ({
      name: tool.originalName,
      fullName: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      ...toolHttpMeta(tool),
      exposed: { rest: registry.isExposed(tool, "rest"), mcp: registry.isExposed(tool, "mcp") },
    }));
    res.json({ ok: true, source: source.name, kind, type: source.type, count: tools.length, tools });
  });

  /** Invoke a single tool on behalf of the admin UI ("逐项测试"). */
  router.post(`${adminApi}/invoke`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const source = typeof body.source === "string" ? body.source : "";
    const identifier = typeof body.tool === "string" ? body.tool : "";
    if (!source || !identifier) {
      res.status(400).json({ ok: false, error: "invalid_request", message: "需要 source 和 tool。" });
      return;
    }
    const tool = registry.findTool(source, identifier);
    if (!tool) {
      res.status(404).json({ ok: false, error: "unknown_tool", message: `来源 "${source}" 上没有工具 "${identifier}"。` });
      return;
    }
    const args = isPlainObject(body.arguments) ? body.arguments : {};
    const issues = validateArgs(tool.inputSchema, args);
    if (issues.length > 0) {
      res.status(400).json({ ok: false, error: "invalid_arguments", issues, inputSchema: tool.inputSchema });
      return;
    }

    // Admin tester may switch the credential for this single call.
    let overrideHeaders: Record<string, string> | undefined;
    const chosenCredential = typeof body.credential === "string" ? body.credential.trim() : "";
    if (chosenCredential) {
      if (!credentials.list().some((credential) => credential.name === chosenCredential)) {
        res.status(400).json({ ok: false, error: "unknown_credential", message: `没有名为 "${chosenCredential}" 的凭证。` });
        return;
      }
      overrideHeaders = credentials.headersFor([chosenCredential]);
    }

    const startedAt = Date.now();
    try {
      const result = await tool.invoke(args, { headers: overrideHeaders });
      const raw = isPlainObject(body) && body.raw === true;
      const base = toolEnvelope(tool, result);
      // The admin tester shows both the upstream response and the orchestrated
      // one, so include the untouched envelope alongside the transformed result.
      const payload = raw
        ? base
        : {
            ...envelopeFor(tool, result, base),
            raw: { ok: base.ok, isError: base.isError, text: base.text, data: base.data, meta: base.meta },
          };
      res.json({
        ...payload,
        ...toolHttpMeta(tool),
        durationMs: Date.now() - startedAt,
        invokedAt: new Date(startedAt).toISOString(),
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof ToolArgumentError) {
        res.status(400).json({ ok: false, error: "invalid_arguments", message: error.message, durationMs });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Admin invocation failed (${source}/${identifier}): ${message}`);
      res.status(502).json({ ok: false, error: "upstream_error", message, durationMs });
    }
  });

  // Best-effort truncation so a huge sample doesn't blow up the response.
  const truncateSample = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === "object") {
      const json = JSON.stringify(value);
      return json.length > 200 ? `${json.slice(0, 197)}…` : value;
    }
    const text = String(value);
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  };

  /**
   * Discover the fields an upstream tool returns. We invoke the tool with no
   * arguments (best-effort) and walk the structured result, returning a flat
   * list of `{path, type, sample}` the orchestration UI can map from.
   */
  router.get(`${adminApi}/sources/:kind/:name/discover`, adminAuth, async (req: Request, res: Response) => {
    const kind = kindOf(req.params.kind);
    if (!kind) {
      res.status(400).json({ ok: false, error: "invalid_kind", message: 'kind 必须是 "mcp" 或 "api"。' });
      return;
    }
    const name = req.params.name;
    const identifier = typeof req.query.tool === "string" ? req.query.tool : "";
    const tool = registry.findTool(name, identifier);
    if (!tool) {
      res.status(404).json({ ok: false, error: "unknown_tool", message: `来源 "${name}" 上没有工具 "${identifier || "*"}"。` });
      return;
    }
    try {
      const result = await tool.invoke({});
      const structured =
        result.structuredContent !== undefined
          ? result.structuredContent
          : (() => {
              const parsed = safeJsonParse(textOf(result));
              return parsed.ok ? parsed.value : null;
            })();
      const fields = discoverFields(structured).map((field) => ({ ...field, sample: truncateSample(field.sample) }));
      res.json({ ok: true, source: name, tool: identifier || "*", fields, sample: truncateSample(structured) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Field discovery failed (${name}/${identifier || "*"}): ${message}`);
      res.json({
        ok: true,
        source: name,
        tool: identifier || "*",
        fields: [],
        sample: null,
        note: `无法自动探测字段：${message}\n请手动添加字段路径。`,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 认证信息 (credential vault)
  // ---------------------------------------------------------------------------

  /** Sources that reference a saved credential, for the UI "used by" column. */
  const credentialUsage = (): Record<string, string[]> => {
    const usage: Record<string, string[]> = {};
    for (const api of store.config.apis) {
      for (const name of api.credentialRefs ?? []) {
        (usage[name] ??= []).push(api.name);
      }
    }
    return usage;
  };

  const reloadAfterVaultChange = async (): Promise<void> => {
    store.rebuildNow();
    registry.setConfig(store.config);
    await registry.reload();
  };

  router.get(`${adminApi}/credentials`, adminAuth, (_req, res) => {
    const usage = credentialUsage();
    res.json({
      ok: true,
      file: credentials.filePath,
      credentials: credentials.list().map((credential) => ({
        ...maskCredential(credential),
        usedBy: usage[credential.name] ?? [],
      })),
    });
  });

  router.post(`${adminApi}/credentials`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const payload = isPlainObject(body.credential) ? body.credential : body;
    try {
      const saved = await credentials.upsert(payload);
      await reloadAfterVaultChange();
      res.json({
        ok: true,
        credential: { ...maskCredential(saved), usedBy: credentialUsage()[saved.name] ?? [] },
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        res.status(400).json({ ok: false, error: "invalid_credential", message: error.message });
        return;
      }
      throw error;
    }
  });

  router.delete(`${adminApi}/credentials/:name`, adminAuth, async (req: Request, res: Response) => {
    const removed = await credentials.remove(req.params.name);
    if (!removed) {
      res.status(404).json({ ok: false, error: "unknown_credential", message: `没有名为 "${req.params.name}" 的认证信息。` });
      return;
    }
    await reloadAfterVaultChange();
    res.json({ ok: true, name: req.params.name, usedBy: credentialUsage()[req.params.name] ?? [] });
  });

  // ---------------------------------------------------------------------------
  // 数据编排 (response transforms)
  // ---------------------------------------------------------------------------

  const readTransformTarget = (body: Record<string, unknown>): { source: string; tool: string } => {
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const tool = typeof body.tool === "string" && body.tool.trim() ? body.tool.trim() : "*";
    return { source, tool };
  };

  router.get(`${adminApi}/transforms`, adminAuth, (_req, res) => {
    res.json({
      ok: true,
      file: transforms.filePath,
      transforms: transforms.list(),
      sources: sourceSummaries(),
    });
  });

  router.get(`${adminApi}/transforms/:source/:tool`, adminAuth, (req: Request, res: Response) => {
    const entry = transforms.list().find((item) => item.source === req.params.source && item.tool === req.params.tool);
    if (!entry) {
      res.status(404).json({ ok: false, error: "unknown_transform", message: "该接口还没有配置数据编排。" });
      return;
    }
    res.json({ ok: true, transform: entry });
  });

  router.put(`${adminApi}/transforms`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const { source, tool } = readTransformTarget(body);
    if (!source) {
      res.status(400).json({ ok: false, error: "invalid_request", message: "需要 source。" });
      return;
    }
    try {
      const entry = await transforms.upsert(source, tool, body.config ?? body);
      res.json({ ok: true, transform: entry });
    } catch (error) {
      if (error instanceof ConfigError) {
        res.status(400).json({ ok: false, error: "invalid_transform", message: error.message });
        return;
      }
      throw error;
    }
  });

  router.delete(`${adminApi}/transforms/:source/:tool`, adminAuth, async (req: Request, res: Response) => {
    const removed = await transforms.remove(req.params.source, req.params.tool);
    if (!removed) {
      res.status(404).json({ ok: false, error: "unknown_transform", message: "该接口没有配置数据编排。" });
      return;
    }
    res.json({ ok: true, source: req.params.source, tool: req.params.tool });
  });

  /** Try a transform on a sample payload without saving it (UI live preview). */
  router.post(`${adminApi}/transforms/preview`, adminAuth, (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    try {
      const config = body.config ?? body;
      const result = applyTransform(config as TransformConfig, body.sample);
      res.json({ ok: true, value: result.value, source: result.from });
    } catch (error) {
      if (error instanceof ConfigError) {
        res.status(400).json({ ok: false, error: "invalid_transform", message: error.message });
        return;
      }
      throw error;
    }
  });

  router.post(`${adminApi}/sources`, adminAuth, async (req: Request, res: Response) => {
    const { kind, entry } = readEntry(req.body);
    if (!kind) {
      res.status(400).json({ ok: false, error: "invalid_kind", message: 'kind 必须是 "mcp" 或 "api"。' });
      return;
    }
    try {
      let payload: unknown = entry;
      if (kind === "api" && isPlainObject(entry) && typeof entry.specText === "string" && entry.specText.trim()) {
        const name = String(entry.name ?? "").trim() || "spec";
        const specPath = await store.writeSpecFile(name, entry.specText);
        const { specText: _specText, ...rest } = entry;
        payload = { ...rest, spec: specPath };
      }
      const saved = await store.upsert(kind, payload);
      await applyStoreConfig();
      const info = registry.getSource(saved.name);
      res.json({
        ok: true,
        kind,
        name: saved.name,
        source: info ? { ...info, managed: true } : undefined,
        tools: registry.toolCount,
      });
    } catch (error) {
      const status = error instanceof ConfigError ? 400 : 500;
      logger.warn(`Admin: failed to add ${kind} source`, { error: error instanceof Error ? error.message : String(error) });
      res.status(status).json({
        ok: false,
        error: status === 400 ? "invalid_source" : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.delete(`${adminApi}/sources/:kind/:name`, adminAuth, async (req: Request, res: Response) => {
    const kind = kindOf(req.params.kind);
    if (!kind) {
      res.status(400).json({ ok: false, error: "invalid_kind", message: 'kind 必须是 "mcp" 或 "api"。' });
      return;
    }
    const name = req.params.name;
    // Remove a managed (UI-added) entry, then hide any matching config-file
    // source. Doing both means a "taken over" source disappears completely, and
    // a file-only source is excluded from the running gateway (persisted, so it
    // stays gone after a restart without touching bridge.config.yaml).
    const removed = await store.remove(kind, name);
    const excluded = await store.exclude(kind, name);
    if (!removed && !excluded) {
      res.status(404).json({
        ok: false,
        error: "no_such_source",
        message: `没有名为 "${name}" 的 ${kind} 来源。`,
      });
      return;
    }
    await applyStoreConfig();
    res.json({
      ok: true,
      kind,
      name,
      action: removed ? "removed" : "excluded",
      tools: registry.toolCount,
    });
  });

  // ---------------------------------------------------------------------------
  // 输出 (published endpoints)
  // ---------------------------------------------------------------------------

  const validateOutput = (output: OutputConfig): string | undefined => {
    if (output.sources.length === 0) return "输出至少需要一个来源。";
    for (const ref of output.sources) {
      const source = registry.getSource(ref.source);
      if (!source) return `来源 "${ref.source}" 不存在。`;
      if (ref.tools.length > 0) {
        const available = new Set(registry.getToolsForSource(ref.source).map((tool) => tool.originalName));
        const unknown = ref.tools.filter((name) => !available.has(name));
        if (unknown.length > 0) return `来源 "${ref.source}" 没有这些工具：${unknown.join(", ")}`;
      }
    }
    if (output.mode === "proxy") {
      if (output.sources.length !== 1) return "原样透传只能绑定 1 个 API 来源。";
      if (registry.getSource(output.sources[0].source)?.type !== "openapi") {
        return "原样透传只能绑定 OpenAPI 来源（MCP 来源请用「镜像」）。";
      }
    }
    if (output.mode === "mirror") {
      if (output.sources.some((ref) => registry.getSource(ref.source)?.type !== "mcp")) {
        return "镜像模式只能绑定 MCP 来源。";
      }
      const names = registry.getOutputTools(output).map((tool) => tool.name);
      const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
      if (duplicates.length > 0) {
        return `镜像模式下工具名重复：${duplicates.join(", ")}。请裁掉冲突的工具或换一个组合。`;
      }
    }
    return undefined;
  };

  router.get(`${adminApi}/outputs`, adminAuth, (_req, res) => {
    res.json({ ok: true, outputs: outputs().map(outputSummary), sources: sourceSummaries() });
  });

  router.post(`${adminApi}/outputs`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) && isPlainObject(req.body.output) ? req.body.output : req.body;
    let output: OutputConfig;
    try {
      output = normalizeOutput(body);
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: "invalid_output",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const problem = validateOutput(output);
    if (problem) {
      res.status(400).json({ ok: false, error: "invalid_output", message: problem });
      return;
    }
    const saved = await store.upsertOutput(output);
    await applyStoreConfig();
    res.json({ ok: true, output: outputSummary(saved) });
  });

  router.delete(`${adminApi}/outputs/:name`, adminAuth, async (req: Request, res: Response) => {
    const name = req.params.name;
    const removed = await store.removeOutput(name);
    if (!removed) {
      const exists = Boolean(findOutput(name));
      res.status(exists ? 400 : 404).json({
        ok: false,
        error: exists ? "file_output" : "unknown_output",
        message: exists ? `输出 "${name}" 来自配置文件，请直接编辑 bridge.config.yaml。` : `没有名为 "${name}" 的输出。`,
      });
      return;
    }
    await applyStoreConfig();
    res.json({ ok: true, name });
  });

  router.get(`${adminApi}/outputs/:name/prompt`, adminAuth, (req: Request, res: Response) => {
    const output = findOutput(req.params.name);
    if (!output) {
      res.status(404).json({ ok: false, error: "unknown_output", message: `没有名为 "${req.params.name}" 的输出。` });
      return;
    }
    const tools = registry.getOutputTools(output);
    const text = buildPrompt(output, {
      baseUrl: publicBaseUrl(config, req),
      mcpPath: config.server.mcp.path,
      restPath: config.server.rest.path,
      tools,
      token: output.token || config.server.auth.mcpToken || config.server.auth.restToken,
    });
    res.json({ ok: true, text, toolCount: tools.length });
  });

  // ---------------------------------------------------------------------------
  // 一键导入：MCP 配置 / OpenAPI 文档 / URL / 启动命令
  // ---------------------------------------------------------------------------

  const slug = (value: string): string => {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
    return cleaned || "source";
  };

  const packageName = (args: string[]): string => {
    const target = args.find((arg) => !arg.startsWith("-")) ?? "";
    return target.replace(/^.*\//, "").replace(/@[^@]*$/, "") || target;
  };

  const claudeMcpEntry = (name: string, raw: unknown): Record<string, unknown> => {
    const value = isPlainObject(raw) ? raw : {};
    if (typeof value.command === "string") {
      return {
        name,
        description: typeof value.description === "string" ? value.description : undefined,
        transport: {
          type: "stdio",
          command: value.command,
          args: Array.isArray(value.args) ? value.args.map(String) : [],
          env: isPlainObject(value.env) ? value.env : {},
        },
      };
    }
    if (typeof value.url === "string") {
      return {
        name,
        description: typeof value.description === "string" ? value.description : undefined,
        transport: {
          type: value.type === "sse" ? "sse" : "http",
          url: value.url,
          headers: isPlainObject(value.headers) ? value.headers : {},
        },
      };
    }
    return { name, ...value };
  };

  type ImportPlan =
    | { kind: "mcp" | "api"; entry: Record<string, unknown> }
    | { kind: "mcp-batch"; entries: Record<string, unknown>[] }
    | { kind: "api-spec"; name: string; text: string };

  const detectImport = async (text: string): Promise<ImportPlan> => {
    let doc: unknown;
    const json = safeJsonParse(text);
    if (json.ok) doc = json.value;
    else if (/^[^\s]+:\s/m.test(text) || text.startsWith("{")) {
      try {
        doc = parseYaml(text);
      } catch {
        doc = undefined;
      }
    }

    if (isPlainObject(doc)) {
      if (isPlainObject(doc.mcpServers)) {
        return {
          kind: "mcp-batch",
          entries: Object.entries(doc.mcpServers).map(([name, raw]) => claudeMcpEntry(name, raw)),
        };
      }
      if (doc.openapi || doc.swagger || isPlainObject(doc.paths)) {
        const title = isPlainObject(doc.info) && typeof doc.info.title === "string" ? doc.info.title : "openapi";
        return { kind: "api-spec", name: slug(title), text };
      }
      if (isPlainObject(doc.transport) || doc.type === "mcp") {
        const name = typeof doc.name === "string" ? doc.name : "mcp";
        return { kind: "mcp", entry: { ...doc, name: slug(name) } };
      }
      if (typeof doc.command === "string" || typeof doc.url === "string") {
        const seed =
          typeof doc.name === "string"
            ? doc.name
            : typeof doc.url === "string"
              ? new URL(doc.url).hostname
              : packageName(Array.isArray(doc.args) ? doc.args.map(String) : []);
        return { kind: "mcp", entry: claudeMcpEntry(slug(seed), doc) };
      }
      if (typeof doc.spec === "string" || doc.type === "api") {
        return { kind: "api", entry: { ...doc, name: slug(typeof doc.name === "string" ? doc.name : "api") } };
      }
    }

    if (/^https?:\/\//i.test(text)) {
      const url = new URL(text);
      if (/\/(mcp|sse)\/?$/i.test(url.pathname) || /[?&](mcp|sse)=/i.test(url.search)) {
        const type = /sse/i.test(url.pathname) ? "sse" : "http";
        return { kind: "mcp", entry: { name: slug(url.hostname), transport: { type, url: text, headers: {} } } };
      }
      try {
        const response = await fetch(text, { signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        const parsed = safeJsonParse(body);
        if (parsed.ok && isPlainObject(parsed.value) && (parsed.value.openapi || parsed.value.swagger || isPlainObject(parsed.value.paths))) {
          const title = isPlainObject(parsed.value.info) && typeof parsed.value.info.title === "string" ? parsed.value.info.title : url.hostname;
          return { kind: "api-spec", name: slug(title), text: body };
        }
      } catch {
        // Not an OpenAPI document; fall through to a remote MCP server.
      }
      return { kind: "mcp", entry: { name: slug(url.hostname), transport: { type: "http", url: text, headers: {} } } };
    }

    const command = text.split(/\s+/).filter(Boolean);
    if (command.length > 0) {
      return {
        kind: "mcp",
        entry: {
          name: slug(packageName(command.slice(1))),
          transport: { type: "stdio", command: command[0], args: command.slice(1), env: {} },
        },
      };
    }
    throw new ConfigError("无法识别：请粘贴 MCP 配置 JSON、OpenAPI 文档、URL 或启动命令。");
  };

  router.post(`${adminApi}/import`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      res.status(400).json({ ok: false, error: "invalid_request", message: "需要 text（粘贴内容）。" });
      return;
    }
    try {
      const plan = await detectImport(text);
      const added: Array<{ kind: SourceKind; name: string }> = [];
      if (plan.kind === "mcp-batch") {
        for (const entry of plan.entries) {
          const saved = await store.upsert("mcp", entry);
          added.push({ kind: "mcp", name: saved.name });
        }
      } else if (plan.kind === "api-spec") {
        const specPath = await store.writeSpecFile(plan.name, plan.text);
        const saved = await store.upsert("api", { name: plan.name, spec: specPath });
        added.push({ kind: "api", name: saved.name });
      } else {
        const saved = await store.upsert(plan.kind, plan.entry);
        added.push({ kind: plan.kind, name: saved.name });
      }
      await applyStoreConfig();
      res.json({ ok: true, added, outputs: added.map((item) => slug(item.name)) });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: "import_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post(`${adminApi}/test`, adminAuth, async (req: Request, res: Response) => {
    const { kind, entry } = readEntry(req.body);
    if (!kind) {
      res.status(400).json({ ok: false, error: "invalid_kind", message: 'kind 必须是 "mcp" 或 "api"。' });
      return;
    }
    let normalized;
    try {
      let payload: unknown = entry;
      if (kind === "api" && isPlainObject(entry) && typeof entry.specText === "string" && entry.specText.trim()) {
        const name = String(entry.name ?? "").trim() || "preview";
        const specPath = await store.writeSpecFile(`${name}-preview`, entry.specText);
        const { specText: _specText, ...rest } = entry;
        payload = { ...rest, spec: specPath };
      }
      normalized = store.normalize(kind, payload);
      // Make "测试导入" behave like the live source: saved credentials are
      // materialized into headers before the upstream is called.
      if (kind === "api") {
        normalized = applyCredentialRefs([normalized as ApiConfig], {
          resolveCredentialHeaders: (names) => credentials.headersFor(names),
        })[0];
      }
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: "invalid_source",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const result = await testSource(kind, normalized, {
      logger,
      configDir: store.config.configDir,
    });
    res.status(result.ok ? 200 : 422).json(result);
  });

  /** Read the document's security schemes so the UI can prefill header names. */
  router.post(`${adminApi}/spec/schemes`, adminAuth, async (req: Request, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const entry = isPlainObject(body.entry) ? body.entry : body;
    let spec = typeof entry.spec === "string" ? entry.spec.trim() : "";
    const specText = typeof entry.specText === "string" ? entry.specText.trim() : "";
    try {
      if (!spec && specText) spec = await store.writeSpecFile("schemes-preview", specText);
      if (!spec) {
        res.status(400).json({ ok: false, error: "missing_spec", message: "需要 spec（文档地址）或 specText（文档内容）。" });
        return;
      }
      const loaded = await loadOpenApiDocument(spec, { configDir: store.config.configDir, logger });
      const components = isPlainObject(loaded.document.components) ? loaded.document.components : {};
      const schemes = isPlainObject(components.securitySchemes) ? components.securitySchemes : {};
      const result = Object.entries(schemes).map(([name, raw]) => {
        const scheme = isPlainObject(raw) ? raw : {};
        const type = typeof scheme.type === "string" ? scheme.type : "";
        const headerName =
          type === "apiKey"
            ? scheme.in === "header"
              ? String(scheme.name ?? "")
              : ""
            : ["http", "oauth2", "openIdConnect"].includes(type)
              ? "Authorization"
              : "";
        const credentialType =
          headerName === "Authorization" ? (String(scheme.scheme).toLowerCase() === "basic" ? "basic" : "bearer") : "header";
        return { name, headerName, credentialType };
      });
      res.json({ ok: true, convertedFromSwagger2: loaded.convertedFromSwagger2, schemes: result });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: "spec_load_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post(`${adminApi}/reload`, adminAuth, async (_req: Request, res: Response) => {
    await store.refresh();
    await applyStoreConfig();
    res.json({ ok: true, tools: registry.toolCount, sources: sourceSummaries() });
  });

  router.post("/admin/reload", adminAuth, async (_req: Request, res: Response) => {
    await store.refresh();
    await applyStoreConfig();
    res.json({ ok: true, tools: registry.toolCount, sources: registry.getSources() });
  });

  router.use((req, res) => {
    res.status(404).json({ ok: false, error: "not_found", message: `No route for ${req.method} ${req.path}` });
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    if (res.headersSent) return;
    res.status(400).json({ ok: false, error: "bad_request", message });
  });

  const mountPath = config.server.basePath && config.server.basePath !== "/" ? config.server.basePath : "";
  if (mountPath) app.use(mountPath, router);
  else app.use(router);

  const close = async (): Promise<void> => {
    await Promise.allSettled([...mcpEndpoints.values()].map((endpoint) => endpoint.close()));
    mcpEndpoints.clear();
  };

  return { app, close };
}
