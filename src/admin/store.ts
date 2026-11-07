import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ConfigError,
  applyCredentialRefs,
  emptyManagedPayload,
  mergeSources,
  normalizeApi,
  normalizeMcpServer,
  normalizeOutput,
  type BridgeConfig,
  type ManagedPayload,
  type McpServerConfig,
  type ApiConfig,
  type OutputConfig,
} from "../config.js";
import type { CredentialStore } from "./credentials.js";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";

export type SourceKind = "mcp" | "api";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Default endpoint for a newly added source: every tool, MCP + API. */
function defaultOutput(managed: unknown[], sourceName: string): OutputConfig {
  const taken = new Set(managed.map((entry) => (isPlainObject(entry) ? String(entry.name ?? "") : "")));
  let name = sourceName;
  for (let index = 2; taken.has(name); index += 1) name = `${sourceName}-${index}`;
  return { name, mode: "convert", form: ["mcp", "api"], sources: [{ source: sourceName, tools: [] }] };
}

/**
 * Persists sources created through the admin UI in a small JSON file, keeping
 * the hand-written YAML config untouched. The effective config is the file
 * config with the managed entries overlaid by name.
 */
export class SourceStore {
  private managed: ManagedPayload = emptyManagedPayload();
  private effective: BridgeConfig;
  private loaded = false;

  constructor(
    private readonly base: BridgeConfig,
    private readonly logger: Logger,
    /** Optional vault of saved credentials referenced by `apis[].credentialRefs`. */
    private readonly credentials?: CredentialStore,
  ) {
    this.effective = base;
  }

  get config(): BridgeConfig {
    return this.effective;
  }

  get baseConfig(): BridgeConfig {
    return this.base;
  }

  get filePath(): string {
    return this.base.server.admin.storeFile;
  }

  get specsDir(): string {
    return this.base.server.admin.specsDir;
  }

