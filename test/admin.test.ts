import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { CredentialStore } from "../src/admin/credentials.js";
import { SourceStore } from "../src/admin/store.js";
import { TransformStore } from "../src/admin/transforms.js";
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
let credentials: CredentialStore;
let transforms: TransformStore;
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

async function adminGet(pathname: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${pathname}`, { headers: authHeaders() });
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

  const outputs = await fetch(`${base}/admin/api/outputs`, { headers: authHeaders() }).then((r) => r.json());
  const petstoreOutput = outputs.outputs.find((output: any) => output.name === "petstore");
  assert.equal(petstoreOutput.toolCount, 4);
  assert.deepEqual(petstoreOutput.form.sort(), ["api", "mcp"]);

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

test("the admin tester lists every tool of a source and invokes them one by one", async () => {
  const listing = await fetch(`${base}/admin/api/sources/api/petstore/tools`, { headers: authHeaders() }).then((r) => r.json());
  assert.equal(listing.ok, true);
  assert.equal(listing.kind, "api");
  assert.equal(listing.count, 4);
  const listPets = listing.tools.find((tool: any) => tool.name === "listPets");
  assert.ok(listPets);
  assert.equal(listPets.fullName, "petstore__listPets");
  assert.equal(listPets.method, "GET");
  assert.equal(listPets.path, "/pets");
  assert.ok(listPets.inputSchema);
  assert.deepEqual(listPets.exposed, { rest: true, mcp: true });

  const ok = await adminPost("/admin/api/invoke", { source: "petstore", tool: "listPets", arguments: { limit: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.isError, false);
  assert.equal(ok.json.data.items.length, 1);
  assert.equal(ok.json.method, "GET");
  assert.equal(ok.json.path, "/pets");
  assert.equal(typeof ok.json.durationMs, "number");
  assert.ok(ok.json.invokedAt);

  const byFullName = await adminPost("/admin/api/invoke", { source: "petstore", tool: "petstore__listPets", arguments: {} });
  assert.equal(byFullName.status, 200);
  assert.equal(byFullName.json.tool, "listPets");

  const invalid = await adminPost("/admin/api/invoke", { source: "petstore", tool: "listPets", arguments: { limit: "nope" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "invalid_arguments");

  const unknownTool = await adminPost("/admin/api/invoke", { source: "petstore", tool: "nope", arguments: {} });
  assert.equal(unknownTool.status, 404);
  assert.equal(unknownTool.json.error, "unknown_tool");

  const unknownSource = await adminPost("/admin/api/invoke", { source: "ghost", tool: "listPets" });
  assert.equal(unknownSource.status, 404);

  const mismatch = await fetch(`${base}/admin/api/sources/mcp/petstore/tools`, { headers: authHeaders() });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "kind_mismatch");

  const wrongKind = await fetch(`${base}/admin/api/sources/bogus/petstore/tools`, { headers: authHeaders() });
  assert.equal(wrongKind.status, 400);

  const missing = await fetch(`${base}/admin/api/sources/api/ghost/tools`, { headers: authHeaders() });
  assert.equal(missing.status, 404);

  const mcpListing = await fetch(`${base}/admin/api/sources/mcp/echo/tools`, { headers: authHeaders() }).then((r) => r.json());
  assert.equal(mcpListing.ok, true);
  assert.equal(mcpListing.count, 4);
  assert.ok(mcpListing.tools.some((tool: any) => tool.name === "add"));

  const added = await adminPost("/admin/api/invoke", { source: "echo", tool: "add", arguments: { a: 2, b: 3 } });
  assert.equal(added.status, 200);
  assert.equal(added.json.ok, true);
  assert.equal(added.json.data, 5);
  assert.equal(added.json.method, undefined);
});

test("tools converted from Swagger 2.0 are listed for testing with method and path", async () => {
  const created = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: { name: "swagger-pets", spec: path.resolve("test/fixtures/swagger2.fixture.json") },
  });
  assert.equal(created.status, 200);

  const listing = await fetch(`${base}/admin/api/sources/api/swagger-pets/tools`, { headers: authHeaders() }).then((r) =>
    r.json(),
  );
  assert.equal(listing.count, 5);
  for (const tool of listing.tools) {
    assert.equal(typeof tool.method, "string");
    assert.equal(typeof tool.path, "string");
    assert.ok(tool.path.startsWith("/"));
  }
});

test("saved credentials are reused by sources and injected into upstream requests", async () => {
  const created = await adminPost("/admin/api/credentials", {
    credential: { name: "pet-header", type: "header", key: "X-Extra-Key", value: "header-secret", note: "测试用" },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.credential.hasValue, true);
  assert.ok(!JSON.stringify(created.json).includes("header-secret"));

  const listed = await fetch(`${base}/admin/api/credentials`, { headers: authHeaders() }).then((r) => r.json());
  assert.equal(listed.credentials.length, 1);
  assert.ok(!JSON.stringify(listed).includes("header-secret"));

  const invalid = await adminPost("/admin/api/credentials", { credential: { name: "../bad", type: "bearer", value: "x" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, "invalid_credential");

  // A source that references the credential by name.
  const source = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: {
      name: "petstore-cred",
      spec: specPath,
      baseUrl: mock.url,
      credentialRefs: ["pet-header"],
    },
  });
  assert.equal(source.status, 200);
  assert.equal(source.json.source.toolCount, 4);

  const call = await adminPost("/admin/api/invoke", { source: "petstore-cred", tool: "listPets", arguments: { limit: 1 } });
  assert.equal(call.status, 200);
  assert.equal(call.json.ok, true);
  const last = mock.requests[mock.requests.length - 1];
  assert.equal(last.headers["x-extra-key"], "header-secret");

  const usage = await fetch(`${base}/admin/api/credentials`, { headers: authHeaders() }).then((r) => r.json());
  assert.deepEqual(usage.credentials[0].usedBy, ["petstore-cred"]);

  const removed = await fetch(`${base}/admin/api/credentials/pet-header`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.equal(removed.ok, true);

  const gone = await fetch(`${base}/admin/api/credentials/pet-header`, { method: "DELETE", headers: authHeaders() });
  assert.equal(gone.status, 404);
});

test("response transforms reshape what the REST surface returns", async () => {
  const config = {
    blocks: [
      { op: "field", from: "items", as: "pets" },
      { op: "count", from: "items", as: "count" },
      { op: "constant", as: "source", value: "petstore-cred" },
      { op: "now", as: "generatedAt", format: "iso" },
      { op: "text", as: "headline", template: "共 {{items}} 条" },
    ],
  };

  const preview = await adminPost("/admin/api/transforms/preview", {
    config,
    sample: { items: [{ id: 1 }, { id: 2 }] },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.json.value.count, 2);
  assert.equal(preview.json.value.pets.length, 2);

  const saved = await fetch(`${base}/admin/api/transforms`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ source: "petstore-cred", tool: "listPets", config }),
  }).then((r) => r.json());
  assert.equal(saved.ok, true);
  assert.equal(saved.transform.tool, "listPets");

  const invalid = await fetch(`${base}/admin/api/transforms`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ source: "petstore-cred", tool: "listPets", config: { blocks: [{ op: "nope" }] } }),
  });
  assert.equal(invalid.status, 400);

  const rest = await fetch(`${base}/api/petstore-cred/listPets?limit=1`).then((r) => r.json());
  assert.equal(rest.ok, true);
  assert.equal(rest.transformed, true);
  assert.equal(rest.data.count, 1);
  assert.equal(rest.data.pets[0].name, "Rex");
  assert.equal(rest.data.source, "petstore-cred");
  assert.ok(rest.data.generatedAt);
  assert.ok(!("items" in rest.data));

  // The admin tester gets both the transformed result and the raw upstream one.
  const both = await adminPost("/admin/api/invoke", { source: "petstore-cred", tool: "listPets", arguments: { limit: 1 } });
  assert.equal(both.status, 200);
  assert.equal(both.json.transformed, true);
  assert.ok(both.json.raw, "raw envelope is included");
  assert.equal(both.json.raw.data.items.length, 1);
  assert.ok(!("items" in both.json.data));

  // The admin tester can still ask for the raw upstream payload.
  const raw = await adminPost("/admin/api/invoke", { source: "petstore-cred", tool: "listPets", arguments: { limit: 1 }, raw: true });
  assert.equal(raw.status, 200);
  assert.equal(raw.json.transformed, undefined);
  assert.equal(raw.json.data.items.length, 1);

  const listed = await fetch(`${base}/admin/api/transforms`, { headers: authHeaders() }).then((r) => r.json());
  assert.ok(listed.transforms.some((item: any) => item.source === "petstore-cred" && item.tool === "listPets"));

  const removed = await fetch(`${base}/admin/api/transforms/petstore-cred/listPets`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.equal(removed.ok, true);

  const afterDelete = await fetch(`${base}/api/petstore-cred/listPets?limit=1`).then((r) => r.json());
  assert.equal(afterDelete.transformed, undefined);
  assert.equal(afterDelete.data.items.length, 1);
});

test("the discover endpoint walks an upstream response into usable field paths", async () => {
  const { status, json } = await adminGet("/admin/api/sources/api/petstore/discover?tool=listPets");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.source, "petstore");
  assert.equal(json.tool, "listPets");
  const paths = json.fields.map((field: any) => field.path);
  assert.ok(paths.includes("items[].id"), `expected items[].id, got ${paths.join(", ")}`);
  assert.ok(paths.includes("items[].name"));
  assert.ok(paths.includes("items[].status"));
  // Array items are flagged so the UI can render list fields.
  const itemId = json.fields.find((field: any) => field.path === "items[].id");
  assert.equal(itemId.isArrayItem, true);
  assert.equal(itemId.type, "string");
  // The sample is capped so a huge payload cannot blow up the response.
  assert.ok(JSON.stringify(json.sample).length <= 210);
});

test("the discover endpoint returns an empty field list for a tool with no discoverable shape", async () => {
  // createPet is a POST that returns { created: <body> }; invoked with no body
  // it yields an empty object, so discovery returns ok with no fields.
  const { status, json } = await adminGet("/admin/api/sources/api/petstore/discover?tool=createPet");
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Array.isArray(json.fields));
  assert.equal(json.source, "petstore");
  assert.equal(json.tool, "createPet");
});

test("the discover endpoint reports an unknown tool without throwing", async () => {
  const { status, json } = await adminGet("/admin/api/sources/api/petstore/discover?tool=ghostTool");
  assert.equal(status, 404);
  assert.equal(json.ok, false);
  assert.equal(json.error, "unknown_tool");
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

test("prompts are generated per output and follow its tool subset", async () => {
  const prompt = await fetch(`${base}/admin/api/outputs/petstore/prompt`, { headers: authHeaders() }).then((r) => r.json());
  assert.equal(prompt.ok, true);
  assert.equal(prompt.toolCount, 4);
  assert.match(prompt.text, /Streamable HTTP/);
  assert.match(prompt.text, /petstore__listPets/);
  assert.match(prompt.text, /"mcpServers"/);
  assert.match(prompt.text, /\/mcp\/petstore/);
  assert.match(prompt.text, /\/api\/petstore/);
  assert.ok(!prompt.text.includes("echo__add"));

  const missing = await fetch(`${base}/admin/api/outputs/ghost/prompt`, { headers: authHeaders() });
  assert.equal(missing.status, 404);
});

test("deleting a managed source removes it from every surface", async () => {
  const removed = await fetch(`${base}/admin/api/sources/api/petstore`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => r.json());
  assert.equal(removed.ok, true);

  const outputs = await fetch(`${base}/admin/api/outputs`, { headers: authHeaders() }).then((r) => r.json());
  assert.ok(!outputs.outputs.some((output: any) => output.name === "petstore"), "output pruned");
  const call = await fetch(`${base}/api/petstore/listPets?limit=1`);
  assert.equal(call.status, 404);

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

test("the spec-schemes endpoint exposes security header names", async () => {
  const res = await adminPost("/admin/api/spec/schemes", { spec: specPath });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const scheme = (res.json.schemes || []).find((item: any) => item.name === "ApiKeyAuth");
  assert.ok(scheme, "ApiKeyAuth scheme is present");
  assert.equal(scheme.credentialType, "header");
  assert.equal(scheme.headerName, "x-api-key");
});

test("admin and REST callers can switch credentials when allowed", async () => {
  for (const [name, value] of [["cred-a", "a"], ["cred-b", "b"], ["cred-c", "c"]]) {
    const created = await adminPost("/admin/api/credentials", {
      credential: { name, type: "header", key: "X-Cred", value },
    });
    assert.equal(created.status, 200);
  }

  const switchSource = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: {
      name: "petstore-switch",
      spec: specPath,
      baseUrl: mock.url,
      credentialRefs: ["cred-a", "cred-b"],
      allowCredentialSwitch: true,
    },
  });
  assert.equal(switchSource.status, 200);

  // The switch is an output-level permission.
  const switchOutput = await adminPost("/admin/api/outputs", {
    name: "petstore-switch",
    mode: "convert",
    form: ["mcp", "api"],
    sources: [{ source: "petstore-switch" }],
    allowCredentialSwitch: true,
  });
  assert.equal(switchOutput.status, 200);

  const lastHeaders = () => mock.requests[mock.requests.length - 1].headers;

  // Defaults: both references merge, the last one wins on the shared header.
  await adminPost("/admin/api/invoke", { source: "petstore-switch", tool: "listPets", arguments: { limit: 1 } });
  assert.equal(lastHeaders()["x-cred"], "b");

  // Admin tester can switch for one call.
  const switched = await adminPost("/admin/api/invoke", {
    source: "petstore-switch",
    tool: "listPets",
    arguments: { limit: 1 },
    credential: "cred-a",
  });
  assert.equal(switched.status, 200);
  assert.equal(lastHeaders()["x-cred"], "a");

  const unknown = await adminPost("/admin/api/invoke", {
    source: "petstore-switch",
    tool: "listPets",
    arguments: { limit: 1 },
    credential: "missing",
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "unknown_credential");

  // REST caller switches via the header.
  const restSwitch = await fetch(`${base}/api/petstore-switch/listPets?limit=1`, {
    headers: { "x-bridge-credential": "cred-a" },
  });
  assert.equal(restSwitch.status, 200);
  assert.equal(lastHeaders()["x-cred"], "a");

  // A credential the source does not reference is rejected.
  const notAllowed = await fetch(`${base}/api/petstore-switch/listPets?limit=1`, {
    headers: { "x-bridge-credential": "cred-c" },
  });
  assert.equal(notAllowed.status, 400);
  assert.equal((await notAllowed.json()).error, "credential_not_allowed");

  // Sources that do not opt in reject the switch header.
  const noSwitch = await adminPost("/admin/api/sources", {
    kind: "api",
    entry: { name: "petstore-noswitch", spec: specPath, baseUrl: mock.url, credentialRefs: ["cred-a"] },
  });
  assert.equal(noSwitch.status, 200);
  const denied = await fetch(`${base}/api/petstore-noswitch/listPets?limit=1`, {
    headers: { "x-bridge-credential": "cred-a" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "credential_switch_disabled");
});
