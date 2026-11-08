/**
 * Response "building blocks" (数据编排).
 *
 * A transform describes how an upstream result is reshaped before it is sent
 * to the API consumer: which fields survive, what they are called, and which
 * values are added on the fly (current time, fixed text, counts, ...).
 *
 * Everything here is pure and synchronous so it can be reused by the HTTP
 * layer, the admin preview endpoint and the tests.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../config.js";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";

export const NOW_FORMATS = ["iso", "date", "time", "timestamp", "locale"] as const;
export type NowFormat = (typeof NOW_FORMATS)[number];

export type TransformBlock =
  /** Copy a value out of the payload (optionally under a new name). */
  | { op: "field"; from: string; as?: string }
  /** Render a text template; `{{path}}` placeholders are filled from the payload. */
  | { op: "text"; as: string; template: string }
  /** Emit a fixed value (string, number, boolean, object, ...). */
  | { op: "constant"; as: string; value: unknown }
  /** Emit the current time in one of several shapes. */
  | { op: "now"; as: string; format?: NowFormat; offsetSeconds?: number }
  /** Length of an array (or number of keys of an object). */
  | { op: "count"; from: string; as: string }
  /** Join an array into a string. */
  | { op: "join"; from: string; as: string; separator?: string }
  /** Drop an inherited field (useful together with passthrough). */
  | { op: "omit"; from: string }
  /** Reshape every element of an array with its own block list. */
  | { op: "each"; from: string; as: string; blocks: TransformBlock[] };

export type TransformConfig = {
  /** Where the blocks read from. Empty = the whole payload. `data.items` also works. */
  root?: string;
  /** Keep fields that no block mentions (default false: only the blocks decide). */
  passthrough?: boolean;
  blocks: TransformBlock[];
};

export type TransformEntry = {
  /** Output that applies this transform (transforms are output-scoped). */
  output: string;
  source: string;
  /** Tool name, or "*" for a source-wide default within this output. */
  tool: string;
  config: TransformConfig;
  updatedAt: string;
};

/**
 * A field discovered by walking an upstream response.
 *
 * `path` is the dotted/bracketed path that can be fed straight into a `field`
 * block's `from` (e.g. `data[].Title`). `isArrayItem` flags paths that live
 * inside an array — the UI uses it to render the field as a list.
 */
export type FieldInfo = {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  sample: unknown;
  isArrayItem: boolean;
};

/**
 * Recursively walk a JSON value and collect every leaf (and array-element)
 * path. Array items are reported with a `[]` placeholder (`data[].Title`),
 * so the same shape works whether the array has zero, one or many elements.
 * Object keys order is preserved; paths are de-duplicated (first wins).
 */
export function discoverFields(value: unknown, prefix = ""): FieldInfo[] {
  const collected: FieldInfo[] = [];
  const walk = (val: unknown, current: string): void => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      if (val.length === 0) return;
      const first = val[0];
      if (first !== null && typeof first === "object" && !Array.isArray(first)) {
        for (const key of Object.keys(first)) {
          const path = current ? `${current}[].${key}` : `[].${key}`;
          const child = (first as Record<string, unknown>)[key];
          collected.push(fieldOf(path, child));
          if (child !== null && typeof child === "object") walk(child, path);
        }
      } else {
        const path = current ? `${current}[]` : "[]";
        collected.push(fieldOf(path, first));
      }
      return;
    }
    if (typeof val === "object") {
      for (const key of Object.keys(val)) {
        const path = current ? `${current}.${key}` : key;
        const child = (val as Record<string, unknown>)[key];
        collected.push(fieldOf(path, child));
        if (child !== null && typeof child === "object") walk(child, path);
      }
    }
  };
  walk(value, prefix);
  const seen = new Set<string>();
  return collected.filter((field) => {
    if (seen.has(field.path)) return false;
    seen.add(field.path);
    return true;
  });
}

