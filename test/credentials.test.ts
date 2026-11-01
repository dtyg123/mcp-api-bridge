import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  CredentialStore,
  credentialHeaders,
  maskCredential,
  normalizeCredential,
} from "../src/admin/credentials.js";
import { Logger } from "../src/util/logger.js";

const logger = new Logger("error", "text", "test");
let tempDir: string;
let store: CredentialStore;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-bridge-credentials-"));
  store = new CredentialStore(path.join(tempDir, "credentials.json"), logger);
  await store.init();
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("normalizeCredential validates each auth type", () => {
  const header = normalizeCredential({ name: "rainyun", type: "header", key: "X-Api-Key", value: " secret " });
  assert.equal(header.name, "rainyun");
  assert.equal(header.key, "X-Api-Key");
  assert.equal(header.value, "secret");
  assert.equal(header.type, "header");

  const bearer = normalizeCredential({ name: "openai", type: "bearer", token: "sk-123" });
  assert.equal(bearer.value, "sk-123");
  assert.equal(bearer.key, "");

  const basic = normalizeCredential({ name: "es", type: "basic", username: "elastic", password: "pw" });
  assert.equal(basic.username, "elastic");
  assert.equal(basic.password, "pw");
  assert.equal(basic.value, "");

  assert.throws(() => normalizeCredential({ name: "../evil", type: "bearer", value: "x" }), /名称/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "weird" }), /不支持/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "header", value: "x" }), /请求头名称/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "header", key: "X Key", value: "x" }), /不合法/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "header", key: "X-Key" }), /填写值/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "bearer" }), /token/);
  assert.throws(() => normalizeCredential({ name: "ok", type: "basic", password: "pw" }), /用户名/);
});

test("credentialHeaders builds the right request headers", () => {
  assert.deepEqual(
    credentialHeaders(normalizeCredential({ name: "a", type: "header", key: "X-Api-Key", value: "k1" })),
    { "x-api-key": "k1" },
  );
  assert.deepEqual(credentialHeaders(normalizeCredential({ name: "b", type: "bearer", value: "tok" })), {
    authorization: "Bearer tok",
  });
  assert.deepEqual(
    credentialHeaders(normalizeCredential({ name: "c", type: "basic", username: "u", password: "p" })),
    { authorization: `Basic ${Buffer.from("u:p").toString("base64")}` },
  );
});

test("maskCredential never returns the raw secret", () => {
  const masked = maskCredential(
    normalizeCredential({ name: "svc", type: "header", key: "X-Key", value: "super-secret-value" }),
  );
  assert.equal(masked.hasValue, true);
  assert.ok(!JSON.stringify(masked).includes("super-secret-value"));
  assert.equal(masked.name, "svc");
});

test("CredentialStore persists, keeps secrets on masked updates and resolves headers", async () => {
  await store.upsert({ name: "rainyun", type: "header", key: "X-Api-Key", value: "first-key" });
  await store.upsert({ name: "openai", type: "bearer", value: "sk-live" });

  const saved = JSON.parse(await readFile(path.join(tempDir, "credentials.json"), "utf8"));
  assert.equal(saved.credentials.length, 2);

  // Re-saving from the UI sends an empty value (it only ever saw the mask).
  await store.upsert({ name: "rainyun", type: "header", key: "X-Api-Key", value: "" });
  assert.equal(store.get("rainyun")?.value, "first-key");

  assert.deepEqual(store.headersFor(["rainyun", "openai", "ghost"]), {
    "x-api-key": "first-key",
    authorization: "Bearer sk-live",
  });
  assert.deepEqual(store.missing(["rainyun", "ghost"]), ["ghost"]);

  await store.load();
  assert.equal(store.list().length, 2);
  assert.equal(store.get("openai")?.value, "sk-live");

  assert.equal(await store.remove("openai"), true);
  assert.equal(await store.remove("openai"), false);
  assert.equal(store.list().length, 1);
});
