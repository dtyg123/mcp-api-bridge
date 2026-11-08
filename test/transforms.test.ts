import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  applyTransform,
  formatNow,
  normalizeTransform,
  parsePath,
  readPath,
  renderTemplate,
  TransformStore,
  type TransformConfig,
} from "../src/admin/transforms.js";
import { Logger } from "../src/util/logger.js";

const logger = new Logger("error", "text", "test");
let tempDir: string;
let store: TransformStore;

const payload = {
  code: 200,
  data: {
    items: [
      { id: 1, name: "Rex", meta: { tags: ["dog", "good"] } },
      { id: 2, name: "Milo", meta: { tags: [] } },
    ],
    total: 2,
    owner: { name: "Ada", email: "ada@example.com" },
  },
};

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "mcp-bridge-transforms-"));
  store = new TransformStore(path.join(tempDir, "transforms.json"), logger);
  await store.init();
});

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("parsePath handles dots, brackets and quoted keys", () => {
  assert.deepEqual(parsePath("a.b[0].c"), ["a", "b", 0, "c"]);
  assert.deepEqual(parsePath("data.items[2]"), ["data", "items", 2]);
  assert.deepEqual(parsePath('a["odd key"]'), ["a", "odd key"]);
  assert.deepEqual(parsePath(""), []);
});

test("readPath returns undefined instead of throwing on missing hops", () => {
  assert.equal(readPath(payload, "data.total"), 2);
  assert.equal(readPath(payload, "data.items[1].name"), "Milo");
  assert.equal(readPath(payload, "data.items[9].name"), undefined);
  assert.equal(readPath(payload, "data.nope.deeper"), undefined);
  assert.equal(readPath(payload, ""), payload);
});

test("renderTemplate fills placeholders and blanks unknown paths", () => {
  assert.equal(renderTemplate("{{data.total}} pets of {{ data.owner.name }}", payload), "2 pets of Ada");
  assert.equal(renderTemplate("[{{data.missing}}]", payload), "[]");
});

test("field blocks pick and rename values out of the payload", () => {
  const config: TransformConfig = {
    root: "data",
    blocks: [
      { op: "field", from: "total", as: "count" },
      { op: "field", from: "owner.name" },
      { op: "field", from: "missing" },
    ],
  };
  assert.deepEqual(applyTransform(config, payload).value, { count: 2, name: "Ada" });
});

