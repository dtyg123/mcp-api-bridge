import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isPlainObject } from "./util/json.js";
import type { LogLevel } from "./util/logger.js";

export type ExposureConfig = {
  /** Expose these tools on the REST surface (`/api/...`). */
  rest: boolean;
  /** Expose these tools on the MCP surface (`/mcp`). */
  mcp: boolean;
  /** Prefix added to the generated gateway tool name. */
  prefix: string;
};

export type StdioTransportConfig = {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type HttpTransportConfig = {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
};

export type McpServerConfig = {
  name: string;
  description?: string;
  transport: StdioTransportConfig | HttpTransportConfig;
  exposure: ExposureConfig;
  /** How long upstream tool listings are cached, in ms. */
  cacheTtlMs: number;
  /** Pass client cancellation through to the upstream server. */
  timeoutMs: number;
};

export type SecurityCredential = {
  /** Bearer token / api key / oauth token. */
  token?: string;
  /** Alias for `token`. */
  apiKey?: string;
  username?: string;
  password?: string;
};

export type ApiConfig = {
  name: string;
  description?: string;
  /** OpenAPI document location: absolute URL or path relative to the config file. */
  spec: string;
  /** Overrides `servers[0].url` from the document. */
  baseUrl?: string;
  /** Headers added to every request (e.g. static API keys). */
  headers: Record<string, string>;
  /** Per-securityScheme credentials, keyed by scheme name. */
  security: Record<string, SecurityCredential>;
  /** Names of saved credentials (管理台「认证信息」) merged into `headers`. */
  credentialRefs: string[];
  include?: string[];
  exclude?: string[];
  exposure: ExposureConfig;
  timeoutMs: number;
};

export type BridgeConfig = {
  server: {
    host: string;
    port: number;
    basePath: string;
    publicBaseUrl?: string;
    cors: boolean;
    requestTimeoutMs: number;
    bodyLimit: string;
    auth: { restToken: string; mcpToken: string };
    mcp: { path: string; sessionMode: "stateful" | "stateless"; jsonResponse: boolean };
    rest: { path: string };
    adminToken: string;
    admin: {
      enabled: boolean;
      path: string;
      /** JSON file holding sources added through the web UI. */
      storeFile: string;
      /** Directory for OpenAPI documents pasted into the web UI. */
      specsDir: string;
    };
  };
  openapi: { version: "3.0" | "3.1"; title: string; description: string };
  mcpServers: McpServerConfig[];
  apis: ApiConfig[];
  logging: { level: LogLevel; format: "text" | "json" };
  /** Absolute path of the config file (filled in by the loader). */
  configDir: string;
};

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class ConfigError extends Error {}

function interpolate(value: unknown, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
      const fromEnv = process.env[name];
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, missing));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, missing);
    return out;
  }
  return value;
}

function asString(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    out[key] = String(item);
  }
  return out;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [String(value)];
}

function normalizeExposure(raw: unknown, defaultPrefix: string): ExposureConfig {
  const source = isPlainObject(raw) ? raw : {};
  return {
    rest: asBool(source.rest, true),
    mcp: asBool(source.mcp, true),
    prefix: asString(source.prefix, defaultPrefix),
  };
}

function normalizeTransport(raw: unknown, configDir: string): StdioTransportConfig | HttpTransportConfig {
  if (!isPlainObject(raw)) throw new ConfigError(`mcpServers[].transport is required`);
  const type = asString(raw.type, "").toLowerCase();
  if (type === "stdio" || (!type && raw.command)) {
    const command = asString(raw.command, "");
    if (!command) throw new ConfigError(`stdio transport requires "command"`);
    return {
      type: "stdio",
      command,
      args: asStringArray(raw.args) ?? [],
      env: asStringMap(raw.env),
      cwd: raw.cwd ? path.resolve(configDir, asString(raw.cwd)) : undefined,
    };
  }
  if (type === "http" || type === "streamable-http" || type === "sse") {
    const url = asString(raw.url, "");
    if (!url) throw new ConfigError(`http/sse transport requires "url"`);
    return { type: type === "sse" ? "sse" : "http", url, headers: asStringMap(raw.headers) };
  }
  throw new ConfigError(`Unsupported transport type "${type}" (expected stdio | http | sse)`);
}

export function normalizeMcpServer(raw: unknown, index: number, configDir: string): McpServerConfig {
  if (!isPlainObject(raw)) throw new ConfigError(`mcpServers[${index}] must be an object`);
  const name = asString(raw.name, `mcp-${index + 1}`);
  return {
    name,
    description: raw.description ? asString(raw.description) : undefined,
    transport: normalizeTransport(raw.transport, configDir),
    exposure: normalizeExposure(raw.exposure, ""),
    cacheTtlMs: asNumber(raw.cacheTtlMs, 15_000),
    timeoutMs: asNumber(raw.timeoutMs, 120_000),
  };
}

