import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import type { Logger } from "../util/logger.js";

type Session = {
  transport: StreamableHTTPServerTransport;
  server: Server;
};

export type McpEndpointOptions = {
  name: string;
  mode: "stateful" | "stateless";
  jsonResponse: boolean;
  createServer: () => Server;
  logger: Logger;
};

/**
 * Serves one MCP server over Streamable HTTP, either stateful (session map) or
 * stateless (fresh server + transport per request).
 */
export class McpHttpEndpoint {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: McpEndpointOptions) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  async handle(req: Request, res: Response): Promise<void> {
    const headerSessionId = req.headers["mcp-session-id"];
    const sessionId = typeof headerSessionId === "string" ? headerSessionId : undefined;

    try {
      if (this.options.mode === "stateless") {
        await this.handleStateless(req, res);
        return;
      }

      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          res.status(404).json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: `Session not found: ${sessionId}` },
          });
          return;
        }
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method !== "POST") {
        res.status(400).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Missing Mcp-Session-Id header" },
        });
        return;
      }

      let server: Server | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: this.options.jsonResponse,
        onsessioninitialized: (id) => {
          if (!server) return;
          this.sessions.set(id, { transport, server });
          this.options.logger.debug(`MCP session opened (${this.options.name})`, { sessionId: id });
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
          this.options.logger.debug(`MCP session closed (${this.options.name})`, { sessionId: id });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      server = this.options.createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (!transport.sessionId) {
        // Initialization failed - drop the transport instead of leaking it.
        await Promise.allSettled([transport.close(), server.close()]);
      }
    } catch (error) {
      this.options.logger.error(`MCP request failed (${this.options.name})`, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
        });
      }
    }
  }

  private async handleStateless(req: Request, res: Response): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: this.options.jsonResponse,
    });
    const server = this.options.createServer();
    const cleanup = () => {
      void Promise.allSettled([transport.close(), server.close()]);
    };
    res.on("close", cleanup);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.flatMap((session) => [session.transport.close(), session.server.close()]));
  }
}