test("text, constant, now, count and join blocks build new fields", () => {
  const config: TransformConfig = {
    root: "data",
    blocks: [
      { op: "text", as: "title", template: "{{total}} 个宠物，主人 {{owner.name}}" },
      { op: "constant", as: "source", value: "mcp-api-bridge" },
      { op: "constant", as: "flags", value: { cached: false } },
      { op: "now", as: "generatedAt", format: "iso" },
      { op: "now", as: "date", format: "date" },
      { op: "count", from: "items", as: "itemCount" },
      { op: "join", from: "items", as: "names", separator: "" },
    ],
  };
  const value = applyTransform(config, payload).value as Record<string, any>;
  assert.equal(value.title, "2 个宠物，主人 Ada");
  assert.equal(value.source, "mcp-api-bridge");
  assert.deepEqual(value.flags, { cached: false });
  assert.match(value.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(value.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(value.itemCount, 2);
  // join stringifies objects; ids/names are objects here, so just check shape.
  assert.equal(typeof value.names, "string");
});

test("an array element root reshapes one item", () => {
  const config: TransformConfig = {
    root: "data.items[1]",
    blocks: [
      { op: "field", from: "id" },
      { op: "field", from: "name", as: "label" },
      { op: "text", as: "summary", template: "#{{id}} {{name}}" },
    ],
  };
  assert.deepEqual(applyTransform(config, payload).value, { id: 2, label: "Milo", summary: "#2 Milo" });
});

test("passthrough keeps inherited fields and omit removes them", () => {
  const config: TransformConfig = {
    root: "data.owner",
    passthrough: true,
    blocks: [{ op: "omit", from: "email" }],
  };
  assert.deepEqual(applyTransform(config, payload).value, { name: "Ada" });
});

test("each rebuilds list items with nested blocks", () => {
  const config: TransformConfig = {
    blocks: [
      {
        op: "each",
        from: "data.items",
        as: "rows",
        blocks: [
          { op: "field", from: "id", as: "id" },
          { op: "field", from: "name", as: "title" },
          { op: "text", as: "summary", template: "#{{id}} {{name}}" },
        ],
      },
    ],
  };
  assert.deepEqual(applyTransform(config, payload).value, {
    rows: [
      { id: 1, title: "Rex", summary: "#1 Rex" },
      { id: 2, title: "Milo", summary: "#2 Milo" },
    ],
  });
});

test("an empty path means the current root for count, join and each", () => {
  const config: TransformConfig = {
    root: "data.items",
    blocks: [
      { op: "count", from: "", as: "total" },
      { op: "join", from: "", as: "labels", separator: "|" },
      {
        op: "each",
        from: "",
        as: "rows",
        blocks: [{ op: "field", from: "name", as: "label" }],
      },
    ],
  };
  const value = applyTransform(config, payload).value as Record<string, unknown>;
  assert.equal(value.total, 2);
  assert.equal(typeof value.labels, "string");
  assert.deepEqual(value.rows, [{ label: "Rex" }, { label: "Milo" }]);
});

test("missing root collapses to an empty object", () => {
  const config: TransformConfig = { root: "data.absent", blocks: [{ op: "field", from: "x" }] };
  assert.deepEqual(applyTransform(config, payload).value, {});
});

test("formatNow supports every documented format", () => {
  assert.match(String(formatNow("iso")), /T/);
  assert.match(String(formatNow("date")), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(formatNow("time")), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(typeof formatNow("timestamp"), "number");
  assert.equal(typeof formatNow("locale"), "string");
  const later = Number(formatNow("timestamp", 60)) - Number(formatNow("timestamp"));
  assert.ok(later >= 59_000 && later <= 61_000);
});

test("normalizeTransform validates operators and required fields", () => {
  assert.deepEqual(normalizeTransform({ blocks: [{ op: "field", from: "a" }] }), {
    blocks: [{ op: "field", from: "a" }],
  });
  assert.deepEqual(normalizeTransform({ root: " data ", passthrough: true, blocks: [{ op: "field", from: "a" }] }), {
    root: "data",
    passthrough: true,
    blocks: [{ op: "field", from: "a" }],
  });
  // Empty `from` is allowed where "the current root" is meaningful.
  assert.deepEqual(
    normalizeTransform({
      root: "data",
      blocks: [
        { op: "each", from: "", as: "rows", blocks: [{ op: "field", from: "name" }] },
        { op: "count", from: "", as: "total" },
        { op: "join", from: "", as: "all" },
      ],
    }),
    {
      root: "data",
      blocks: [
        { op: "each", from: "", as: "rows", blocks: [{ op: "field", from: "name" }] },
        { op: "count", from: "", as: "total" },
        { op: "join", from: "", as: "all", separator: ", " },
      ],
    },
  );
  assert.throws(() => normalizeTransform({ blocks: [{ op: "each", as: "x", blocks: [] }] }), /缺少 "from"/);

  assert.throws(() => normalizeTransform({ blocks: [] }), /至少需要一个积木块/);
  // A passthrough-only config (no blocks) is valid and returns the payload unchanged.
  assert.deepEqual(normalizeTransform({ passthrough: true, blocks: [] }), { passthrough: true, blocks: [] });
  assert.deepEqual(applyTransform({ passthrough: true, blocks: [] }, { a: 1, b: 2 }).value, { a: 1, b: 2 });
  assert.throws(() => normalizeTransform({ blocks: [{ op: "nope" }] }), /不支持/);
  assert.throws(() => normalizeTransform({ blocks: [{ op: "text" }] }), /缺少 "as"/);
  assert.throws(() => normalizeTransform({ blocks: [{ op: "now", as: "t", format: "week" }] }), /format/);
  assert.throws(() => normalizeTransform({ blocks: [{ op: "each", from: "a", as: "b", blocks: [{ op: "bogus" }] }] }), /blocks\[1\]/);
});

test("TransformStore persists, resolves the * default per output and removes entries", async () => {
  await store.upsert("out-a", "demo", "*", { root: "data", blocks: [{ op: "field", from: "total", as: "count" }] });
  await store.upsert("out-a", "demo", "listPets", { root: "data", blocks: [{ op: "field", from: "items" }] });
  await store.upsert("out-b", "demo", "listPets", { blocks: [{ op: "constant", as: "k", value: "b" }] });

  // Exact match wins, the output + source default is the fallback.
  assert.deepEqual(store.get("out-a", "demo", "listPets"), { root: "data", blocks: [{ op: "field", from: "items" }] });
  assert.deepEqual(store.get("out-a", "demo", "other"), { root: "data", blocks: [{ op: "field", from: "total", as: "count" }] });
  assert.equal(store.get("out-b", "demo", "other"), undefined, "the * default does not leak across outputs");
  assert.equal(store.get("nope", "demo", "listPets"), undefined);

  const saved = JSON.parse(await readFile(path.join(tempDir, "transforms.json"), "utf8"));
  assert.equal(saved.transforms.length, 3);
  assert.ok(saved.transforms.every((entry: any) => typeof entry.output === "string" && entry.output));

  await store.load();
  assert.equal(store.list().length, 3);
  assert.deepEqual(store.get("out-a", "demo", "listPets")?.blocks[0], { op: "field", from: "items" });

  assert.equal(await store.remove("out-a", "demo", "listPets"), true);
  assert.equal(await store.remove("out-a", "demo", "listPets"), false);
  assert.deepEqual(store.get("out-a", "demo", "listPets"), store.get("out-a", "demo", "*"));

  assert.equal(await store.removeOutput("out-b"), 1);
  assert.equal(store.get("out-b", "demo", "listPets"), undefined);
  assert.equal(store.list().length, 1);
});

test("TransformStore rejects unsafe output, source or tool names", async () => {
  await assert.rejects(() => store.upsert("../evil", "demo", "x", { blocks: [{ op: "field", from: "a" }] }), /不合法/);
  await assert.rejects(() => store.upsert("out", "../evil", "x", { blocks: [{ op: "field", from: "a" }] }), /不合法/);
  await assert.rejects(() => store.upsert("out", "demo", "../x", { blocks: [{ op: "field", from: "a" }] }), /不合法/);
});
