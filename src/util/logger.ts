import { inspect } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Minimal structured logger. Everything goes to stderr so that the process can
 * also serve MCP over stdio without corrupting the JSON-RPC stream on stdout.
 */
export class Logger {
  private level: LogLevel;
  private readonly format: "text" | "json";
  private readonly scope: string;

  constructor(level: LogLevel = "info", format: "text" | "json" = "text", scope = "bridge") {
    this.level = level;
    this.format = format;
    this.scope = scope;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(scope: string): Logger {
    return new Logger(this.level, this.format, scope);
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write("debug", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.write("info", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.write("warn", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.write("error", message, extra);
  }

  private write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const time = new Date().toISOString();
    if (this.format === "json") {
      const payload: Record<string, unknown> = { time, level, scope: this.scope, msg: message };
      if (extra) Object.assign(payload, extra);
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    const suffix = extra && Object.keys(extra).length > 0 ? ` ${inspect(extra, { depth: 4, breakLength: 120, colors: false })}` : "";
    process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}\n`);
  }
}
