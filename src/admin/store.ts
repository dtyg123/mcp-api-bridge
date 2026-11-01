import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ConfigError,
  applyCredentialRefs,
  emptyManagedPayload,
  mergeSources,
  normalizeApi,
  normalizeMcpServer,
  type BridgeConfig,
  type ManagedPayload,
  type McpServerConfig,
  type ApiConfig,
} from "../config.js";
import type { CredentialStore } from "./credentials.js";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";

export type SourceKind = "mcp" | "api";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed)) {
        this.managed = {
          mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
          apis: Array.isArray(parsed.apis) ? parsed.apis : [],
        };
      }
      this.logger.info("Loaded UI-managed sources", {
        file: this.filePath,
        mcpServers: this.managed.mcpServers.length,
        apis: this.managed.apis.length,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn(`Could not read ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.managed = emptyManagedPayload();
    }
    this.rebuild();
    this.loaded = true;
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
    const list = kind === "mcp" ? this.managed.mcpServers : this.managed.apis;
    const index = list.findIndex((entry) => isPlainObject(entry) && entry.name === normalized.name);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    await this.persist();
    this.rebuild();
    return normalized;
  }

  async remove(kind: SourceKind, name: string): Promise<boolean> {
    const key = kind === "mcp" ? "mcpServers" : "apis";
    const before = this.managed[key].length;
    this.managed[key] = this.managed[key].filter((entry) => !(isPlainObject(entry) && entry.name === name));
    if (this.managed[key].length === before) return false;
    await this.persist();
    this.rebuild();
    return true;
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
    const payload = { version: 1, mcpServers: this.managed.mcpServers, apis: this.managed.apis };
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
