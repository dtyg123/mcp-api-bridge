import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { SourceStore } from "../src/admin/store.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/server.js";
import { Registry } from "../src/registry.js";
import { Logger } from "../src/util/logger.js";
import { startMockApi, type MockApi } from "./helpers/mock-api.js";

const TOKEN = "secret-admin-token";
const specPath = path.resolve("test/fixtures/petstore.openapi.json");

let mock: MockApi;
let registry: Registry;
let store: SourceStore;
let httpServer: Server;
let appClose: () => Promise<void>;
let base: string;
let tempDir: string;

function authHeaders(): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
}

async function adminPost(pathname: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

before(async () => {
  mock = await startMockApi();
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-bridge-admin-"));
  const configPath = path.join(tempDir, "bridge.json");
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "error" },
      server: { port: 0, host: "127.0.0.1", adminToken: TOKEN },
    }),
  );

  const config = await loadConfig(configPath);
  const logger = new Logger("error", "text", "test");
  store = new SourceStore(config, logger);
  await store.init();
  registry = new Registry(store.config, logger);
  await registry.initialize();

  const { app, close } = createHttpApp({ config: store.config, registry, store, logger, startedAt: Date.now(), version: "test" });
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

test("the admin page is served without a token and injects its bootstrap", async () => {
  const response = await fetch(`${base}/admin`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.ok(html.includes('"adminApi":"/admin/api"'));
  assert.ok(html.includes('"authRequired":true'));
  assert.ok(!html.includes("__BRIDGE_BOOTSTRAP__"));
});

test("the admin API requires the configured token", async () => {
  const anonymous = await fetch(`${base}/admin/api/overview`);
  assert.equal(anonymous.status, 401);

  const authorized = await fetch(`${base}/admin/api/overview`, { headers: authHeaders() });
  const payload = await authorized.json();
  assert.equal(authorized.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.admin.tokenRequired, true);
  assert.deepEqual(payload.sources, []);
});

test("adding an OpenAPI source through the admin API makes it live", async () => {
  const { status, json } = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: {
      name: "petstore",
      spec: specPath,
      baseUrl: mock.url,
      security: { ApiKeyAuth: { token: "s3cret" } },
    },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.source.status, "ready");
  assert.equal(json.source.toolCount, 4);

  const tools = await fetch(`${base}/tools`, { headers: authHeaders() }).then((r) => r.json());
  assert.ok(tools.tools.some((tool: any) => tool.name === "petstore__listPets"));

  const call = await fetch(`${base}/api/petstore/listPets`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ limit: 1 }),
  }).then((r) => r.json());
  assert.equal(call.ok, true);
  assert.equal(call.data.items.length, 1);

  const stored = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.equal(stored.apis.length, 1);
  assert.equal(stored.apis[0].name, "petstore");
});

test("an MCP source added through the admin API is bridged to REST", async () => {
  const { status, json } = await adminPost("/admin/api/sources", {
    type: "mcp",
    name: "echo",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [path.resolve("test/fixtures/echo-mcp-server.mjs")],
    },
  });
  assert.equal(status, 200);
  assert.equal(json.source.status, "ready");
  assert.equal(json.source.toolCount, 4);

  const call = await fetch(`${base}/api/echo/add`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ a: 20, b: 22 }),
  }).then((r) => r.json());
  assert.equal(call.ok, true);
  assert.equal(call.data, 42);
});

test("pasted OpenAPI documents are stored next to the config", async () => {
  const specText = await readFile(specPath, "utf8");
  const { status, json } = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: { name: "pasted", specText, baseUrl: mock.url },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.source.toolCount, 4);

  const saved = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  const entry = saved.apis.find((api: any) => api.name === "pasted");
  assert.ok(entry.spec.endsWith(".json"), entry.spec);
  assert.ok(path.isAbsolute(entry.spec));
});

