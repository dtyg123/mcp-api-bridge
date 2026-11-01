import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { deepClone, isPlainObject } from "../util/json.js";

export type DocumentLoader = (uri: string) => Promise<unknown>;

export class RefResolutionError extends Error {}

function parseDocumentText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to YAML, JSON is a subset of YAML anyway
    }
  }
  return parseYaml(text);
}

/** Loads JSON/YAML documents from http(s) URLs or file:// URLs, with an in-memory cache. */
export function createDocumentLoader(headers: Record<string, string> = {}): DocumentLoader {
  const cache = new Map<string, Promise<unknown>>();
  return (uri: string) => {
    const cached = cache.get(uri);
    if (cached) return cached;
    const promise = (async () => {
      if (/^https?:\/\//i.test(uri)) {
        const response = await fetch(uri, { headers, redirect: "follow" });
        if (!response.ok) throw new RefResolutionError(`GET ${uri} -> HTTP ${response.status}`);
        return parseDocumentText(await response.text());
      }
      if (uri.startsWith("file://")) {
        return parseDocumentText(await readFile(fileURLToPath(uri), "utf8"));
      }
      throw new RefResolutionError(`Unsupported document URI: ${uri}`);
    })();
    cache.set(uri, promise);
    promise.catch(() => cache.delete(uri));
    return promise;
  };
}

function getByPointer(document: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return document;
  const parts = pointer
    .replace(/^\//, "")
    .split("/")
    .map((part) => decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = document;
  for (const part of parts) {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      throw new RefResolutionError(`Cannot resolve pointer segment "${part}" in ${pointer}`);
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) throw new RefResolutionError(`Unresolvable $ref pointer: ${pointer}`);
  }
  return current;
}

function splitRef(ref: string): { uri: string; pointer: string } {
  const hashIndex = ref.indexOf("#");
  if (hashIndex === -1) return { uri: ref, pointer: "" };
  return { uri: ref.slice(0, hashIndex), pointer: ref.slice(hashIndex + 1) };
}

function resolveUri(ref: string, baseUri: string): string {
  try {
    return new URL(ref, baseUri).toString();
  } catch {
    throw new RefResolutionError(`Cannot resolve relative $ref "${ref}" against "${baseUri}"`);
  }
}

class Resolver {
  private readonly documents = new Map<string, Promise<unknown>>();
  private readonly resolved = new Map<string, unknown>();
  readonly warnings: string[] = [];
  private readonly maxDepth: number;
  private readonly rootUri?: string;
  private readonly rootDocument?: unknown;

  constructor(
    private readonly load: DocumentLoader,
    options: { maxDepth?: number; rootUri?: string; rootDocument?: unknown } = {},
  ) {
    this.maxDepth = options.maxDepth ?? 64;
    this.rootUri = options.rootUri;
    this.rootDocument = options.rootDocument;
  }

  private getDocument(uri: string): Promise<unknown> {
    if (this.rootDocument !== undefined && uri === this.rootUri) return Promise.resolve(this.rootDocument);
    let pending = this.documents.get(uri);
    if (!pending) {
      pending = this.load(uri);
      this.documents.set(uri, pending);
      pending.catch(() => this.documents.delete(uri));
    }
    return pending;
  }

  async resolve(rootUri: string): Promise<unknown> {
    const document = await this.getDocument(rootUri);
    return this.walk(document, rootUri, new Set([`${rootUri}#`]), 0);
  }

  /** Inline refs in an already-loaded root document (e.g. after conversion). */
  async resolveDocument(document: unknown, rootUri: string): Promise<unknown> {
    return this.walk(document, rootUri, new Set([`${rootUri}#`]), 0);
  }

  private async walk(node: unknown, baseUri: string, stack: Set<string>, depth: number): Promise<unknown> {
    if (depth > this.maxDepth) {
      this.warnings.push(`Maximum $ref depth (${this.maxDepth}) exceeded at ${baseUri}`);
      return node;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) out.push(await this.walk(item, baseUri, stack, depth + 1));
      return out;
    }
    if (!isPlainObject(node)) return node;

    const ref = node.$ref;
    if (typeof ref === "string") {
      const { uri: uriPart, pointer } = splitRef(ref);
      const targetUri = uriPart ? resolveUri(uriPart, baseUri) : baseUri;
      const key = `${targetUri}#${pointer}`;

      let resolvedTarget: unknown;
      if (this.resolved.has(key)) {
        resolvedTarget = this.resolved.get(key);
      } else if (stack.has(key)) {
        this.warnings.push(`Circular $ref detected: ${key} (replaced with permissive schema)`);
        resolvedTarget = {};
      } else {
        const document = await this.getDocument(targetUri);
        const target = getByPointer(document, pointer);
        const nextStack = new Set(stack);
        nextStack.add(key);
        resolvedTarget = await this.walk(target, targetUri, nextStack, depth + 1);
        this.resolved.set(key, resolvedTarget);
      }

      const siblings: Record<string, unknown> = {};
      for (const [key2, value] of Object.entries(node)) {
        if (key2 === "$ref") continue;
        siblings[key2] = await this.walk(value, baseUri, stack, depth + 1);
      }
      const cloned = deepClone(resolvedTarget);
      if (Object.keys(siblings).length === 0) return cloned;
      // JSON Schema 2020-12 allows siblings next to $ref; merge them shallowly.
      if (isPlainObject(cloned)) return { ...cloned, ...siblings };
      return cloned;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = await this.walk(value, baseUri, stack, depth + 1);
    }
    return out;
  }
}

/** Inline every `$ref` in the document (local and external, JSON or YAML). */
export async function dereference(
  rootUri: string,
  load: DocumentLoader,
  options: { maxDepth?: number; rootDocument?: unknown } = {},
): Promise<{ document: unknown; warnings: string[] }> {
  const resolver = new Resolver(load, { maxDepth: options.maxDepth, rootUri, rootDocument: options.rootDocument });
  const document =
    options.rootDocument !== undefined
      ? await resolver.resolveDocument(options.rootDocument, rootUri)
      : await resolver.resolve(rootUri);
  return { document, warnings: resolver.warnings };
}
