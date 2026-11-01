import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { BridgeConfig } from "../config.js";
import { ConfigError, applyCredentialRefs, type ApiConfig } from "../config.js";
import { buildPrompt, type PromptKind } from "../admin/prompts.js";
import { testSource } from "../admin/service.js";
import { maskCredential, type CredentialStore } from "../admin/credentials.js";
import type { SourceKind, SourceStore } from "../admin/store.js";
import { applyTransform, discoverFields, type TransformConfig, type TransformStore } from "../admin/transforms.js";
import { buildOpenApiDocument } from "../convert/tools-to-openapi.js";
import { createGatewayServer, describeTools } from "../mcp/gateway.js";
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

  const restAuth = requireToken(config.server.auth.restToken);
  const mcpAuth = requireToken(config.server.auth.mcpToken);
  const adminAuth = requireToken(config.server.adminToken);

  const mcpEndpoints = new Map<string, McpHttpEndpoint>();

  const buildEndpoint = (sourceName?: string): McpHttpEndpoint => {
    const key = sourceName ?? "__all__";
    const existing = mcpEndpoints.get(key);
    if (existing) return existing;
    const endpoint = new McpHttpEndpoint({
      name: sourceName ? `bridge:${sourceName}` : "mcp-api-bridge",
      mode: config.server.mcp.sessionMode,
      jsonResponse: config.server.mcp.jsonResponse,
      logger: logger.child(`mcp-http${sourceName ? `:${sourceName}` : ""}`),
      createServer: () =>
        createGatewayServer({
          name: sourceName ? `bridge-${sourceName}` : "mcp-api-bridge",
          version: VERSION,
          instructions: sourceName
            ? `MCP bridge endpoint exposing tools from "${sourceName}".`
            : "Tools bridged from MCP servers and OpenAPI services. Tool names are prefixed with their source.",
          listTools: () => registry.getTools("mcp", sourceName),
          getTool: (name) => {
            const tool = registry.getTool(name);
            if (!tool) return undefined;
            if (sourceName && tool.source !== sourceName) return undefined;
            return registry.isExposed(tool, "mcp") ? tool : undefined;
          },
          logger: logger.child(`mcp${sourceName ? `:${sourceName}` : ""}`),
        }),
    });
    mcpEndpoints.set(key, endpoint);
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
    res.json({
      name: "mcp-api-bridge",
      version: VERSION,
      description: "Bidirectional MCP <-> API gateway.",
      endpoints: {
        mcp: `${base}${config.server.mcp.path}`,
        mcpPerSource: `${base}${config.server.mcp.path}/{source}`,
        restCall: `${base}${config.server.rest.path}/{source}/{tool}`,
        openapi: `${base}/openapi.json`,
        tools: `${base}/tools`,
        health: `${base}/health`,
        admin: config.server.admin.enabled ? `${base}${adminPath}` : undefined,
      },
      tools: registry.toolCount,
      sources: registry.getSources(),
    });
  });

  router.get("/openapi.json", restAuth, (req, res) => {
    const requested = String(req.query.version ?? config.openapi.version);
    const version: "3.0" | "3.1" = requested === "3.0" ? "3.0" : "3.1";
    const document = buildOpenApiDocument({
      tools: registry.getTools("rest"),
      title: config.openapi.title,
      description: config.openapi.description,
      version,
      serverUrl: publicBaseUrl(config, req),
      basePath: config.server.rest.path,
      versionString: VERSION,
    });
    res.type("application/json").send(JSON.stringify(document, null, 2));
  });

  router.get("/tools", restAuth, (req, res) => {
    const surface = String(req.query.surface ?? "mcp") === "rest" ? "rest" : "mcp";
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const tools = registry.getTools(surface, source);
    res.json({ count: tools.length, surface, tools: describeTools(tools) });
  });

  // ---------------------------------------------------------------------------
  // MCP surface (API -> MCP and MCP -> MCP)
  // ---------------------------------------------------------------------------

  router.all(config.server.mcp.path, mcpAuth, async (req, res) => {
    await buildEndpoint().handle(req, res);
  });

  router.all(`${config.server.mcp.path}/:source`, mcpAuth, async (req, res) => {
    const source = req.params.source;
    if (!registry.hasSource(source)) {
      res.status(404).json({ ok: false, error: "unknown_source", message: `No source named "${source}".` });
      return;
    }
    await buildEndpoint(source).handle(req, res);
  });

  // ---------------------------------------------------------------------------
  // REST surface (MCP -> API and API -> API)
  // ---------------------------------------------------------------------------

  const invokeHandler = async (req: Request, res: Response): Promise<void> => {
    const source = req.params.source;
    const identifier = req.params.tool;
    const tool = registry.findTool(source, identifier);
    if (!tool || !registry.isExposed(tool, "rest")) {
      res.status(404).json({
        ok: false,
        error: "unknown_tool",
        message: `No tool "${identifier}" on source "${source}".`,
        hint: `${publicBaseUrl(config, req)}${config.server.rest.path === "/" ? "" : config.server.rest.path}/tools`,
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

    // Optional per-request credential switch (only when the source allows it,
    // and only among the credentials it already references).
    const requestedCredential = req.get("x-bridge-credential");
    let overrideHeaders: Record<string, string> | undefined;
    if (requestedCredential) {
      const apiConfig = store.config.apis.find((api) => api.name === source);
      if (!apiConfig?.allowCredentialSwitch) {
        res.status(403).json({
          ok: false,
          error: "credential_switch_disabled",
          message: `来源 "${source}" 未允许调用方切换凭证（allowCredentialSwitch=false）。`,
        });
        return;
      }
      if (!apiConfig.credentialRefs.includes(requestedCredential)) {
        res.status(400).json({
          ok: false,
          error: "credential_not_allowed",
          message: `凭证 "${requestedCredential}" 未被来源 "${source}" 引用。`,
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
      logger.error(`REST invocation failed (${source}/${identifier}): ${message}`);
      res.status(502).json({ ok: false, error: "upstream_error", message });
    }
  };

  router.get(`${config.server.rest.path}/:source/:tool`, restAuth, invokeHandler);
  router.post(`${config.server.rest.path}/:source/:tool`, restAuth, invokeHandler);

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

  const promptKindOf = (value: unknown): PromptKind | undefined => {
    const raw = String(value ?? "");
    if (raw === "mcp" || raw === "rest" || raw === "service" || raw === "add-mcp" || raw === "add-api") return raw;
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

  const applyStoreConfig = async (): Promise<void> => {
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
      endpoints: {
        mcp: config.server.mcp.path,
        rest: config.server.rest.path,
        openapi: "/openapi.json",
        tools: "/tools",
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
   * Tools of one source, with schemas, for the admin "接口测试" panel.
   * Unlike `/tools` this ignores the exposure flags so a source can be tested
   * before it is publicly exposed.
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

  router.get(`${adminApi}/prompt`, adminAuth, (req: Request, res: Response) => {
    const kind = promptKindOf(req.query.kind);
    if (!kind) {
      res.status(400).json({
        ok: false,
        error: "invalid_kind",
        message: "kind 必须是 mcp | rest | add-mcp | add-api。",
      });
      return;
    }
    const source = typeof req.query.source === "string" && req.query.source ? req.query.source : undefined;
    const surface = kind === "rest" ? "rest" : "mcp";
    const tools = registry.getTools(surface, source);
    const text = buildPrompt(kind, {
      baseUrl: publicBaseUrl(config, req),
      mcpPath: config.server.mcp.path,
      restPath: config.server.rest.path,
      mcpToken: config.server.auth.mcpToken,
      restToken: config.server.auth.restToken,
      configFile: path.join(config.configDir, "bridge.config.yaml"),
      tools,
      source,
      hint: {
        name: typeof req.query.name === "string" ? req.query.name : "",
        command: typeof req.query.command === "string" ? req.query.command : "",
        url: typeof req.query.url === "string" ? req.query.url : "",
        spec: typeof req.query.spec === "string" ? req.query.spec : "",
        note: typeof req.query.note === "string" ? req.query.note : "",
      },
    });
    res.json({ ok: true, kind, source, text, toolCount: tools.length });
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