  async init(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    let outputsKnown = true;
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed)) {
        const rawExcludes = (parsed as { excludes?: unknown }).excludes;
        outputsKnown = Array.isArray((parsed as { outputs?: unknown }).outputs);
        this.managed = {
          mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
          apis: Array.isArray(parsed.apis) ? parsed.apis : [],
          excludes: Array.isArray(rawExcludes)
            ? rawExcludes.filter(
                (e): e is { kind: "mcp" | "api"; name: string } =>
                  isPlainObject(e) && (e.kind === "mcp" || e.kind === "api") && typeof e.name === "string",
              )
            : [],
          outputs: Array.isArray((parsed as { outputs?: unknown }).outputs)
            ? ((parsed as { outputs: unknown[] }).outputs ?? [])
            : [],
        };
      }
      this.logger.info("Loaded UI-managed sources", {
        file: this.filePath,
        mcpServers: this.managed.mcpServers.length,
        apis: this.managed.apis.length,
        outputs: this.managed.outputs.length,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`Could not read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.managed = emptyManagedPayload();
      outputsKnown = false;
    }
    this.rebuild();
    // First run (or a store written by an older version) has no `outputs` key:
    // give every source a default endpoint once, then never auto-create again
    // (an empty list afterwards means the user deleted them on purpose).
    if (!outputsKnown) await this.seedDefaultOutputs();
    this.loaded = true;
  }

  /** Create one `convert` output per source that has no endpoint yet. */
  private async seedDefaultOutputs(): Promise<void> {
    const covered = new Set(this.effective.outputs.flatMap((output) => output.sources.map((ref) => ref.source)));
    const missing = [...this.effective.mcpServers, ...this.effective.apis]
      .map((source) => source.name)
      .filter((name) => !covered.has(name));
    for (const name of missing) this.managed.outputs.push(defaultOutput(this.managed.outputs, name));
    // Persist even when nothing was missing so the migration only runs once.
    await this.persist();
    if (missing.length > 0) this.rebuild();
  }

  /** Re-read the store file from disk (e.g. after it was edited externally). */
  async refresh(): Promise<void> {
    await this.load();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  listManaged(kind: SourceKind): unknown[] {
    return kind === "mcp" ? [...this.managed.mcpServers] : [...this.managed.apis];
  }

  isManaged(kind: SourceKind, name: string): boolean {
    return this.listManaged(kind).some((entry) => isPlainObject(entry) && entry.name === name);
  }

  normalize(kind: SourceKind, raw: unknown): McpServerConfig | ApiConfig {
    const normalized = kind === "mcp" ? normalizeMcpServer(raw, 0, this.base.configDir) : normalizeApi(raw, 0, this.base.configDir);
    if (!NAME_PATTERN.test(normalized.name)) {
      throw new ConfigError(
        `名称 "${normalized.name}" 不合法：只能包含字母、数字、点、下划线、连字符，且以字母或数字开头（最长 64 字符）。`,
      );
    }
    const clash =
      kind === "mcp"
        ? this.effective.apis.find((api) => api.name === normalized.name)
        : this.effective.mcpServers.find((server) => server.name === normalized.name);
    if (clash) {
      throw new ConfigError(`名称 "${normalized.name}" 已被另一类型的来源占用，请换一个名字。`);
    }
    return normalized;
  }

  async upsert(kind: SourceKind, raw: unknown): Promise<McpServerConfig | ApiConfig> {
    const normalized = this.normalize(kind, raw);
    // Re-adding a previously excluded source clears the exclusion so it reappears.
    this.managed.excludes = this.managed.excludes.filter((e) => !(e.kind === kind && e.name === normalized.name));
    const list = kind === "mcp" ? this.managed.mcpServers : this.managed.apis;
    const index = list.findIndex((entry) => isPlainObject(entry) && entry.name === normalized.name);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    // A new source is reachable without extra steps: one default endpoint.
    if (!this.effective.outputs.some((output) => output.sources.some((ref) => ref.source === normalized.name))) {
      this.managed.outputs.push(defaultOutput(this.managed.outputs, normalized.name));
    }
    await this.persist();
    this.rebuild();
    return normalized;
  }

  async remove(kind: SourceKind, name: string): Promise<boolean> {
    const key = kind === "mcp" ? "mcpServers" : "apis";
    const before = this.managed[key].length;
    this.managed[key] = this.managed[key].filter((entry) => !(isPlainObject(entry) && entry.name === name));
    if (this.managed[key].length === before) return false;
    this.forgetSourceInOutputs(name);
    await this.persist();
    this.rebuild();
    return true;
  }

  isExcluded(kind: SourceKind, name: string): boolean {
    return this.managed.excludes.some((e) => e.kind === kind && e.name === name);
  }

  /** Hide a bridge.config.yaml source from the running gateway (idempotent). */
  async exclude(kind: SourceKind, name: string): Promise<boolean> {
    if (this.isExcluded(kind, name)) return false;
    this.managed.excludes.push({ kind, name });
    this.forgetSourceInOutputs(name);
    await this.persist();
    this.rebuild();
    return true;
  }

  // -------------------------------------------------------------------------
  // Outputs (published endpoints)
  // -------------------------------------------------------------------------

  listOutputs(): OutputConfig[] {
    return this.effective.outputs;
  }

  isManagedOutput(name: string): boolean {
    return this.managed.outputs.some((entry) => isPlainObject(entry) && entry.name === name);
  }

  async upsertOutput(raw: unknown): Promise<OutputConfig> {
    const output = normalizeOutput(raw);
    const index = this.managed.outputs.findIndex((entry) => isPlainObject(entry) && entry.name === output.name);
    if (index >= 0) this.managed.outputs[index] = output;
    else this.managed.outputs.push(output);
    await this.persist();
    this.rebuild();
    return output;
  }

  async removeOutput(name: string): Promise<boolean> {
    const before = this.managed.outputs.length;
    this.managed.outputs = this.managed.outputs.filter((entry) => !(isPlainObject(entry) && entry.name === name));
    if (this.managed.outputs.length === before) return false;
    await this.persist();
    this.rebuild();
    return true;
  }

  /** Drop a deleted source from every output; empty outputs disappear. */
  private forgetSourceInOutputs(name: string): void {
    this.managed.outputs = this.managed.outputs
      .map((entry) => {
        try {
          const output = normalizeOutput(entry);
          return { ...output, sources: output.sources.filter((ref) => ref.source !== name) };
        } catch {
          return null;
        }
      })
      .filter((output): output is OutputConfig => output !== null && output.sources.length > 0);
  }

  /** Persist an OpenAPI document pasted into the UI and return its absolute path. */
  async writeSpecFile(name: string, text: string): Promise<string> {
    await mkdir(this.specsDir, { recursive: true });
    const trimmed = text.trim();
    let extension = "yaml";
    try {
      JSON.parse(trimmed);
      extension = "json";
    } catch {
      extension = "yaml";
    }
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_") || "spec";
    const target = path.join(this.specsDir, `${safe}.${extension}`);
    await writeFile(target, trimmed, "utf8");
    this.logger.info("Stored OpenAPI document from admin UI", { file: target, bytes: trimmed.length });
    return target;
  }

  private rebuild(): void {
    const effective = mergeSources(this.base, this.managed, (message) => this.logger.warn(message));
    const credentials = this.credentials;
    this.effective = credentials
      ? {
          ...effective,
          apis: applyCredentialRefs(effective.apis, {
            resolveCredentialHeaders: (names) => {
              for (const name of credentials.missing(names)) {
                this.logger.warn(`来源引用的认证信息 "${name}" 不存在，已忽略。`);
              }
              return credentials.headersFor(names);
            },
          }),
        }
      : effective;
  }

  /** Rebuild the effective config after the credential vault changed. */
  rebuildNow(): BridgeConfig {
    this.rebuild();
    return this.effective;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = {
      version: 1,
      mcpServers: this.managed.mcpServers,
      apis: this.managed.apis,
      excludes: this.managed.excludes,
      outputs: this.managed.outputs,
    };
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