test("/admin/api/test validates a source without saving it", async () => {
  const api = await adminPost("/admin/api/test", {
    kind: "api",
    entry: { name: "probe", spec: specPath, baseUrl: mock.url },
  });
  assert.equal(api.status, 200);
  assert.equal(api.json.ok, true);
  assert.equal(api.json.toolCount, 4);
  assert.equal(api.json.detail.baseUrl, mock.url);
  assert.equal(api.json.detail.convertedFromSwagger2, false);

  const swagger2 = await adminPost("/admin/api/test", {
    kind: "api",
    entry: {
      name: "probe-swagger2",
      spec: path.resolve("test/fixtures/swagger2.fixture.json"),
    },
  });
  assert.equal(swagger2.json.ok, true);
  assert.equal(swagger2.json.toolCount, 5);
  assert.equal(swagger2.json.detail.convertedFromSwagger2, true);
  assert.equal(swagger2.json.detail.baseUrl, "https://api.v2.example.com/v1");

  const mcp = await adminPost("/admin/api/test", {
    kind: "mcp",
    entry: {
      name: "probe-mcp",
      transport: { type: "stdio", command: process.execPath, args: [path.resolve("test/fixtures/echo-mcp-server.mjs")] },
    },
  });
  assert.equal(mcp.json.ok, true);
  assert.equal(mcp.json.toolCount, 4);

  const broken = await adminPost("/admin/api/test", {
    kind: "mcp",
    entry: { name: "nope", transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] } },
  });
  assert.equal(broken.status, 422);
  assert.equal(broken.json.ok, false);
  assert.ok(broken.json.error);
});

test("invalid sources are rejected with a readable message", async () => {
  const badName = await adminPost("/admin/api/sources", {
    kind: "mcp",
    entry: { name: "../evil", transport: { type: "stdio", command: "node" } },
  });
  assert.equal(badName.status, 400);
  assert.match(badName.json.message, /名称/);

  const clash = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: { name: "echo", spec: specPath },
  });
  assert.equal(clash.status, 400);
  assert.match(clash.json.message, /已被另一类型的来源占用/);

  const missingKind = await adminPost("/admin/api/sources", { name: "x", spec: specPath });
  assert.equal(missingKind.status, 400);
  assert.equal(missingKind.json.error, "invalid_kind");
});

test("prompts are generated for every kind and follow the tool catalog", async () => {
  const mcp = await fetch(`${base}/admin/api/prompt?kind=mcp`, { headers: authHeaders() }).then((r) => r.json());
  assert.equal(mcp.ok, true);
  assert.match(mcp.text, /Streamable HTTP/);
  assert.match(mcp.text, /echo__add/);
  assert.match(mcp.text, /"mcpServers"/);

  const scoped = await fetch(`${base}/admin/api/prompt?kind=mcp&source=petstore`, { headers: authHeaders() }).then(
    (r) => r.json(),
  );
  assert.match(scoped.text, /petstore__listPets/);
  assert.ok(!scoped.text.includes("echo__add"));

  const rest = await fetch(`${base}/admin/api/prompt?kind=rest`, { headers: authHeaders() }).then((r) => r.json());
  assert.match(rest.text, /openapi\.json/);
  assert.match(rest.text, /POST .*\/api\/\{source\}\/\{tool\}/);

  const addMcp = await fetch(`${base}/admin/api/prompt?kind=add-mcp&name=myserver&command=npx%20-y%20pkg`, {
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.match(addMcp.text, /只输出一个 JSON 对象/);
  assert.match(addMcp.text, /myserver/);

  const addApi = await fetch(`${base}/admin/api/prompt?kind=add-api&spec=https%3A%2F%2Fexample.com%2Fopenapi.json`, {
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.match(addApi.text, /OpenAPI 3\.x/);
  assert.match(addApi.text, /example\.com/);

  const invalid = await fetch(`${base}/admin/api/prompt?kind=nope`, { headers: authHeaders() });
  assert.equal(invalid.status, 400);
});

test("deleting a managed source removes it from every surface", async () => {
  const removed = await fetch(`${base}/admin/api/sources/api/petstore`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.equal(removed.ok, true);

  const tools = await fetch(`${base}/tools`, { headers: authHeaders() }).then((r) => r.json());
  assert.ok(!tools.tools.some((tool: any) => tool.source === "petstore"));

  const again = await fetch(`${base}/admin/api/sources/api/petstore`, { method: "DELETE", headers: authHeaders() });
  assert.equal(again.status, 404);

  const stored = JSON.parse(await readFile(path.join(tempDir, "data", "managed-sources.json"), "utf8"));
  assert.ok(!stored.apis.some((api: any) => api.name === "petstore"));
});

test("reload re-reads the managed file from disk", async () => {
  const file = path.join(tempDir, "data", "managed-sources.json");
  const current = JSON.parse(await readFile(file, "utf8"));
  current.apis = current.apis.filter((api: any) => api.name !== "pasted");
  await writeFile(file, JSON.stringify(current, null, 2));

  const reloaded = await fetch(`${base}/admin/api/reload`, { method: "POST", headers: authHeaders() }).then((r) => r.json());
  assert.equal(reloaded.ok, true);
  assert.ok(!reloaded.sources.some((source: any) => source.name === "pasted"));
});
