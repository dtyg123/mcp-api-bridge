import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildOpenApiTools, buildRequest } from "../src/convert/openapi-to-tools.js";
import { loadOpenApiDocument, OpenApiLoadError } from "../src/openapi/loader.js";
import { buildOpenApiDocument } from "../src/convert/tools-to-openapi.js";
import { convertSwagger2ToOpenApi, isSwagger2Document, Swagger2Error } from "../src/openapi/swagger2.js";

const specPath = path.resolve("test/fixtures/swagger2.fixture.json");

async function loadTools() {
  const loaded = await loadOpenApiDocument(specPath, { configDir: process.cwd() });
  const tools = buildOpenApiTools({
    sourceName: "rainyun",
    document: loaded.document,
    baseUrl: "https://api.v2.example.com/v1",
    defaultHeaders: {},
    credentials: { ApiKey: { token: "secret-key" } },
    timeoutMs: 1000,
  });
  return { loaded, tools };
}

test("Swagger 2.0 documents are converted and loaded", async () => {
  const { loaded } = await loadTools();
  assert.equal(loaded.document.openapi, "3.1.0");
  assert.equal(loaded.convertedFromSwagger2, true);
  assert.equal(loaded.serverUrl, "https://api.v2.example.com/v1");
  assert.equal(loaded.document.swagger, undefined);
  const components = loaded.document.components as Record<string, any>;
  assert.ok(components.schemas.RegisterRequest, "definitions are moved to components.schemas");
  assert.equal(components.securitySchemes.ApiKey.type, "apiKey");
  assert.equal(components.securitySchemes.ApiKey.name, "X-Api-Key");
});

test("in: body parameters are flattened into the tool schema", async () => {
  const { tools } = await loadTools();
  const register = tools.find((tool) => tool.originalName === "registerDomain")!;
  assert.ok(register, "body-only operation still yields a tool");
  const props = register.inputSchema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(props).sort(), ["domain", "duration", "template_sys_id", "type"]);
  assert.deepEqual([...(register.inputSchema.required as string[])].sort(), ["domain", "duration", "type"]);
  assert.deepEqual(props.type.enum, ["register", "transfer"]);
});

test("body parameters build a JSON request with merged properties", async () => {
  const { tools } = await loadTools();
  const register = tools.find((tool) => tool.originalName === "registerDomain")!;
  const prepared = buildRequest(register.request, {
    domain: "example.com",
    duration: 1,
    type: "register",
    template_sys_id: 7,
  });
  assert.equal(prepared.url, "https://api.v2.example.com/v1/domain/register");
  assert.equal(prepared.init.method, "POST");
  const headers = prepared.init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-api-key"], "secret-key", "apiKey securityDefinition is applied");
  assert.deepEqual(JSON.parse(String(prepared.init.body)), {
    domain: "example.com",
    duration: 1,
    type: "register",
    template_sys_id: 7,
  });
});

test("inline parameter schemas, $ref parameters and enums survive conversion", async () => {
  const { tools } = await loadTools();
  const list = tools.find((tool) => tool.originalName === "listCertifiedDomains")!;
  const props = list.inputSchema.properties as Record<string, any>;
  assert.deepEqual(Object.keys(props), ["options"]);
  assert.equal(props.options.type, "string");
  assert.deepEqual(list.inputSchema.required, ["options"], "shared #/parameters refs are inlined");

  const certify = tools.find((tool) => tool.originalName === "certifyDomain")!;
  const certifyProps = certify.inputSchema.properties as Record<string, any>;
  assert.deepEqual(certifyProps.status.enum, ["pending", "done"]);
  assert.equal(certifyProps.domains.type, "array");
});

test("collectionFormat maps to OpenAPI styles that serialize correctly", async () => {
  const { tools } = await loadTools();
  const certify = tools.find((tool) => tool.originalName === "certifyDomain")!;
  const prepared = buildRequest(certify.request, {
    domains: ["a", "b"],
    labels: ["x", "y"],
    status: "pending",
  });
  const url = new URL(prepared.url);
  assert.equal(url.searchParams.get("domains"), "a|b");
  assert.equal(url.searchParams.get("labels"), "x y");
  assert.equal(url.searchParams.get("status"), "pending");
});

test("path parameters and formData request bodies are converted", async () => {
  const { tools } = await loadTools();
  const renew = tools.find((tool) => tool.originalName === "renewDomain")!;
  const prepared = buildRequest(renew.request, { domainId: 42, years: 2 });
  const url = new URL(prepared.url);
  assert.equal(url.pathname, "/v1/domain/42/renew");
  assert.equal(url.searchParams.get("years"), "2");

  const upload = tools.find((tool) => tool.originalName === "uploadFile")!;
  assert.deepEqual([...(upload.inputSchema.required as string[])].sort(), ["bucket", "file"]);
  assert.equal(upload.request.body.kind, "multipart");
  const uploadPrepared = buildRequest(upload.request, { bucket: "b1", file: "payload" });
  assert.equal(
    (uploadPrepared.init.headers as Record<string, string>)["content-type"],
    undefined,
    "multipart boundary is left to fetch",
  );
  const form = uploadPrepared.init.body as FormData;
  assert.equal(form.get("bucket"), "b1");
  assert.equal(form.get("file"), "payload");
});

test("converted tools still produce an OpenAPI document", async () => {
  const { tools } = await loadTools();
  const document = buildOpenApiDocument({
    tools,
    title: "Bridge",
    description: "Round trip",
    version: "3.1",
    serverUrl: "https://bridge.example.com",
    basePath: "/api",
  });
  assert.equal(document.openapi, "3.1.0");
  const operation = (document.paths as Record<string, any>)["/api/registerDomain"].post;
  assert.ok(operation, "each tool becomes a POST endpoint");
  assert.deepEqual(
    Object.keys(operation.requestBody.content["application/json"].schema.properties).sort(),
    ["domain", "duration", "template_sys_id", "type"],
  );
});

test("non-Swagger-2 documents are rejected by the converter", async () => {
  assert.equal(isSwagger2Document({ swagger: "2.0" }), true);
  assert.equal(isSwagger2Document({ openapi: "3.1.0" }), false);
  assert.throws(() => convertSwagger2ToOpenApi({ openapi: "3.1.0", paths: {} }), Swagger2Error);
  assert.throws(() => convertSwagger2ToOpenApi({ swagger: "2.0" }), /no "paths" object|no \"paths\" object/);
});

test("Swagger 1.x produces a clear load error", async () => {
  const legacy = path.resolve("test/fixtures/swagger1.fixture.json");
  await assert.rejects(
    () => loadOpenApiDocument(legacy, { configDir: process.cwd() }),
    (error: unknown) => error instanceof OpenApiLoadError && /Swagger version/.test(error.message),
  );
});