function fieldOf(path: string, value: unknown): FieldInfo {
  let type: FieldInfo["type"];
  if (value === null) type = "null";
  else if (Array.isArray(value)) type = "array";
  else if (typeof value === "object") type = "object";
  else type = typeof value as FieldInfo["type"];
  return { path, type, sample: value, isArrayItem: path.includes("[]") };
}

const MAX_DEPTH = 5;
const OPS = ["field", "text", "constant", "now", "count", "join", "omit", "each"] as const;

/** `a.b[0].c` -> ["a","b",0,"c"] */
export function parsePath(raw: string): Array<string | number> {
  const segments: Array<string | number> = [];
  let buffer = "";
  const text = String(raw ?? "").trim();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === ".") {
      if (buffer) segments.push(buffer);
      buffer = "";
      continue;
    }
    if (ch === "[") {
      if (buffer) segments.push(buffer);
      buffer = "";
      const close = text.indexOf("]", i);
      if (close === -1) throw new ConfigError(`路径 "${raw}" 的方括号没有闭合。`);
      const inner = text.slice(i + 1, close).trim().replace(/^["']|["']$/g, "");
      if (/^-?\d+$/.test(inner)) segments.push(Number(inner));
      else if (inner) segments.push(inner);
      i = close;
      continue;
    }
    buffer += ch;
  }
  if (buffer) segments.push(buffer);
  return segments;
}

/** Read `path` out of `value`; returns undefined when any hop is missing. */
export function readPath(value: unknown, rawPath: string): unknown {
  const path = typeof rawPath === "string" ? parsePath(rawPath) : [];
  let cursor: unknown = value;
  for (const segment of path) {
    if (cursor === undefined || cursor === null) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
      continue;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Fill `{{ a.b }}` placeholders from `source`; unknown paths become "". */
export function renderTemplate(template: string, source: unknown): string {
  return String(template ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = readPath(source, rawPath);
    return stringifyValue(value);
  });
}

export function formatNow(format: NowFormat = "iso", offsetSeconds = 0): unknown {
  const date = new Date(Date.now() + offsetSeconds * 1000);
  switch (format) {
    case "date":
      return date.toISOString().slice(0, 10);
    case "time":
      return date.toISOString().slice(11, 19);
    case "timestamp":
      return date.getTime();
    case "locale":
      return date.toLocaleString("zh-CN", { hour12: false });
    case "iso":
    default:
      return date.toISOString();
  }
}

function defaultNameOf(rawPath: string): string {
  const segments = parsePath(rawPath);
  const last = segments[segments.length - 1];
  return last === undefined ? "value" : String(last);
}

function runBlocks(source: unknown, blocks: TransformBlock[], passthrough: boolean, depth: number): Record<string, unknown> {
  if (depth > MAX_DEPTH) throw new ConfigError(`数据编排嵌套超过 ${MAX_DEPTH} 层。`);
  const out: Record<string, unknown> = passthrough && isPlainObject(source) ? { ...source } : {};

  for (const block of blocks) {
    switch (block.op) {
      case "field": {
        const value = readPath(source, block.from);
        if (value === undefined) break;
        out[block.as || defaultNameOf(block.from)] = value;
        break;
      }
      case "text":
        out[block.as] = renderTemplate(block.template, source);
        break;
      case "constant":
        out[block.as] = block.value;
        break;
      case "now":
        out[block.as] = formatNow(block.format, block.offsetSeconds ?? 0);
        break;
      case "count": {
        const value = readPath(source, block.from);
        if (Array.isArray(value)) out[block.as] = value.length;
        else if (isPlainObject(value)) out[block.as] = Object.keys(value).length;
        else out[block.as] = value === undefined || value === null ? 0 : 1;
        break;
      }
      case "join": {
        const value = readPath(source, block.from);
        if (!Array.isArray(value)) break;
        out[block.as] = value.map((item) => stringifyValue(item)).join(block.separator ?? ", ");
        break;
      }
      case "omit":
        delete out[block.from];
        delete out[defaultNameOf(block.from)];
        break;
      case "each": {
        const value = readPath(source, block.from);
        if (!Array.isArray(value)) break;
        out[block.as] = value.map((item) => runBlocks(item, block.blocks, passthrough, depth + 1));
        break;
      }
    }
  }
  return out;
}

export type TransformResult = { value: unknown; from: unknown };

/** Apply `config` to a payload. Returns the reshaped value. */
export function applyTransform(config: TransformConfig, payload: unknown): TransformResult {
  const root = typeof config.root === "string" && config.root.trim() ? config.root.trim() : "";
  const source = root ? readPath(payload, root) : payload;
  if (source === undefined) return { value: {}, from: undefined };
  return { value: runBlocks(source, config.blocks, config.passthrough === true, 0), from: source };
}

function requireString(block: Record<string, unknown>, key: string, where: string): string {
  const value = block[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${where} 缺少 "${key}"（非空字符串）。`);
  }
  return value.trim();
}

/**
 * Path values may be empty to mean "the current root" — that is how `count`,
 * `join` and `each` operate on the root array (e.g. after `root: data`).
 */
function requirePath(block: Record<string, unknown>, where: string): string {
  const value = block.from;
  if (value === undefined || value === null) {
    throw new ConfigError(`${where} 缺少 "from"（字符串，留空表示当前根）。`);
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${where} 的 "from" 必须是字符串。`);
  }
  return value.trim();
}

