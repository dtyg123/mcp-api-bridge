import type { ContentBlock, JsonSchema, ToolResult, BridgeTool } from "../types.js";
import type { SecurityCredential } from "../config.js";
import { isPlainObject, stringify } from "../util/json.js";
import { ToolArgumentError } from "../util/errors.js";
import { globMatch } from "../util/naming.js";
import { ensureObjectSchema, hoistDefinitions, requiredList } from "./schema.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

type ParamLocation = "path" | "query" | "header" | "cookie";

type ParamPlan = {
  /** Argument name exposed to the model. */
  key: string;
  location: ParamLocation;
  /** Name as used by the upstream API. */
  name: string;
  style?: string;
  explode?: boolean;
  required: boolean;
  schema: JsonSchema;
  description?: string;
};

type BodyPlan = {
  kind: "none" | "merged-json" | "json" | "form" | "multipart" | "text" | "binary";
  contentType: string;
  required: boolean;
  fields: Array<{ key: string; name: string; required: boolean; schema: JsonSchema }>;
  /** Argument key used for whole-body modes. */
  argKey?: string;
  schema?: JsonSchema;
};

type SecurityRequirement = {
  scheme: string;
  type: "apiKey" | "basic" | "bearer" | "oauth2" | "openIdConnect";
  in?: "header" | "query" | "cookie";
  name?: string;
};

type RequestPlan = {
  method: HttpMethod;
  pathTemplate: string;
  baseUrl: string;
  params: ParamPlan[];
  body: BodyPlan;
  headers: Record<string, string>;
  security: SecurityRequirement[][];
  credentials: Record<string, SecurityCredential>;
  timeoutMs: number;
};

export type OpenApiTool = BridgeTool & { request: RequestPlan; method: HttpMethod; pathTemplate: string };

export type BuildToolsOptions = {
  sourceName: string;
  document: Record<string, unknown>;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  credentials: Record<string, SecurityCredential>;
  timeoutMs: number;
  include?: string[];
  exclude?: string[];
  logger?: { warn: (msg: string) => void; debug: (msg: string) => void };
};

function pickContent(content: unknown): { contentType: string; schema: JsonSchema } | null {
  if (!isPlainObject(content)) return null;
  const entries = Object.entries(content).filter(([, value]) => isPlainObject(value));
  if (entries.length === 0) return null;
  const preference = [
    (type: string) => type === "application/json",
    (type: string) => type.endsWith("+json"),
    (type: string) => type === "application/x-www-form-urlencoded",
    (type: string) => type === "multipart/form-data",
    (type: string) => type.startsWith("text/"),
    (type: string) => type === "application/octet-stream",
  ];
  for (const matches of preference) {
    const found = entries.find(([type]) => matches(type.split(";")[0].trim().toLowerCase()));
    if (found) {
      const schema = isPlainObject(found[1]) && isPlainObject(found[1].schema) ? (found[1].schema as JsonSchema) : {};
      return { contentType: found[0].split(";")[0].trim(), schema };
    }
  }
  const [contentType, media] = entries[0];
  const schema = isPlainObject(media) && isPlainObject(media.schema) ? (media.schema as JsonSchema) : {};
  return { contentType: contentType.split(";")[0].trim(), schema };
}

function describeParam(location: ParamLocation, description: string | undefined): string {
  const label = location === "path" ? "path parameter" : `${location} parameter`;
  return description ? `(${label}) ${description}` : `(${label})`;
}

function collectParameters(pathItem: Record<string, unknown>, operation: Record<string, unknown>): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      if (!isPlainObject(item)) continue;
      const name = typeof item.name === "string" ? item.name : "";
      const location = typeof item.in === "string" ? item.in : "";
      if (!name || !["path", "query", "header", "cookie"].includes(location)) continue;
      merged.set(`${location}:${name.toLowerCase()}`, item);
    }
  }
  return [...merged.values()];
}

