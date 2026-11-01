import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";
import { createDocumentLoader, dereference } from "./resolve.js";
import { convertSwagger2ToOpenApi, isSwagger2Document, Swagger2Error } from "./swagger2.js";

export type LoadedDocument = {
  /** Plain JSON object (all $refs inlined). */
  document: Record<string, unknown>;
  /** URI the document was loaded from. */
  sourceUri: string;
  /** Base URL extracted from `servers[0].url` (may be empty). */
  serverUrl: string;
  /** True when the source document was Swagger 2.0 and got converted on load. */
  convertedFromSwagger2: boolean;
};

export class OpenApiLoadError extends Error {}

export function toDocumentUri(spec: string, configDir: string): string {
  if (/^https?:\/\//i.test(spec) || spec.startsWith("file://")) return spec;
  return pathToFileURL(path.resolve(configDir, spec)).toString();
}

function substituteServerVariables(url: string, variables: unknown): string {
  if (!isPlainObject(variables)) return url;
  return url.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    if (isPlainObject(variable) && variable.default !== undefined) return String(variable.default);
    return match;
  });
}

function readServerUrl(document: Record<string, unknown>): string {
  const servers = document.servers;
  if (!Array.isArray(servers) || servers.length === 0) return "";
  const first = servers[0];
  if (!isPlainObject(first) || typeof first.url !== "string") return "";
  return substituteServerVariables(first.url, first.variables);
}

export async function loadOpenApiDocument(
  spec: string,
  options: { configDir: string; headers?: Record<string, string>; logger?: Logger },
): Promise<LoadedDocument> {
  const sourceUri = toDocumentUri(spec, options.configDir);
  const loader = createDocumentLoader(options.headers ?? {});
  const raw = await loader(sourceUri);

  // Swagger 2.0 is common in the wild (Rainyun, swaggo-generated docs). Convert
  // it in-process instead of making the user run swagger2openapi first.
  let root: unknown = raw;
  let convertedFromSwagger2 = false;
  if (isSwagger2Document(raw)) {
    try {
      root = convertSwagger2ToOpenApi(raw);
      convertedFromSwagger2 = true;
      options.logger?.info?.(`${spec}: converted Swagger 2.0 document to OpenAPI 3.1`);
    } catch (error) {
      const message = error instanceof Swagger2Error ? error.message : String(error);
      throw new OpenApiLoadError(`${spec}: failed to convert Swagger 2.0 document: ${message}`);
    }
  } else if (isPlainObject(raw) && raw.swagger !== undefined) {
    throw new OpenApiLoadError(
      `${spec}: unsupported Swagger version "${String(raw.swagger)}". Only Swagger 2.0 and OpenAPI 3.x are supported.`,
    );
  }

  const { document, warnings } = await dereference(sourceUri, loader, { rootDocument: root });
  for (const warning of warnings) options.logger?.warn(warning);

  if (!isPlainObject(document)) throw new OpenApiLoadError(`${spec}: document root must be an object`);

  const version = typeof document.openapi === "string" ? document.openapi : "";
  if (!/^3\./.test(version)) {
    throw new OpenApiLoadError(`${spec}: unsupported document. Expected an OpenAPI 3.x "openapi" field, got "${version || "missing"}".`);
  }
  if (!isPlainObject(document.paths)) {
    throw new OpenApiLoadError(`${spec}: document has no "paths" object`);
  }

  const serverUrl = readServerUrl(document);
  return { document, sourceUri, serverUrl, convertedFromSwagger2 };
}

/** Resolve the effective base URL for an API source. */
export function resolveBaseUrl(options: {
  configured?: string;
  serverUrl: string;
  sourceUri: string;
  example: string;
}): string {
  const candidate = (options.configured && options.configured.trim()) || options.serverUrl;
  if (!candidate) {
    throw new OpenApiLoadError(
      `No base URL found for API source "${options.example}". Set apis[].baseUrl or add servers[0].url to the document.`,
    );
  }
  try {
    // Relative server URLs (e.g. "/v1") are resolved against the document URL.
    const resolved = new URL(candidate, options.sourceUri);
    if (!/^https?:$/.test(resolved.protocol)) throw new Error("not http");
    return resolved.toString().replace(/\/$/, "");
  } catch {
    if (/^https?:\/\//i.test(candidate)) return candidate.replace(/\/$/, "");
    throw new OpenApiLoadError(
      `Base URL "${candidate}" for API source "${options.example}" is not an absolute http(s) URL. Set apis[].baseUrl explicitly.`,
    );
  }
}