function normalizeBlocks(raw: unknown, where: string, depth: number): TransformBlock[] {
  if (depth > MAX_DEPTH) throw new ConfigError(`${where} 嵌套超过 ${MAX_DEPTH} 层。`);
  if (!Array.isArray(raw)) throw new ConfigError(`${where} 必须是数组。`);
  return raw.map((item, index) => {
    const at = `${where}[${index + 1}]`;
    if (!isPlainObject(item)) throw new ConfigError(`${at} 必须是对象。`);
    const op = String(item.op ?? "");
    if (!OPS.includes(op as (typeof OPS)[number])) {
      throw new ConfigError(`${at}.op "${op}" 不支持，可选：${OPS.join(", ")}。`);
    }
    switch (op) {
      case "field": {
        const from = requireString(item, "from", at);
        const as = typeof item.as === "string" && item.as.trim() ? item.as.trim() : undefined;
        return { op: "field", from, ...(as ? { as } : {}) };
      }
      case "text":
        return { op: "text", as: requireString(item, "as", at), template: typeof item.template === "string" ? item.template : "" };
      case "constant":
        return { op: "constant", as: requireString(item, "as", at), value: item.value };
      case "now": {
        const format = String(item.format ?? "iso") as NowFormat;
        if (!NOW_FORMATS.includes(format)) {
          throw new ConfigError(`${at}.format "${format}" 不支持，可选：${NOW_FORMATS.join(", ")}。`);
        }
        const offset = Number(item.offsetSeconds ?? 0);
        return {
          op: "now",
          as: requireString(item, "as", at),
          format,
          ...(Number.isFinite(offset) && offset !== 0 ? { offsetSeconds: offset } : {}),
        };
      }
      case "count":
        return { op: "count", from: requirePath(item, at), as: requireString(item, "as", at) };
      case "join": {
        const separator = typeof item.separator === "string" ? item.separator : ", ";
        return { op: "join", from: requirePath(item, at), as: requireString(item, "as", at), separator };
      }
      case "omit":
        return { op: "omit", from: requireString(item, "from", at) };
      case "each":
        return {
          op: "each",
          from: requirePath(item, at),
          as: requireString(item, "as", at),
          blocks: normalizeBlocks(item.blocks, `${at}.blocks`, depth + 1),
        };
      default:
        throw new ConfigError(`${at}.op "${op}" 不支持。`);
    }
  });
}

