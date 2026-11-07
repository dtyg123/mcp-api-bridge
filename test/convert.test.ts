import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildOpenApiTools, buildRequest } from "../src/convert/openapi-to-tools.js";
import { buildOpenApiDocument } from "../src/convert/tools-to-openapi.js";
import { loadOpenApiDocument } from "../src/openapi/loader.js";
import type { BridgeTool } from "../src/types.js";

const specPath = path.resolve("test/fixtures/petstore.openapi.json");

async function loadTools() {
  const loaded = await loadOpenApiDocument(specPath, { configDir: process.cwd() });
  return buildOpenApiTools({
    sourceName: "petstore",
    document: loaded.document,
    baseUrl: "http://localhost:1234",
    defaultHeaders: { "x-default": "1" },
    credentials: {},
    timeoutMs: 1000,
  });
}

test("OpenAPI operations become tools with a flat object schema", async () => {
  const tools = await loadTools();
  const byName = new Map(tools.map((tool) => [tool.originalName, tool]));
  assert.deepEqual([...byName.keys()].sort(), ["createPet", "getPetById", "listPets", "securePing"]);

  const listPets = byName.get("listPets")!;
  assert.equal(listPets.inputSchema.type, "object");
  const props = listPets.inputSchema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(props).sort(), ["limit", "status", "tags"]);
  assert.deepEqual(props.status.enum, ["available", "sold"], "$ref parameters are dereferenced");
  assert.deepEqual(listPets.inputSchema.required, []);

  const createPet = byName.get("createPet")!;
  assert.deepEqual(Object.keys(createPet.inputSchema.properties as object).sort(), ["age", "name", "tags"]);
  assert.deepEqual(createPet.inputSchema.required, ["name"]);
  assert.equal((createPet.inputSchema.properties as any).name.description, "Pet name");

  const getPetById = byName.get("getPetById")!;
  assert.deepEqual(getPetById.inputSchema.required, ["petId"]);
});

test("security requirements are captured from the document", async () => {
  const tools = await loadTools();
  const secure = tools.find((tool) => tool.originalName === "securePing")!;
  assert.equal(secure.request.security.length, 1);
  assert.equal(secure.request.security[0][0].scheme, "ApiKeyAuth");
  assert.equal(secure.request.security[0][0].in, "header");
});

test("buildRequest serializes path, query and merged JSON bodies", async () => {
  const tools = await loadTools();

  const getPet = tools.find((tool) => tool.originalName === "getPetById")!;
  const prepared = buildRequest(getPet.request, { petId: "a/b" });
  assert.equal(prepared.url, "http://localhost:1234/pets/a%2Fb");
  assert.equal((prepared.init.headers as Record<string, string>)["x-default"], "1");

  const listPets = tools.find((tool) => tool.originalName === "listPets")!;
  const queryPrepared = buildRequest(listPets.request, { limit: 2, tags: ["a", "b"], status: "sold" });
  const url = new URL(queryPrepared.url);
  assert.equal(url.searchParams.get("limit"), "2");
  assert.deepEqual(url.searchParams.getAll("tags"), ["a", "b"]);
  assert.equal(url.searchParams.get("status"), "sold");

  const createPet = tools.find((tool) => tool.originalName === "createPet")!;
  const bodyPrepared = buildRequest(createPet.request, { name: "Bolt", tags: ["fast"], age: 3 });
  assert.equal((bodyPrepared.init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(bodyPrepared.init.body)), { name: "Bolt", tags: ["fast"], age: 3 });
});

test("missing required path parameters are rejected before the request", async () => {
  const tools = await loadTools();
  const getPet = tools.find((tool) => tool.originalName === "getPetById")!;
  assert.throws(() => buildRequest(getPet.request, {}), /Missing required path parameter/);
});

test("MCP tools convert into a valid OpenAPI document", async () => {
  const apiTools = await loadTools();
  const mcpTool: BridgeTool = {
    source: "echo",
    sourceType: "mcp",
    name: "echo__describe_pet",
    originalName: "describe_pet",
    description: "Describe a pet.",
    inputSchema: {
      type: "object",
      properties: { pet: { $ref: "#/$defs/Pet" } },
      required: ["pet"],
      $defs: {
        Pet: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    },
    invoke: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };

  const document = buildOpenApiDocument({
    tools: [...apiTools, mcpTool],
    title: "Bridge",
    description: "doc",
    version: "3.1",
    serverUrl: "http://localhost:8080",
    basePath: "/api",
  });

  const paths = document.paths as Record<string, any>;
  assert.ok(paths["/api/listPets"], "api tools get a path");
  assert.ok(paths["/api/echo__describe_pet"], "mcp tools get a path");
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.servers, [{ url: "http://localhost:8080" }]);

  const schemas = (document.components as any).schemas;
  assert.ok(schemas.BridgeToolResult);
  const petSchemaKey = Object.keys(schemas).find((key) => key.endsWith("_Pet"));
  assert.ok(petSchemaKey, "nested $defs are hoisted into components.schemas");
  assert.equal(
    paths["/api/echo__describe_pet"].post.requestBody.content["application/json"].schema.properties.pet.$ref,
    `#/components/schemas/${petSchemaKey}`,
  );

  // GET variant exists for scalar-only tools.
  assert.ok(paths["/api/getPetById"].get);

  const doc30 = buildOpenApiDocument({
    tools: [...apiTools, mcpTool],
    title: "Bridge",
    description: "doc",
    version: "3.0",
    serverUrl: "http://localhost:8080",
    basePath: "/api",
  });
  assert.equal(doc30.openapi, "3.0.3");
});
