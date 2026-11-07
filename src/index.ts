#!/usr/bin/env node
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CredentialStore } from "./admin/credentials.js";
import { SourceStore } from "./admin/store.js";
import { TransformStore } from "./admin/transforms.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { createHttpApp } from "./http/server.js";
import { createGatewayServer } from "./mcp/gateway.js";
import { Registry } from "./registry.js";
import { Logger } from "./util/logger.js";
import { SERVER_NAME, VERSION } from "./version.js";

type CliOptions = {
  configPath: string;
  host?: string;
  port?: number;
  stdio: boolean;
  listTools: boolean;
  printConfig: boolean;
  help: boolean;
  version: boolean;
  logLevel?: string;
};

const HELP = `${SERVER_NAME} v${VERSION}

Bidirectional MCP <-> API gateway.
  - Exposes every configured MCP server as a REST/OpenAPI API.
  - Exposes every configured OpenAPI service as an MCP server.
  - Both surfaces stay available at the same time.

Usage:
  mcp-api-bridge [options]

Options:
  --config <path>     Config file (YAML or JSON). Default: ./bridge.config.yaml
                      or $BRIDGE_CONFIG
  --host <host>       Override server.host
  --port <port>       Override server.port
  --stdio             Serve MCP over stdio instead of HTTP (for local clients)
  --list-tools        Connect upstreams, print the tool catalog, then exit
  --print-config      Print the normalized config as JSON, then exit
  --log-level <lvl>   debug | info | warn | error
  --version           Print version
  --help              Show this help

Environment:
  BRIDGE_CONFIG, PORT, HOST, PUBLIC_BASE_URL,
  BRIDGE_REST_TOKEN, BRIDGE_MCP_TOKEN, BRIDGE_ADMIN_TOKEN

Endpoints (HTTP mode):
  GET  /health                    health probe
  GET  /openapi/{output}.json     OpenAPI document of one output
  POST /api/{output}/{tool}       invoke a tool (body = arguments)
  GET  /api/{output}/{tool}       invoke a tool (query string = arguments)
  POST /api/{output}/*            raw passthrough for proxy outputs
  POST /mcp/{output}              MCP endpoint of one output (Streamable HTTP)
  GET  /admin                     web admin UI (sources + outputs + tester)
  POST /admin/reload              reload specs / upstream tool lists
`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: process.env.BRIDGE_CONFIG ?? "bridge.config.yaml",
    stdio: false,
    listTools: false,
    printConfig: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
      case "-c":
        options.configPath = argv[++i] ?? options.configPath;
        break;
      case "--host":
        options.host = argv[++i];
        break;
      case "--port":
      case "-p":
        options.port = Number(argv[++i]);
        break;
      case "--stdio":
        options.stdio = true;
        break;
      case "--list-tools":
        options.listTools = true;
        break;
      case "--print-config":
        options.printConfig = true;
        break;
      case "--log-level":
        options.logLevel = argv[++i];
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`);
          process.exit(2);
        }
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  let config: BridgeConfig;
  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    process.stderr.write(`Configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  if (options.host) config.server.host = options.host;
  if (options.port && Number.isFinite(options.port)) config.server.port = options.port;
  if (options.logLevel) config.logging.level = options.logLevel as BridgeConfig["logging"]["level"];

  if (options.printConfig) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  const logger = new Logger(config.logging.level, config.logging.format, "bridge");

  // Saved credentials ("认证信息") and response transforms ("数据编排") are
  // stored next to the managed sources so the YAML config stays untouched.
  const dataDir = path.dirname(config.server.admin.storeFile);
  const credentials = new CredentialStore(path.join(dataDir, "credentials.json"), logger.child("credentials"));
  await credentials.init();
  const transforms = new TransformStore(path.join(dataDir, "transforms.json"), logger.child("transforms"));
  await transforms.init();

  // Sources added through the web UI live in a separate JSON file so the
  // hand-written YAML config stays untouched. They are overlaid by name.
  const store = new SourceStore(config, logger, credentials);
  await store.init();
  const effective = store.config;

  if (config.server.admin.enabled && !config.server.adminToken) {
    logger.warn(
      "Admin UI has no token (BRIDGE_ADMIN_TOKEN empty). Anyone who can reach /admin can add or remove sources.",
    );
  }

  const registry = new Registry(effective, logger);

  logger.info(`Starting ${SERVER_NAME} v${VERSION}`, {
    config: options.configPath,
    mcpServers: effective.mcpServers.map((server) => server.name),
    apis: effective.apis.map((api) => api.name),
    adminUi: config.server.admin.enabled ? config.server.admin.path : "disabled",
  });

  await registry.initialize();

  if (options.listTools) {
    for (const tool of registry.getTools("mcp")) {
      process.stdout.write(`${tool.name}\t[${tool.source}]\t${tool.description.split("\n")[0].slice(0, 100)}\n`);
    }
    const failed = registry.getSources().filter((source) => source.status === "error");
    for (const source of failed) process.stderr.write(`! ${source.name}: ${source.error}\n`);
    await registry.close();
    return;
  }

  if (options.stdio) {
    const server = createGatewayServer({
      name: SERVER_NAME,
      version: VERSION,
      instructions: "Tools bridged from MCP servers and OpenAPI services. Tool names are prefixed with their source.",
      listTools: () => registry.getTools("mcp"),
      getTool: (name) => {
        const tool = registry.getTool(name);
        return tool && registry.isExposed(tool, "mcp") ? tool : undefined;
      },
      logger,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Serving MCP over stdio");

    const shutdown = async () => {
      await server.close();
      await registry.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const runtime = {
    config: effective,
    registry,
    store,
    credentials,
    transforms,
    logger,
    startedAt: Date.now(),
    version: VERSION,
  };
  const { app, close } = createHttpApp(runtime);

  const httpServer: HttpServer = createServer(app);
  httpServer.requestTimeout = config.server.requestTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.server.port, config.server.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const base = config.server.basePath.replace(/\/+$/, "");
  logger.info(`HTTP server listening on http://${config.server.host}:${config.server.port}${base}`);
  logger.info(`  MCP (Streamable HTTP): ${base || "/"}${config.server.mcp.path}/{output}`);
  logger.info(`  REST tool calls:       ${base || "/"}${config.server.rest.path}/{output}/{tool}`);
  logger.info(`  OpenAPI documents:     ${base || "/"}/openapi/{output}.json`);
  if (config.server.admin.enabled) {
    logger.info(`  Admin UI:              ${base || "/"}${config.server.admin.path}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await close();
    await registry.close();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