function normalizeSecurity(document: Record<string, unknown>, operation: Record<string, unknown>): SecurityRequirement[][] {
  const raw = Array.isArray(operation.security) ? operation.security : Array.isArray(document.security) ? document.security : [];
  const schemes = isPlainObject(document.components) && isPlainObject(document.components.securitySchemes) ? document.components.securitySchemes : {};
  const requirements: SecurityRequirement[][] = [];
  for (const alternative of raw) {
    if (!isPlainObject(alternative)) continue;
    const group: SecurityRequirement[] = [];
    for (const schemeName of Object.keys(alternative)) {
      const scheme = (schemes as Record<string, unknown>)[schemeName];
      if (!isPlainObject(scheme)) continue;
      const type = String(scheme.type ?? "");
      if (type === "apiKey") {
        group.push({
          scheme: schemeName,
          type: "apiKey",
          in: ["header", "query", "cookie"].includes(String(scheme.in)) ? (scheme.in as "header" | "query" | "cookie") : "header",
          name: String(scheme.name ?? schemeName),
        });
      } else if (type === "http") {
        const httpScheme = String(scheme.scheme ?? "").toLowerCase();
        if (httpScheme === "basic") group.push({ scheme: schemeName, type: "basic" });
        else group.push({ scheme: schemeName, type: "bearer" });
      } else if (type === "oauth2" || type === "openIdConnect") {
        group.push({ scheme: schemeName, type: "oauth2" });
      }
    }
    if (group.length > 0) requirements.push(group);
  }
  return requirements;
}

function filterMatch(candidates: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => candidates.some((candidate) => globMatch(pattern, candidate)));
}

export function buildOpenApiTools(options: BuildToolsOptions): OpenApiTool[] {
  const document = options.document;
  const paths = isPlainObject(document.paths) ? document.paths : {};
  const tools: OpenApiTool[] = [];

  for (const [pathTemplate, pathItemRaw] of Object.entries(paths)) {
    if (!isPlainObject(pathItemRaw)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItemRaw[method];
      if (!isPlainObject(operation)) continue;
      const operationId = typeof operation.operationId === "string" && operation.operationId.trim() ? operation.operationId.trim() : "";
      if (operation.deprecated === true) continue;

      const candidates = [
        `${method.toUpperCase()} ${pathTemplate}`,
        `${method.toLowerCase()} ${pathTemplate}`,
        pathTemplate,
        operationId,
      ].filter(Boolean);

      if (options.include && options.include.length > 0 && !filterMatch(candidates, options.include)) continue;
      if (options.exclude && options.exclude.length > 0 && filterMatch(candidates, options.exclude)) continue;

      const tool = buildSingleTool({ ...options, pathTemplate, pathItem: pathItemRaw, method, operation, operationId });
      if (tool) tools.push(tool);
    }
  }

  return tools;
}

