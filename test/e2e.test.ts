import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CredentialStore } from "../src/admin/credentials.js";
import { SourceStore } from "../src/admin/store.js";
import { TransformStore } from "../src/admin/transforms.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/server.js";
import { Registry } from "../src/registry.js";
import { Logger } from "../src/util/logger.js";
import { startMockApi, type MockApi } from "./helpers/mock-api.js";

let mock: MockApi;
let registry: Registry;
let store: SourceStore;
let credentials: CredentialStore;
let transforms: TransformStore;
let httpServer: Server;
let appClose: () => Promise<void>;
let base: string;
let tempDir: string;
let config: Awaited<ReturnType<typeof loadConfig>>;

before(async () => {
  mock = await startMockApi();
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-bridge-"));
  const configPath = path.join(tempDir, "bridge.json");
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "error" },
      server: { port: 0, host: "127.0.0.1" },
      apis: [
        {
          name: "petstore",
          spec: path.resolve("test/fixtures/petstore.openapi.json"),
          baseUrl: mock.url,
          security: { ApiKeyAuth: { token: "s3cret" } },
        },
      ],
      mcpServers: [
        {
          name: "echo",
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [path.resolve("test/fixtures/echo-mcp-server.mjs")],
          },
        },
      ],
    }),
  );

  config = await loadConfig(configPath);
  const logger = new Logger("error", "text", "test");
  const dataDir = path.join(tempDir, "data");
  credentials = new CredentialStore(path.join(dataDir, "credentials.json"), logger);
  await credentials.init();
  transforms = new TransformStore(path.join(dataDir, "transforms.json"), logger);
  await transforms.init();
  store = new SourceStore(config, logger, credentials);
  await store.init();
  registry = new Registry(store.config, logger);
  await registry.initialize();

  const { app, close } = createHttpApp({
    config: store.config,
    registry,
    store,
    credentials,
    transforms,
    logger,
    startedAt: Date.now(),
    version: "test",
  });
  appClose = close;
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await appClose();
  await registry.close();
  await mock.close();
  await rm(tempDir, { recursive: true, force: true });
});

async function callRest(source: string, tool: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/api/${source}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json() };
}

test("health and root endpoints describe the bridge", async () => {
  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.tools, 8);
  assert.deepEqual(
    health.sources.map((source: any) => [source.name, source.status]),
    [
      ["petstore", "ready"],
      ["echo", "ready"],
    ],
  );

  const root = await fetch(`${base}/`).then((response) => response.json());
  assert.equal(root.endpoints.mcp, `${base}/mcp`);
  assert.equal(root.endpoints.restCall, `${base}/api/{source}/{tool}`);
});

test("/tools lists both API-derived and MCP-derived tools", async () => {
  const payload = await fetch(`${base}/tools`).then((response) => response.json());
  const names = payload.tools.map((tool: any) => tool.name);
  assert.ok(names.includes("petstore__listPets"));
  assert.ok(names.includes("echo__add"));
  const add = payload.tools.find((tool: any) => tool.name === "echo__add");
  assert.equal(add.sourceType, "mcp");
  assert.deepEqual(add.inputSchema.required, ["a", "b"]);
});

test("/openapi.json documents every REST-exposed tool", async () => {
  const document = await fetch(`${base}/openapi.json`).then((response) => response.json());
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.servers[0].url, base);
  const paths = Object.keys(document.paths);
  assert.ok(paths.includes("/api/petstore/listPets"));
  assert.ok(paths.includes("/api/echo/echo"));
  assert.ok(document.components.schemas.BridgeToolResult);

  const describe = document.paths["/api/echo/describe_pet"].post;
  const petRef = describe.requestBody.content["application/json"].schema.properties.pet.$ref;
  assert.match(petRef, /^#\/components\/schemas\//);
  const defName = petRef.split("/").pop();
  assert.ok(document.components.schemas[defName], "hoisted definition exists");

  const document30 = await fetch(`${base}/openapi.json?version=3.0`).then((response) => response.json());
  assert.equal(document30.openapi, "3.0.3");
});

test("MCP tools are callable over the generated REST API", async () => {
  const echo = await callRest("echo", "echo", { text: "hello" });
  assert.equal(echo.status, 200);
  assert.equal(echo.json.ok, true);
  assert.equal(echo.json.text, "echo:hello");
  assert.equal(echo.json.data, "echo:hello");

  const add = await callRest("echo", "add", { a: 2, b: 40 });
  assert.equal(add.json.data, 42);

  const structured = await callRest("echo", "describe_pet", { pet: { name: "Tom", kind: "cat" } });
  assert.deepEqual(structured.json.data, { name: "Tom", kind: "cat" });

  const failing = await callRest("echo", "boom", {});
  assert.equal(failing.status, 200);
  assert.equal(failing.json.ok, false);
  assert.equal(failing.json.isError, true);
});