/** Validate a user-supplied transform; throws ConfigError with a readable message. */
export function normalizeTransform(raw: unknown): TransformConfig {
  if (!isPlainObject(raw)) throw new ConfigError("数据编排配置必须是对象。");
  const blocks = normalizeBlocks(raw.blocks ?? [], "blocks", 0);
  const passthrough = raw.passthrough === true;
  // A passthrough-only config (no blocks, keep everything) is valid — the UI
  // and the auto-orchestrator fall back to it when a tool needs arguments and
  // no sample fields could be discovered.
  if (blocks.length === 0 && !passthrough) {
    throw new ConfigError("至少需要一个积木块，或开启「保留原字段」。");
  }
  const root = typeof raw.root === "string" && raw.root.trim() ? raw.root.trim() : undefined;
  // Validate the root path early so the UI fails fast.
  if (root) parsePath(root);
  return {
    ...(root ? { root } : {}),
    ...(passthrough ? { passthrough: true } : {}),
    blocks,
  };
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Per-tool response transforms, persisted next to the other admin data. */
export class TransformStore {
  private entries = new Map<string, TransformEntry>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  private key(output: string, source: string, tool: string): string {
    return `${output}::${source}::${tool}`;
  }

  async init(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.entries.clear();
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      const list = isPlainObject(parsed) && Array.isArray(parsed.transforms) ? parsed.transforms : [];
      let legacy = 0;
      for (const item of list) {
        if (!isPlainObject(item)) continue;
        const output = String(item.output ?? "");
        const source = String(item.source ?? "");
        const tool = String(item.tool ?? "");
        // Transforms used to be source-scoped; those entries no longer have a
        // meaning because one source can be published through several outputs.
        if (!output) {
          legacy += 1;
          continue;
        }
        if (!source || !tool) continue;
        try {
          this.entries.set(this.key(output, source, tool), {
            output,
            source,
            tool,
            config: normalizeTransform(item.config),
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
          });
        } catch (error) {
          this.logger.warn(`Ignoring transform ${output}/${source}/${tool}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.logger.info("Loaded response transforms", { file: this.file, count: this.entries.size });
      if (legacy > 0) {
        this.logger.warn(`Ignoring ${legacy} source-scoped transform(s); transforms are now saved per output.`);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`Could not read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get filePath(): string {
    return this.file;
  }

  list(): TransformEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      `${a.output}/${a.source}/${a.tool}`.localeCompare(`${b.output}/${b.source}/${b.tool}`),
    );
  }

  /** Exact tool transform, falling back to the output + source `*` entry. */
  get(output: string, source: string, tool: string): TransformConfig | undefined {
    return (
      this.entries.get(this.key(output, source, tool))?.config ??
      this.entries.get(this.key(output, source, "*"))?.config
    );
  }

  has(output: string, source: string, tool: string): boolean {
    return this.entries.has(this.key(output, source, tool));
  }

  async upsert(output: string, source: string, tool: string, raw: unknown): Promise<TransformEntry> {
    if (!NAME_PATTERN.test(output)) throw new ConfigError(`输出名称 "${output}" 不合法。`);
    if (!NAME_PATTERN.test(source)) throw new ConfigError(`来源名称 "${source}" 不合法。`);
    if (tool !== "*" && !NAME_PATTERN.test(tool)) throw new ConfigError(`工具名称 "${tool}" 不合法。`);
    const config = normalizeTransform(raw);
    const entry: TransformEntry = { output, source, tool, config, updatedAt: new Date().toISOString() };
    this.entries.set(this.key(output, source, tool), entry);
    await this.persist();
    return entry;
  }

  async remove(output: string, source: string, tool: string): Promise<boolean> {
    const existed = this.entries.delete(this.key(output, source, tool));
    if (existed) await this.persist();
    return existed;
  }

  /** Drop every transform belonging to a deleted output. Returns how many. */
  async removeOutput(output: string): Promise<number> {
    let removed = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.output === output) {
        this.entries.delete(this.key(entry.output, entry.source, entry.tool));
        removed += 1;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const payload = { version: 1, transforms: this.list() };
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
