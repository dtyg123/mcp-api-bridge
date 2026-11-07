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

const echoServer = () => ({
  name: "echo",
  transport: {
    type: "stdio" as const,
    command: process.execPath,
    args: [path.resolve("test/fixtures/echo-mcp-server.mjs")],
  },
});

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
      mcpServers: [echoServer()],
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

async function callRest(output: string, tool: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/api/${output}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function saveOutput(output: Record<string, unknown>): Promise<{ status: number; json: any }> {
  return fetch(`${base}/admin/api/outputs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(output),
  }).then(async (response) => ({ status: response.status, json: await response.json() }));
}

async function withMcp(url: string, fn: (client: Client) => Promise<void>, headers?: Record<string, string>): Promise<void> {
  const client = new Client({ name: "e2e-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function mcpStatus(url: string, token?: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auth-test", version: "1" } },
    }),
  });
  await response.body?.cancel();
  return response.status;
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
  const petstore = root.endpoints.outputs.find((output: any) => output.name === "petstore");
  assert.equal(petstore.mcp, `${base}/mcp/petstore`);
  assert.equal(petstore.api, `${base}/api/petstore`);
  assert.equal(petstore.openapi, `${base}/openapi/petstore.json`);
});

test("every source gets a default output with MCP and API forms", async () => {
  const payload = await fetch(`${base}/admin/api/outputs`).then((response) => response.json());
  const names = payload.outputs.map((output: any) => output.name).sort();
  assert.deepEqual(names, ["echo", "petstore"]);
  const echo = payload.outputs.find((output: any) => output.name === "echo");
  assert.equal(echo.mode, "convert");
  assert.deepEqual(echo.form.sort(), ["api", "mcp"]);
  assert.equal(echo.toolCount, 4);
  assert.equal(echo.token, undefined);
});

test("per-output OpenAPI documents only list that output's tools", async () => {
  const document = await fetch(`${base}/openapi/petstore.json`).then((response) => response.json());
  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.servers[0].url, base);
  const paths = Object.keys(document.paths);
  assert.ok(paths.includes("/api/petstore/petstore__listPets"));
  assert.ok(!paths.includes("/api/petstore/echo__add"));
  assert.ok(document.components.schemas.BridgeToolResult);

  const echoDoc = await fetch(`${base}/openapi/echo.json`).then((response) => response.json());
  const describe = echoDoc.paths["/api/echo/echo__describe_pet"].post;
  const petRef = describe.requestBody.content["application/json"].schema.properties.pet.$ref;
  assert.match(petRef, /^#\/components\/schemas\//);
  const defName = petRef.split("/").pop();
  assert.ok(echoDoc.components.schemas[defName], "hoisted definition exists");

  const document30 = await fetch(`${base}/openapi/echo.json?version=3.0`).then((response) => response.json());
  assert.equal(document30.openapi, "3.0.3");

  const missing = await fetch(`${base}/openapi/nope.json`);
  assert.equal(missing.status, 404);
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

test("API tools can be invoked with POST and GET", async () => {
  const created = await callRest("petstore", "createPet", { name: "Bolt", tags: ["fast"], age: 3 });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.data.created, { name: "Bolt", tags: ["fast"], age: 3 });

  // The registry name (`{source}__{tool}`) also resolves.
  const listed = await callRest("petstore", "petstore__listPets", { limit: 2, tags: ["a"], status: "available" });
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

test("default MCP outputs are scoped to their source", async () => {
  await withMcp(`${base}/mcp/petstore`, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["petstore__createPet", "petstore__getPetById", "petstore__listPets", "petstore__securePing"]);

    const pet = await client.callTool({ name: "petstore__getPetById", arguments: { petId: "1" } });
    assert.match((pet.content as any[])[0].text, /Rex/);
    await assert.rejects(client.callTool({ name: "echo__add", arguments: { a: 1, b: 2 } }), /Unknown tool/);
  });

  await withMcp(`${base}/mcp/echo`, async (client) => {
    const described = await client.callTool({
      name: "echo__describe_pet",
      arguments: { pet: { name: "Kit", kind: "dog" } },
    });
    assert.deepEqual((described as any).structuredContent, { name: "Kit", kind: "dog" });
  });

  assert.equal(await mcpStatus(`${base}/mcp/unknown`), 404);
});

test("an output can combine sources and trim their tools", async () => {
  const saved = await saveOutput({
    name: "combo",
    mode: "convert",
    form: ["mcp", "api"],
    sources: [
      { source: "petstore", tools: ["listPets", "getPetById"] },
      { source: "echo", tools: ["add"] },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.output.toolCount, 3);
  assert.deepEqual(saved.json.output.missingTools, []);

  const listed = await (await fetch(`${base}/api/combo/listPets?limit=1`)).json();
  assert.equal(listed.data.items.length, 1);
  assert.equal((await callRest("combo", "echo__add", { a: 1, b: 2 })).json.data, 3);

  // Trimmed tools stay invisible.
  const trimmed = await callRest("combo", "createPet", { name: "Nope" });
  assert.equal(trimmed.status, 404);

  await withMcp(`${base}/mcp/combo`, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["echo__add", "petstore__getPetById", "petstore__listPets"]);
    const added = await client.callTool({ name: "echo__add", arguments: { a: 3, b: 4 } });
    assert.equal((added.content as any[])[0].text, "7");
  });

  const document = await fetch(`${base}/openapi/combo.json`).then((response) => response.json());
  assert.equal(Object.keys(document.paths).length, 3);

  // Unknown tools in a source are rejected at save time.
  const bad = await saveOutput({
    name: "bad",
    mode: "convert",
    sources: [{ source: "echo", tools: ["nope"] }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /nope/);
});

test("mirror mode keeps the upstream MCP tool names", async () => {
  const saved = await saveOutput({
    name: "raw-echo",
    mode: "mirror",
    sources: [{ source: "echo", tools: ["add", "echo"] }],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.output.urls, { mcp: "/mcp/raw-echo" });

  await withMcp(`${base}/mcp/raw-echo`, async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["add", "echo"]);
    const added = await client.callTool({ name: "add", arguments: { a: 3, b: 4 } });
    assert.equal((added.content as any[])[0].text, "7");
  });

  // No API form for mirror outputs.
  assert.equal((await callRest("raw-echo", "add", { a: 1, b: 1 })).status, 404);

  // Mirror only accepts MCP sources.
  const badMirror = await saveOutput({
    name: "bad-mirror",
    mode: "mirror",
    sources: [{ source: "petstore" }],
  });
  assert.equal(badMirror.status, 400);
  assert.match(badMirror.json.message, /MCP/);
});

test("proxy mode forwards raw API calls without leaking the upstream", async () => {
  const saved = await saveOutput({
    name: "raw-petstore",
    mode: "proxy",
    sources: [{ source: "petstore" }],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.output.form, ["api"]);

  const response = await fetch(`${base}/api/raw-petstore/pets?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 1);

  const created = await fetch(`${base}/api/raw-petstore/pets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Proxy", tags: ["p"] }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).created, { name: "Proxy", tags: ["p"] });

  // The upstream saw the bridge-forwarded path, and the client saw the bridge.
  const last = mock.requests.at(-1);
  assert.equal(last?.url, "/pets");
  assert.equal(last?.body && (last.body as any).name, "Proxy");
  assert.ok(!JSON.stringify(body).includes(mock.url), "upstream url is not exposed to clients");

  // Proxy has no MCP form.
  assert.equal(await mcpStatus(`${base}/mcp/raw-petstore`), 404);

  const tooMany = await saveOutput({
    name: "bad-proxy",
    mode: "proxy",
    sources: [{ source: "petstore" }, { source: "echo" }],
  });
  assert.equal(tooMany.status, 400);

  const mcpSource = await saveOutput({ name: "bad-proxy2", mode: "proxy", sources: [{ source: "echo" }] });
  assert.equal(mcpSource.status, 400);
});

test("output prompts contain connection info and only that output's tools", async () => {
  const prompt = await fetch(`${base}/admin/api/outputs/combo/prompt`).then((response) => response.json());
  assert.equal(prompt.toolCount, 3);
  assert.match(prompt.text, new RegExp(`/mcp/combo`));
  assert.match(prompt.text, new RegExp(`/api/combo`));
  assert.match(prompt.text, /echo__add/);
  assert.ok(!prompt.text.includes("petstore__createPet"));
});

test("one-click import adds a source plus a ready output, and deleting prunes it", async () => {
  const imported = await fetch(`${base}/admin/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: JSON.stringify({
        mcpServers: {
          math: {
            command: process.execPath,
            args: [path.resolve("test/fixtures/echo-mcp-server.mjs")],
          },
        },
      }),
    }),
  }).then((response) => response.json());
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.added, [{ kind: "mcp", name: "math" }]);
  assert.deepEqual(imported.outputs, ["math"]);

  const added = await callRest("math", "add", { a: 6, b: 7 });
  assert.equal(added.json.data, 13);

  const removed = await fetch(`${base}/admin/api/sources/mcp/math`, { method: "DELETE" }).then((response) => response.json());
  assert.equal(removed.ok, true);
  const outputs = await fetch(`${base}/admin/api/outputs`).then((response) => response.json());
  assert.ok(!outputs.outputs.some((output: any) => output.name === "math"), "output pruned with its source");
});