function buildSingleTool(input: BuildToolsOptions & {
  pathTemplate: string;
  pathItem: Record<string, unknown>;
  method: HttpMethod;
  operation: Record<string, unknown>;
  operationId: string;
}): OpenApiTool | null {
  const { operation, pathItem, method, pathTemplate } = input;
  const usedKeys = new Set<string>();
  const params: ParamPlan[] = [];
  const argParts: Array<{ key: string; schema: JsonSchema; description?: string; required: boolean }> = [];

  const claim = (name: string, preferred: string): string => {
    let candidate = preferred;
    let index = 2;
    while (usedKeys.has(candidate)) {
      candidate = `${preferred}_${index}`;
      index += 1;
    }
    usedKeys.add(candidate);
    return candidate;
  };

  for (const raw of collectParameters(pathItem, operation)) {
    const location = raw.in as ParamLocation;
    const name = String(raw.name);
    const schema = isPlainObject(raw.schema)
      ? (raw.schema as JsonSchema)
      : pickContent(raw.content)?.schema ?? { type: "string" };
    const key = claim(name, name);
    const required = raw.required === true || location === "path";
    const description = describeParam(location, typeof raw.description === "string" ? raw.description : undefined);
    params.push({
      key,
      location,
      name,
      required,
      schema,
      style: typeof raw.style === "string" ? raw.style : undefined,
      explode: typeof raw.explode === "boolean" ? raw.explode : undefined,
      description,
    });
    argParts.push({ key, schema, description, required });
  }

  const body: BodyPlan = { kind: "none", contentType: "", required: false, fields: [] };
  const requestBody = isPlainObject(operation.requestBody) ? operation.requestBody : undefined;
  if (requestBody) {
    const picked = pickContent(requestBody.content);
    if (picked) {
      const bodyRequired = requestBody.required === true;
      const contentType = picked.contentType;
      const rawSchema: JsonSchema = isPlainObject(picked.schema) ? (picked.schema as JsonSchema) : {};
      body.contentType = contentType;
      body.required = bodyRequired;

      const isJson = contentType === "application/json" || contentType.endsWith("+json");
      const isForm = contentType === "application/x-www-form-urlencoded";
      const isMultipart = contentType === "multipart/form-data";
      const isText = contentType.startsWith("text/");
      const isBinary = contentType === "application/octet-stream" || contentType.startsWith("image/") || contentType.startsWith("audio/") || contentType.startsWith("video/") || contentType === "application/pdf";

      const objectSchema = ensureObjectSchema(rawSchema);
      const canMerge = (isJson || isForm || isMultipart) && isObjectLike(objectSchema);
      const schema = canMerge ? objectSchema : rawSchema;
      if (canMerge) {
        body.kind = isJson ? "merged-json" : isForm ? "form" : "multipart";
        const requiredProps = bodyRequired ? requiredList(schema) : [];
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        for (const [propName, propSchema] of Object.entries(properties)) {
          const key = claim(propName, usedKeys.has(propName) ? `body_${propName}` : propName);
          const required = requiredProps.includes(propName);
          body.fields.push({ key, name: propName, required, schema: (propSchema as JsonSchema) ?? {} });
          argParts.push({
            key,
            schema: isPlainObject(propSchema) ? (propSchema as JsonSchema) : {},
            description: isPlainObject(propSchema) && typeof propSchema.description === "string" ? propSchema.description : `(request body) ${propName}`,
            required,
          });
        }
        // Preserve the raw schema (including additionalProperties) for documentation.
        body.schema = schema;
        if (Object.keys(properties).length === 0) {
          body.kind = isJson ? "json" : isForm ? "form" : "multipart";
          body.argKey = claim("body", "body");
          argParts.push({
            key: body.argKey,
            schema,
            description: "(request body)",
            required: bodyRequired,
          });
        }
      } else {
        body.kind = isBinary ? "binary" : isText ? "text" : isJson ? "json" : isForm ? "form" : isMultipart ? "multipart" : "text";
        body.argKey = claim("body", "body");
        body.schema = schema;
        argParts.push({
          key: body.argKey,
          schema,
          description: `(request body, ${contentType})`,
          required: bodyRequired,
        });
      }
    }
  }

  // Build the MCP input schema, hoisting nested definitions to the root.
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const defs: Record<string, JsonSchema> = {};
  for (const part of argParts) {
    const hoisted = hoistDefinitions(part.schema, `${part.key}_`);
    const property: Record<string, unknown> = { ...hoisted.schema };
    if (part.description && !property.description) property.description = part.description;
    properties[part.key] = property;
    if (part.required) required.push(part.key);
    Object.assign(defs, hoisted.defs);
  }

  const inputSchema: JsonSchema = { type: "object", properties, required, additionalProperties: false };
  if (Object.keys(defs).length > 0) inputSchema.$defs = defs;

  const title = typeof operation.summary === "string" && operation.summary ? operation.summary : undefined;
  const description =
    (typeof operation.description === "string" && operation.description.trim()) ||
    title ||
    `${method.toUpperCase()} ${pathTemplate}`;
  const originalName = sanitizeOperationId(input.operationId || `${method}_${pathTemplate}`);

  const request: RequestPlan = {
    method,
    pathTemplate,
    baseUrl: input.baseUrl,
    params,
    body,
    headers: { ...input.defaultHeaders },
    security: normalizeSecurity(input.document, operation),
    credentials: input.credentials,
    timeoutMs: input.timeoutMs,
  };

  return {
    source: input.sourceName,
    sourceType: "openapi",
    name: originalName,
    originalName,
    title,
    description,
    inputSchema,
    method,
    pathTemplate,
    annotations: { readOnlyHint: method === "get" || method === "head" },
    request,
    invoke: async (args, ctx) => executeOpenApiTool(request, args, ctx?.signal),
  };
}

function isObjectLike(schema: JsonSchema): boolean {
  if (schema.type === "object") return true;
  if (isPlainObject(schema.properties)) return true;
  if (schema.type === undefined && schema.allOf !== undefined) return true;
  return false;
}