export function normalizeApi(raw: unknown, index: number, configDir: string): ApiConfig {
  if (!isPlainObject(raw)) throw new ConfigError(`apis[${index}] must be an object`);
  const spec = asString(raw.spec, "");
  if (!spec) throw new ConfigError(`apis[${index}].spec is required`);
  const security: Record<string, SecurityCredential> = {};
  if (isPlainObject(raw.security)) {
    for (const [scheme, value] of Object.entries(raw.security)) {
      if (isPlainObject(value)) {
        security[scheme] = {
          token: value.token ? String(value.token) : undefined,
          apiKey: value.apiKey ? String(value.apiKey) : undefined,
          username: value.username ? String(value.username) : undefined,
          password: value.password !== undefined ? String(value.password) : undefined,
        };
      } else if (value !== undefined && value !== null) {
        security[scheme] = { token: String(value) };
      }
    }
  }
  return {
    name: asString(raw.name, `api-${index + 1}`),
    description: raw.description ? asString(raw.description) : undefined,
    spec,
    baseUrl: raw.baseUrl ? asString(raw.baseUrl) : undefined,
    headers: asStringMap(raw.headers),
    security,
    credentialRefs: asStringArray(raw.credentialRefs) ?? [],
    include: asStringArray(raw.include),
    exclude: asStringArray(raw.exclude),
    exposure: normalizeExposure(raw.exposure, ""),
    timeoutMs: asNumber(raw.timeoutMs, 60_000),
  };
}

