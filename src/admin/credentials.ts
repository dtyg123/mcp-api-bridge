/**
 * Reusable authentication material ("认证信息").
 *
 * A credential is a named header we know how to build (custom header, bearer
 * token, basic auth). Sources reference credentials by name, so rotating a key
 * only means editing the vault and reloading, instead of editing every source.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../config.js";
import { isPlainObject } from "../util/json.js";
import type { Logger } from "../util/logger.js";

export const CREDENTIAL_TYPES = ["header", "bearer", "basic"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export type Credential = {
  name: string;
  type: CredentialType;
  /** Header name for `type: header` (e.g. `X-Api-Key`). */
  key: string;
  /** Token / API key value. */
  value: string;
  /** Basic auth user name. */
  username: string;
  password: string;
  note: string;
  updatedAt: string;
};

export type CredentialInput = {
  name?: string;
  type?: string;
  key?: string;
  value?: string;
  token?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  note?: string;
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function str(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/** Validate and canonicalize a credential coming from the UI / API. */
export function normalizeCredential(raw: unknown): Credential {
  if (!isPlainObject(raw)) throw new ConfigError("认证信息必须是一个对象。");
  const name = str(raw.name).trim();
  if (!NAME_PATTERN.test(name)) {
    throw new ConfigError(`认证名称 "${name}" 不合法：只能包含字母、数字、点、下划线、连字符（最长 64 字符）。`);
  }
  const type = str(raw.type, "header").trim() as CredentialType;
  if (!CREDENTIAL_TYPES.includes(type)) {
    throw new ConfigError(`认证类型 "${type}" 不支持，可选：${CREDENTIAL_TYPES.join(", ")}。`);
  }
  const key = str(raw.key).trim();
  const value = str(raw.value ?? raw.token ?? raw.apiKey).trim();
  const username = str(raw.username).trim();
  const password = str(raw.password);
  if (type === "header") {
    if (!key) throw new ConfigError("自定义请求头认证需要填写请求头名称，例如 X-Api-Key。");
    if (!HEADER_PATTERN.test(key)) throw new ConfigError(`请求头名称 "${key}" 不合法。`);
  }
  if (type === "bearer" && !value) throw new ConfigError("Bearer 认证需要填写 token。");
  if (type === "basic" && !username) throw new ConfigError("Basic 认证需要填写用户名。");
  if (type === "header" && !value) throw new ConfigError("自定义请求头认证需要填写值。");
  return {
    name,
    type,
    key: type === "header" ? key : "",
    value: type === "basic" ? "" : value,
    username: type === "basic" ? username : "",
    password: type === "basic" ? password : "",
    note: str(raw.note).trim(),
    updatedAt: new Date().toISOString(),
  };
}

/** Headers a credential contributes to every request of a source. */
export function credentialHeaders(credential: Credential): Record<string, string> {
  switch (credential.type) {
    case "bearer":
      return { authorization: `Bearer ${credential.value}` };
    case "basic":
      return {
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
      };
    case "header":
    default:
      return { [credential.key.toLowerCase()]: credential.value };
  }
}

/** Masked copy for the admin UI (never send raw secrets to a list view). */
export function maskCredential(credential: Credential): Record<string, unknown> {
  const hide = (value: string) => {
    if (!value) return "";
    if (value.length <= 4) return "••••";
    return `${value.slice(0, 2)}••••${value.slice(-2)}`;
  };
  return {
    name: credential.name,
    type: credential.type,
    key: credential.key,
    value: hide(credential.value),
    username: credential.username,
    password: credential.password ? "••••" : "",
    note: credential.note,
    updatedAt: credential.updatedAt,
    hasValue: Boolean(credential.value),
  };
}

/** Named credentials persisted in `data/credentials.json`. */
export class CredentialStore {
  private entries = new Map<string, Credential>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.entries.clear();
    try {
      const text = await readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      const list = isPlainObject(parsed) && Array.isArray(parsed.credentials) ? parsed.credentials : [];
      for (const item of list) {
        try {
          const credential = normalizeCredential(item);
          this.entries.set(credential.name, credential);
        } catch (error) {
          this.logger.warn(`Ignoring credential: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.logger.info("Loaded credentials", { file: this.file, count: this.entries.size });
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

  list(): Credential[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Credential | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async upsert(input: unknown): Promise<Credential> {
    // The UI only ever sees masked secrets, so an empty value means "keep the
    // stored one" instead of "clear it".
    const raw: Record<string, unknown> = isPlainObject(input) ? { ...input } : {};
    if (isPlainObject(input)) {
      const name = str(raw.name).trim();
      const existing = this.entries.get(name);
      if (existing) {
        const type = str(raw.type, existing.type);
        const value = str(raw.value ?? raw.token ?? raw.apiKey).trim();
        if (type !== "basic" && !value) raw.value = existing.value;
        if (type === "basic") {
          if (!str(raw.username).trim()) raw.username = existing.username;
          if (raw.password === undefined) raw.password = existing.password;
        }
        if (!str(raw.key).trim() && existing.key) raw.key = existing.key;
      }
    }
    const credential = normalizeCredential(raw);
    this.entries.set(credential.name, credential);
    await this.persist();
    return credential;
  }

  async remove(name: string): Promise<boolean> {
    const existed = this.entries.delete(name);
    if (existed) await this.persist();
    return existed;
  }

  /** Headers contributed by a list of credential names (unknown names are skipped). */
  headersFor(names: string[]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of names) {
      const credential = this.entries.get(name);
      if (!credential) continue;
      Object.assign(headers, credentialHeaders(credential));
    }
    return headers;
  }

  /** Names that no longer exist, for warning the user. */
  missing(names: string[]): string[] {
    return names.filter((name) => !this.entries.has(name));
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const payload = { version: 1, credentials: this.list() };
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}