test("managed outputs can be deleted, config-file outputs cannot", async () => {
  const del = await fetch(`${base}/admin/api/outputs/raw-echo`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(await mcpStatus(`${base}/mcp/raw-echo`), 404);
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

  try {
    await withMcp(`${statelessBase}/mcp/echo`, async (client) => {
      assert.ok((await client.listTools()).tools.length > 0);
      const added = await client.callTool({ name: "echo__add", arguments: { a: 5, b: 6 } });
      assert.equal((added.content as any[])[0].text, "11");
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
  }
});

test("admin reload refreshes the registry", async () => {
  const response = await fetch(`${base}/admin/reload`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.ok(payload.tools >= 8);
});

test("an output token protects only that output", async () => {
  const locked = await saveOutput({
    name: "combo",
    mode: "convert",
    form: ["mcp", "api"],
    sources: [
      { source: "petstore", tools: ["listPets"] },
      { source: "echo", tools: ["add"] },
    ],
    token: "combo-token",
  });
  assert.equal(locked.status, 200);

  const anonymous = await callRest("combo", "echo__add", { a: 1, b: 2 });
  assert.equal(anonymous.status, 401);
  const wrong = await fetch(`${base}/api/combo/echo__add`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
    body: JSON.stringify({ a: 1, b: 2 }),
  });
  assert.equal(wrong.status, 401);
  const authorized = await fetch(`${base}/api/combo/echo__add`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer combo-token" },
    body: JSON.stringify({ a: 1, b: 2 }),
  });
  assert.equal(authorized.status, 200);

  assert.equal(await mcpStatus(`${base}/mcp/combo`), 401);
  assert.equal(await mcpStatus(`${base}/mcp/combo`, "combo-token"), 200);

  // Outputs without a token stay open on an instance without global tokens.
  const stillOpen = await callRest("petstore", "listPets", { limit: 1 });
  assert.equal(stillOpen.status, 200);
});

test("global tokens and per-output tokens form the auth matrix", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-bridge-auth-"));
  const configPath = path.join(dir, "bridge.json");
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "error" },
      server: { port: 0, host: "127.0.0.1", auth: { mcp: "global-mcp", rest: "global-rest" } },
      apis: [
        { name: "petstore", spec: path.resolve("test/fixtures/petstore.openapi.json"), baseUrl: mock.url },
      ],
      mcpServers: [echoServer()],
      outputs: [
        {
          name: "locked",
          mode: "convert",
          form: ["mcp", "api"],
          sources: [{ source: "petstore" }],
          token: "out-token",
        },
        { name: "open-out", mode: "convert", form: ["api"], sources: [{ source: "petstore" }] },
      ],
    }),
  );

  const logger = new Logger("error", "text", "test");
  const scopedConfig = await loadConfig(configPath);
  const scopedCredentials = new CredentialStore(path.join(dir, "data", "credentials.json"), logger);
  await scopedCredentials.init();
  const scopedTransforms = new TransformStore(path.join(dir, "data", "transforms.json"), logger);
  await scopedTransforms.init();
  const scopedStore = new SourceStore(scopedConfig, logger, scopedCredentials);
  await scopedStore.init();
  const scopedRegistry = new Registry(scopedStore.config, logger);
  await scopedRegistry.initialize();
  const { app, close } = createHttpApp({
    config: scopedStore.config,
    registry: scopedRegistry,
    store: scopedStore,
    credentials: scopedCredentials,
    transforms: scopedTransforms,
    logger,
    startedAt: Date.now(),
    version: "test",
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const scopedBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const restStatus = (endpoint: string, token?: string) =>
    fetch(`${scopedBase}${endpoint}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(
      (response) => response.status,
    );

  try {
    // An output with its own token accepts it, or the surface's global token.
    assert.equal(await restStatus("/api/locked/listPets?limit=1"), 401);
    assert.equal(await restStatus("/api/locked/listPets?limit=1", "out-token"), 200);
    assert.equal(await restStatus("/api/locked/listPets?limit=1", "global-rest"), 200);
    assert.equal(await mcpStatus(`${scopedBase}/mcp/locked`), 401);
    assert.equal(await mcpStatus(`${scopedBase}/mcp/locked`, "out-token"), 200);
    assert.equal(await mcpStatus(`${scopedBase}/mcp/locked`, "global-mcp"), 200);
    assert.equal(await restStatus("/openapi/locked.json", "out-token"), 200);
    assert.equal(await restStatus("/openapi/locked.json"), 401);

    // No output token: falls back to the global token, never anonymous.
    assert.equal(await restStatus("/api/open-out/listPets?limit=1"), 401);
    assert.equal(await restStatus("/api/open-out/listPets?limit=1", "global-rest"), 200);
    assert.equal(await restStatus("/api/open-out/listPets?limit=1", "out-token"), 401);

    // The prompt carries the output token.
    const prompt = await fetch(`${scopedBase}/admin/api/outputs/locked/prompt`).then((response) => response.json());
    assert.match(prompt.text, /Bearer out-token/);
    assert.match(prompt.text, /\/mcp\/locked/);

    // Config-file outputs are not deletable from the UI.
    const del = await fetch(`${scopedBase}/admin/api/outputs/locked`, { method: "DELETE" });
    assert.equal(del.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scopedRegistry.close();
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("file-based sources can be deleted and their output is pruned", async () => {
  const before = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(before.sources.some((source: any) => source.name === "petstore"), "petstore exists before delete");
  assert.ok(!before.sources.find((source: any) => source.name === "petstore").managed, "petstore is a config source");

  const del = await fetch(`${base}/admin/api/sources/api/petstore`, { method: "DELETE" });
  const delPayload = await del.json();
  assert.equal(del.status, 200);
  assert.equal(delPayload.ok, true);
  assert.equal(delPayload.action, "excluded");

  const afterDelete = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(!afterDelete.sources.some((source: any) => source.name === "petstore"), "petstore gone after delete");
  const outputs = await (await fetch(`${base}/admin/api/outputs`)).json();
  assert.ok(!outputs.outputs.some((output: any) => output.name === "petstore"), "petstore output pruned");

  // Exclusion is persisted to the store file (not the user's YAML).
  const storeJson = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.ok(storeJson.excludes.some((entry: any) => entry.kind === "api" && entry.name === "petstore"), "exclusion persisted");

  // Re-adding the same name clears the exclusion, restores the source and its output.
  const reAdd = await fetch(`${base}/admin/api/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "api",
      name: "petstore",
      spec: path.resolve("test/fixtures/petstore.openapi.json"),
      baseUrl: mock.url,
    }),
  });
  assert.equal(reAdd.status, 200);
  const reList = await (await fetch(`${base}/admin/api/sources`)).json();
  assert.ok(reList.sources.some((source: any) => source.name === "petstore"), "petstore returns after re-add");
  const reOutputs = await (await fetch(`${base}/admin/api/outputs`)).json();
  assert.ok(reOutputs.outputs.some((output: any) => output.name === "petstore"), "petstore output returns");
  const storeJson2 = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.ok(!storeJson2.excludes.some((entry: any) => entry.kind === "api" && entry.name === "petstore"), "exclusion cleared");
});