export async function loadConfig(configPath: string): Promise<BridgeConfig> {
  const absolute = path.resolve(configPath);
  let rawText: string;
  try {
    rawText = await readFile(absolute, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${absolute}: ${error instanceof Error ? error.message : error}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${absolute}: ${error instanceof Error ? error.message : error}`);
  }
  if (!isPlainObject(parsed)) throw new ConfigError(`Config file ${absolute} must contain an object`);

  const missing = new Set<string>();
  const doc = interpolate(parsed, missing) as Record<string, unknown>;
  const serverRaw = isPlainObject(doc.server) ? doc.server : {};
  const authRaw = isPlainObject(serverRaw.auth) ? serverRaw.auth : {};
  const mcpRaw = isPlainObject(serverRaw.mcp) ? serverRaw.mcp : {};
  const restRaw = isPlainObject(serverRaw.rest) ? serverRaw.rest : {};
  const adminRaw = isPlainObject(serverRaw.admin) ? serverRaw.admin : {};
  const openapiRaw = isPlainObject(doc.openapi) ? doc.openapi : {};
  const loggingRaw = isPlainObject(doc.logging) ? doc.logging : {};
  const configDir = path.dirname(absolute);
  const dataDir = path.resolve(configDir, asString(adminRaw.dataDir, process.env.BRIDGE_DATA_DIR ?? "data"));

  const level = asString(loggingRaw.level, process.env.LOG_LEVEL ?? "info") as LogLevel;
  const config: BridgeConfig = {
    server: {
      host: asString(serverRaw.host, process.env.HOST ?? "0.0.0.0"),
      port: asNumber(serverRaw.port, asNumber(process.env.PORT, 8080)),
      basePath: asString(serverRaw.basePath, ""),
      publicBaseUrl: serverRaw.publicBaseUrl ? asString(serverRaw.publicBaseUrl) : process.env.PUBLIC_BASE_URL,
      cors: asBool(serverRaw.cors, true),
      requestTimeoutMs: asNumber(serverRaw.requestTimeoutMs, 120_000),
      bodyLimit: asString(serverRaw.bodyLimit, "10mb"),
      auth: {
        restToken: asString(authRaw.rest, process.env.BRIDGE_REST_TOKEN ?? ""),
        mcpToken: asString(authRaw.mcp, process.env.BRIDGE_MCP_TOKEN ?? ""),
      },
      mcp: {
        path: asString(mcpRaw.path, "/mcp"),
        sessionMode: asString(mcpRaw.sessionMode, "stateful") === "stateless" ? "stateless" : "stateful",
        jsonResponse: asBool(mcpRaw.jsonResponse, false),
      },
      rest: { path: asString(restRaw.path, "/api") },
      adminToken: asString(serverRaw.adminToken, process.env.BRIDGE_ADMIN_TOKEN ?? ""),
      admin: {
        enabled: asBool(adminRaw.enabled, true),
        path: asString(adminRaw.path, "/admin"),
        storeFile: path.resolve(configDir, asString(adminRaw.storeFile, path.join(dataDir, "managed-sources.json"))),
        specsDir: path.resolve(configDir, asString(adminRaw.specsDir, path.join(dataDir, "specs"))),
      },
    },
    openapi: {
      version: asString(openapiRaw.version, "3.1") === "3.0" ? "3.0" : "3.1",
      title: asString(openapiRaw.title, "MCP Bridge API"),
      description: asString(
        openapiRaw.description,
        "Auto-generated REST surface for MCP tools. Every endpoint is a JSON-RPC style tool invocation.",
      ),
    },
    mcpServers: Array.isArray(doc.mcpServers)
      ? doc.mcpServers.map((item, index) => normalizeMcpServer(item, index, configDir))
      : [],
    apis: Array.isArray(doc.apis) ? doc.apis.map((item, index) => normalizeApi(item, index, configDir)) : [],
    logging: {
      level: (["debug", "info", "warn", "error"] as LogLevel[]).includes(level) ? level : "info",
      format: asString(loggingRaw.format, "text") === "json" ? "json" : "text",
    },
    configDir,
  };

  const seen = new Set<string>();
  for (const server of config.mcpServers) {
    if (seen.has(server.name)) throw new ConfigError(`Duplicate MCP server name "${server.name}"`);
    seen.add(server.name);
  }
  for (const api of config.apis) {
    if (seen.has(api.name)) throw new ConfigError(`Duplicate source name "${api.name}" (apis[].name / mcpServers[].name must be unique)`);
    seen.add(api.name);
  }

  if (missing.size > 0) {
    process.stderr.write(
      `warning: config references unset environment variables: ${[...missing].join(", ")} (substituted with empty string)\n`,
    );
  }

  return config;
}

/** Raw entries persisted by the web UI. */
export type ManagedPayload = {
  mcpServers: unknown[];
  apis: unknown[];
};

export function emptyManagedPayload(): ManagedPayload {
  return { mcpServers: [], apis: [] };
}

/**
 * Overlay sources added through the web UI on top of the file-based config.
 * Entries with the same name replace the file-based one (so the UI can also
 * "take over" a source that was originally written by hand).
 *
 * `resolveCredentialHeaders` materializes `apis[].credentialRefs` (saved
 * credentials from the admin vault) into request headers.
 */
export function mergeSources(
  base: BridgeConfig,
  managed: ManagedPayload,
  onWarning?: (message: string) => void,
  options?: { resolveCredentialHeaders?: (names: string[]) => Record<string, string>; onMissingCredential?: (name: string) => void },
): BridgeConfig {
  const mcpServers = [...base.mcpServers];
  managed.mcpServers.forEach((raw, index) => {
    try {
      const normalized = normalizeMcpServer(raw, index, base.configDir);
      const existing = mcpServers.findIndex((server) => server.name === normalized.name);
      if (existing >= 0) mcpServers[existing] = normalized;
      else mcpServers.push(normalized);
    } catch (error) {
      onWarning?.(`Ignoring managed MCP server #${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const apis = [...base.apis];
  managed.apis.forEach((raw, index) => {
    try {
      const normalized = normalizeApi(raw, index, base.configDir);
      const existing = apis.findIndex((api) => api.name === normalized.name);
      if (existing >= 0) apis[existing] = normalized;
      else apis.push(normalized);
    } catch (error) {
      onWarning?.(`Ignoring managed API #${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { ...base, mcpServers, apis: applyCredentialRefs(apis, options) };
}

/** Merge saved credentials into the headers of every API that references them. */
export function applyCredentialRefs(
  apis: ApiConfig[],
  options?: { resolveCredentialHeaders?: (names: string[]) => Record<string, string>; onMissingCredential?: (name: string) => void },
): ApiConfig[] {
  const resolve = options?.resolveCredentialHeaders;
  if (!resolve) return apis;
  return apis.map((api) => {
    if (!Array.isArray(api.credentialRefs) || api.credentialRefs.length === 0) return api;
    const fromVault = resolve(api.credentialRefs);
    if (Object.keys(fromVault).length === 0) return api;
    const headers: Record<string, string> = { ...fromVault };
    // Explicit headers win, and drop the same header in a different casing so
    // the upstream never receives the key twice.
    for (const [key, value] of Object.entries(api.headers)) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
      }
      headers[key] = value;
    }
    return { ...api, headers };
  });
}