test("REST API tools can be invoked with POST and GET", async () => {
  const created = await callRest("petstore", "createPet", { name: "Bolt", tags: ["fast"], age: 3 });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.data.created, { name: "Bolt", tags: ["fast"], age: 3 });

  const listed = await callRest("petstore", "listPets", { limit: 2, tags: ["a"], status: "available" });
  assert.equal(listed.json.data.items.length, 2);
  assert.equal(listed.json.data.tags, "a");

  const getResponse = await fetch(`${base}/api/petstore/getPetById?petId=2`);
  const getJson = await getResponse.json();
  assert.equal(getJson.ok, true);
  assert.equal(getJson.data.name, "Milo");

  const queryResponse = await fetch(`${base}/api/petstore/listPets?limit=1&tags=a,b`);
  const queryJson = await queryResponse.json();
  assert.equal(queryJson.data.items.length, 1);
  assert.deepEqual(queryJson.data.tags, ["a", "b"]);
});

test("upstream HTTP errors surface as ok:false", async () => {
  const missing = await callRest("petstore", "getPetById", { petId: "does-not-exist" });
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.isError, true);
  assert.match(missing.json.text, /not found/);
});

test("configured credentials are injected from the security scheme", async () => {
  const secure = await callRest("petstore", "securePing", {});
  assert.equal(secure.json.ok, true);
  assert.equal(secure.json.data.key, "s3cret");
});

test("invalid arguments return 400 with details, unknown tools return 404", async () => {
  const invalid = await callRest("echo", "add", { a: "not-a-number", b: 1 });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "invalid_arguments");
  assert.ok(Array.isArray(invalid.json.issues) && invalid.json.issues.length > 0);

  const unknown = await callRest("echo", "nope", {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, "unknown_tool");
});

test("the aggregated MCP endpoint exposes and calls every tool", async () => {
  const client = new Client({ name: "e2e-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("echo__add"));
    assert.ok(names.includes("petstore__listPets"));
    assert.ok(names.includes("petstore__createPet"));

    const added = await client.callTool({ name: "echo__add", arguments: { a: 3, b: 4 } });
    assert.equal((added.content as any[])[0].text, "7");

    const pet = await client.callTool({ name: "petstore__getPetById", arguments: { petId: "1" } });
    assert.match((pet.content as any[])[0].text, /Rex/);

    const described = await client.callTool({
      name: "echo__describe_pet",
      arguments: { pet: { name: "Kit", kind: "dog" } },
    });
    assert.deepEqual((described as any).structuredContent, { name: "Kit", kind: "dog" });

    await assert.rejects(async () => {
      await client.callTool({ name: "does_not_exist", arguments: {} });
    }, /Unknown tool/);
  } finally {
    await client.close();
  }
});

test("per-source MCP endpoints are isolated", async () => {
  const client = new Client({ name: "e2e-source-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/echo`));
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.every((name) => name.startsWith("echo__")));
    const echoed = await client.callTool({ name: "echo__echo", arguments: { text: "scoped" } });
    assert.equal((echoed.content as any[])[0].text, "echo:scoped");
  } finally {
    await client.close();
  }

  const missing = await fetch(`${base}/mcp/unknown`, { method: "POST" });
  assert.equal(missing.status, 404);
});

test("stateless MCP mode works without session ids", async () => {
  const statelessConfig = {
    ...config,
    server: { ...config.server, mcp: { ...config.server.mcp, sessionMode: "stateless" as const } },
  };
  const logger = new Logger("error", "text", "test");
  const { app, close } = createHttpApp({
    config: statelessConfig,
    registry,
    store,
    credentials,
    transforms,
    logger,
    startedAt: Date.now(),
    version: "test",
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const statelessBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = new Client({ name: "stateless-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${statelessBase}/mcp`));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    const added = await client.callTool({ name: "echo__add", arguments: { a: 5, b: 6 } });
    assert.equal((added.content as any[])[0].text, "11");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
  }
});

test("admin reload refreshes the registry", async () => {
  const response = await fetch(`${base}/admin/reload`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.tools, 8);
});

test("file-based (config) sources can be deleted too", async () => {
  // `petstore` comes from bridge.config, not the admin UI.
  const before = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(before.sources.some((s: any) => s.name === "petstore"), "petstore exists before delete");
  assert.ok(!before.sources.find((s: any) => s.name === "petstore").managed, "petstore is a config source");

  const del = await fetch(`${base}/admin/api/sources/api/petstore`, { method: "DELETE" });
  const delPayload = await del.json();
  assert.equal(del.status, 200);
  assert.equal(delPayload.ok, true);
  assert.equal(delPayload.action, "excluded");

  const after = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(!after.sources.some((s: any) => s.name === "petstore"), "petstore gone after delete");

  // Exclusion is persisted to the store file (not the user's YAML).
  const storeJson = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.ok(storeJson.excludes.some((e: any) => e.kind === "api" && e.name === "petstore"), "exclusion persisted");

  // Re-adding the same name clears the exclusion and brings it back.
  const reAdd = await fetch(`${base}/admin/api/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "api", name: "petstore", spec: path.resolve("test/fixtures/petstore.openapi.json"), baseUrl: mock.url }),
  });
  assert.equal(reAdd.status, 200);
  const reList = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(reList.sources.some((s: any) => s.name === "petstore"), "petstore returns after re-add");
  const storeJson2 = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.ok(!storeJson2.excludes.some((e: any) => e.kind === "api" && e.name === "petstore"), "exclusion cleared after re-add");
});