export function sanitizeOperationId(raw: string): string {
  const cleaned = raw
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "operation";
}

type PreparedRequest = {
  url: string;
  init: RequestInit;
};

export function buildRequest(plan: RequestPlan, args: Record<string, unknown>): PreparedRequest {
  const headers: Record<string, string> = { accept: "application/json, text/plain;q=0.9, */*;q=0.8", ...plan.headers };
  const query: Array<[string, string]> = [];
  const cookies: string[] = [];
  let body: BodyInit | undefined;

  // Path parameters
  let path = plan.pathTemplate;
  for (const param of plan.params) {
    if (param.location !== "path") continue;
    const value = args[param.key];
    if (value === undefined || value === null || value === "") {
      throw new ToolArgumentError(`Missing required path parameter "${param.key}"`);
    }
    path = path.split(`{${param.name}}`).join(encodeURIComponent(String(value)));
  }
  const unresolved = /\{([^}]+)\}/.exec(path);
  if (unresolved) throw new ToolArgumentError(`Unresolved path parameter "${unresolved[1]}" in ${plan.pathTemplate}`);

  for (const param of plan.params) {
    const value = args[param.key];
    if (value === undefined || value === null) continue;
    if (param.location === "path") continue;
    if (param.location === "header") {
      headers[param.name.toLowerCase()] = serializeSimple(value, param.explode);
      continue;
    }
    if (param.location === "cookie") {
      cookies.push(`${param.name}=${encodeURIComponent(String(value))}`);
      continue;
    }
    appendQueryParam(query, param.name, value, param.explode, param.style);
  }

  // Request body
  if (plan.body.kind === "merged-json") {
    const payload: Record<string, unknown> = {};
    for (const field of plan.body.fields) {
      const value = args[field.key];
      if (value !== undefined) payload[field.name] = value;
    }
    const missing = plan.body.fields.filter((field) => field.required && args[field.key] === undefined).map((field) => field.key);
    if (missing.length > 0) throw new ToolArgumentError(`Missing required body field(s): ${missing.join(", ")}`);
    body = JSON.stringify(payload);
    headers["content-type"] = plan.body.contentType;
  } else if (plan.body.kind === "json") {
    const value = plan.body.argKey ? args[plan.body.argKey] : undefined;
    if (value === undefined) {
      if (plan.body.required) throw new ToolArgumentError(`Missing required body argument "${plan.body.argKey}"`);
    } else {
      body = typeof value === "string" ? value : JSON.stringify(value);
      headers["content-type"] = plan.body.contentType || "application/json";
    }
  } else if (plan.body.kind === "form" || plan.body.kind === "multipart") {
    const fields: Record<string, unknown> = {};
    for (const field of plan.body.fields) {
      if (args[field.key] !== undefined) fields[field.name] = args[field.key];
    }
    if (plan.body.kind === "form") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) appendFormValue(params, key, value);
      body = params.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        if (isPlainObject(value) && typeof value.content === "string") {
          const buffer = Buffer.from(value.content, "base64");
          form.append(key, new Blob([new Uint8Array(buffer)], { type: typeof value.contentType === "string" ? value.contentType : "application/octet-stream" }), String(value.filename ?? key));
        } else if (Array.isArray(value)) {
          for (const item of value) form.append(key, String(item));
        } else {
          form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
      }
      body = form;
    }
  } else if (plan.body.kind === "text") {
    const value = plan.body.argKey ? args[plan.body.argKey] : undefined;
    if (value !== undefined) {
      body = typeof value === "string" ? value : JSON.stringify(value);
      headers["content-type"] = plan.body.contentType || "text/plain";
    } else if (plan.body.required) {
      throw new ToolArgumentError(`Missing required body argument "${plan.body.argKey}"`);
    }
  } else if (plan.body.kind === "binary") {
    const value = plan.body.argKey ? args[plan.body.argKey] : undefined;
    if (typeof value === "string") {
      body = new Uint8Array(Buffer.from(value, "base64"));
      headers["content-type"] = plan.body.contentType || "application/octet-stream";
    } else if (plan.body.required) {
      throw new ToolArgumentError(`Missing required body argument "${plan.body.argKey}" (base64 string expected)`);
    }
  }

  // Security
  applySecurity(plan, headers, query, cookies);

  if (cookies.length > 0) headers.cookie = cookies.join("; ");

  const url = new URL(plan.baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`));
  for (const [key, value] of query) url.searchParams.append(key, value);

  const init: RequestInit = { method: plan.method.toUpperCase(), headers };
  if (body !== undefined && plan.method !== "get" && plan.method !== "head") init.body = body;

  return { url: url.toString(), init };
}

function serializeSimple(value: unknown, explode?: boolean): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, item]) => (explode === false ? `${key},${item}` : `${key}=${item}`))
      .join(",");
  }
  return String(value);
}

function appendQueryParam(
  query: Array<[string, string]>,
  name: string,
  value: unknown,
  explode: boolean | undefined,
  style: string | undefined,
): void {
  if (Array.isArray(value)) {
    if (explode === false) {
      const separator =
        style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
      query.push([name, value.map((item) => String(item)).join(separator)]);
    } else {
      for (const item of value) query.push([name, String(item)]);
    }
    return;
  }
  if (isPlainObject(value)) {
    if (style === "deepObject") {
      for (const [key, item] of Object.entries(value)) query.push([`${name}[${key}]`, String(item)]);
      return;
    }
    if (explode === false) {
      query.push([name, Object.entries(value).flatMap(([key, item]) => [key, String(item)]).join(",")]);
      return;
    }
    for (const [key, item] of Object.entries(value)) query.push([key, String(item)]);
    return;
  }
  query.push([name, String(value)]);
}

function appendFormValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendFormValue(params, key, item);
    return;
  }
  if (isPlainObject(value)) {
    params.append(key, JSON.stringify(value));
    return;
  }
  params.append(key, String(value));
}

function applySecurity(
  plan: RequestPlan,
  headers: Record<string, string>,
  query: Array<[string, string]>,
  cookies: string[],
): void {
  for (const alternative of plan.security) {
    const values = alternative.map((requirement) => ({ requirement, credential: plan.credentials[requirement.scheme] }));
    if (values.every((entry) => entry.credential && (entry.credential.token || entry.credential.apiKey || entry.credential.username))) {
      for (const { requirement, credential } of values) {
        const secret = credential?.token ?? credential?.apiKey ?? "";
        if (requirement.type === "apiKey") {
          if (requirement.in === "query") query.push([requirement.name ?? "api_key", secret]);
          else if (requirement.in === "cookie") cookies.push(`${requirement.name ?? "api_key"}=${encodeURIComponent(secret)}`);
          else headers[(requirement.name ?? "x-api-key").toLowerCase()] = secret;
        } else if (requirement.type === "basic") {
          const raw = `${credential?.username ?? ""}:${credential?.password ?? ""}`;
          headers.authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
        } else {
          headers.authorization = `Bearer ${secret}`;
        }
      }
      return;
    }
  }
}

export async function executeOpenApiTool(
  plan: RequestPlan,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const prepared = buildRequest(plan, args);
  const timeout = AbortSignal.timeout(plan.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(prepared.url, { ...prepared.init, signal: combined });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Request to ${prepared.url} failed: ${message}` }],
      isError: true,
      meta: { url: prepared.url },
    };
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const meta = { status: response.status, url: prepared.url, contentType };

  if (contentType.startsWith("image/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      content: [{ type: "image", data: buffer.toString("base64"), mimeType: contentType }],
      isError: !response.ok,
      meta,
    };
  }

  const text = await response.text();
  const truncated = text.length > 200_000 ? `${text.slice(0, 200_000)}\n... [truncated ${text.length - 200_000} characters]` : text;
  const content: ContentBlock[] = [];

  let structured: unknown;
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try {
      structured = JSON.parse(text);
      content.push({ type: "text", text: stringify(structured) });
    } catch {
      content.push({ type: "text", text: truncated });
    }
  } else {
    content.push({ type: "text", text: truncated.length > 0 ? truncated : `HTTP ${response.status} ${response.statusText}`.trim() });
  }

  if (!response.ok) {
    content.unshift({
      type: "text",
      text: `HTTP ${response.status} ${response.statusText}`.trim(),
    });
    return { content, isError: true, meta };
  }

  return { content, structuredContent: structured, isError: false, meta };
}
