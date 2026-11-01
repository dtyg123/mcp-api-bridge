import type { BridgeTool, JsonSchema } from "../types.js";
import { isPlainObject } from "../util/json.js";
import { downgradeSchemaTo30, hoistDefinitions, pointsToComponents, requiredList } from "./schema.js";

export type BuildDocumentOptions = {
  tools: BridgeTool[];
  title: string;
  description: string;
  version: "3.0" | "3.1";
  serverUrl: string;
  /** Prefix prepended to every generated path, e.g. `/api`. */
  basePath: string;
  versionString?: string;
};

const RESULT_SCHEMA_NAME = "BridgeToolResult";

function resultEnvelopeRef(): Record<string, unknown> {
  return { $ref: `#/components/schemas/${RESULT_SCHEMA_NAME}` };
}

function isSimpleValueSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if (typeof schema.$ref === "string") return false;
  const type = schema.type;
  if (Array.isArray(type)) return type.every((item) => item !== "object");
  if (typeof type === "string") {
    if (type === "object") return false;
    if (type === "array") return isSimpleValueSchema(schema.items);
    return true;
  }
  // Untyped schemas are treated as free-form strings for query usage.
  return schema.properties === undefined && schema.anyOf === undefined && schema.oneOf === undefined;
}

function joinPath(basePath: string, ...segments: string[]): string {
  const parts = [basePath.replace(/\/+$/, ""), ...segments].filter((part) => part !== "");
  return `/${parts.join("/").replace(/^\/+/, "")}`;
}

export function buildOpenApiDocument(options: BuildDocumentOptions): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    [RESULT_SCHEMA_NAME]: {
      type: "object",
      description: "Uniform envelope returned by every bridged tool endpoint.",
      properties: {
        ok: { type: "boolean", description: "False when the tool reported an error." },
        source: { type: "string", description: "Upstream MCP server or API name." },
        tool: { type: "string", description: "Tool name upstream." },
        isError: { type: "boolean" },
        text: { type: "string", description: "Concatenated text content, for convenience." },
        data: { description: "Parsed structured payload when the upstream returned JSON." },
        content: {
          type: "array",
          description: "Raw MCP content blocks.",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
  };

  for (const tool of options.tools) {
    const defPrefix = `${tool.source}_${tool.originalName}_`;
    const hoisted = hoistDefinitions(tool.inputSchema, defPrefix);
    const bodySchema = pointsToComponents(hoisted.schema) as JsonSchema;
    Object.assign(schemas, pointsToComponents(hoisted.defs as JsonSchema) as Record<string, JsonSchema>);

    const toolPath = joinPath(options.basePath, tool.source, tool.originalName);
    const operationId = `${tool.source}__${tool.originalName}`;
    const firstLine = tool.description.split("\n")[0].trim();
    const summary = tool.title?.trim() || firstLine.slice(0, 120) || tool.originalName;

    const postOperation: Record<string, unknown> = {
      operationId: sanitizeOperationId(operationId),
      summary,
      description: tool.description,
      tags: [tool.source],
      "x-mcp-tool": { source: tool.source, name: tool.originalName },
      requestBody: {
        required: requiredList(bodySchema).length > 0,
        content: { "application/json": { schema: bodySchema } },
      },
      responses: {
        "200": {
          description: "Tool invocation result (check `isError` in the envelope).",
          content: { "application/json": { schema: resultEnvelopeRef() } },
        },
        "400": { description: "Invalid arguments." },
        "404": { description: "Unknown tool." },
        "502": { description: "Upstream failure." },
      },
    };

    const pathItem: Record<string, unknown> = { post: postOperation };

    const properties = isPlainObject(bodySchema.properties) ? bodySchema.properties : {};
    const queryProperties: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(properties)) {
      if (isSimpleValueSchema(schema)) queryProperties[key] = schema;
    }
    if (Object.keys(queryProperties).length > 0) {
      const required = requiredList(bodySchema).filter((key) => key in queryProperties);
      pathItem.get = {
        operationId: sanitizeOperationId(`${operationId}__get`),
        summary: `${summary} (query string variant)`,
        description: `${tool.description}\n\nConvenience GET variant: pass the tool arguments as query parameters.`,
        tags: [tool.source],
        "x-mcp-tool": { source: tool.source, name: tool.originalName },
        parameters: Object.entries(queryProperties).map(([key, schema]) => ({
          name: key,
          in: "query",
          required: required.includes(key),
          schema: schema as JsonSchema,
          description: isPlainObject(schema) && typeof schema.description === "string" ? schema.description : undefined,
        })),
        responses: {
          "200": {
            description: "Tool invocation result (check `isError` in the envelope).",
            content: { "application/json": { schema: resultEnvelopeRef() } },
          },
          "400": { description: "Invalid arguments." },
          "404": { description: "Unknown tool." },
          "502": { description: "Upstream failure." },
        },
      };
    }

    paths[toolPath] = pathItem;
  }

  const document: Record<string, unknown> = {
    openapi: options.version === "3.0" ? "3.0.3" : "3.1.0",
    info: {
      title: options.title,
      version: options.versionString ?? "1.0.0",
      description: options.description,
    },
    servers: [{ url: options.serverUrl.replace(/\/$/, "") }],
    paths: Object.keys(paths).length > 0 ? paths : {},
    components: {
      schemas: options.version === "3.0" ? (downgradeSchemaTo30(schemas) as Record<string, unknown>) : schemas,
    },
    "x-bridge": {
      generator: "mcp-api-bridge",
      toolCount: options.tools.length,
      generatedAt: new Date().toISOString(),
    },
  };

  if (options.version === "3.0") {
    document.paths = downgradeSchemaTo30(paths) as Record<string, unknown>;
  }

  return document;
}

function sanitizeOperationId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_.-]+/g, "_");
}
