import assert from "node:assert/strict";
import { test } from "node:test";
import { downgradeSchemaTo30, ensureObjectSchema, hoistDefinitions } from "../src/convert/schema.js";

test("hoistDefinitions moves $defs to the root and rewrites refs", () => {
  const schema = {
    type: "object",
    properties: {
      pet: { $ref: "#/$defs/Pet" },
      other: { $ref: "#/definitions/Thing" },
    },
    $defs: {
      Pet: { type: "object", properties: { tag: { $ref: "#/$defs/Tag" } } },
      Tag: { type: "string" },
    },
    definitions: {
      Thing: { type: "integer" },
    },
  };

  const { schema: hoisted, defs } = hoistDefinitions(schema, "src_");

  assert.equal((hoisted as Record<string, unknown>).$defs, undefined);
  assert.deepEqual(Object.keys(defs).sort(), ["src_Pet", "src_Tag", "src_Thing"]);
  assert.equal((hoisted as any).properties.pet.$ref, "#/$defs/src_Pet");
  assert.equal((hoisted as any).properties.other.$ref, "#/$defs/src_Thing");
  assert.equal((defs.src_Pet as any).properties.tag.$ref, "#/$defs/src_Tag");
});

test("ensureObjectSchema wraps non-object roots", () => {
  const wrapped = ensureObjectSchema({ type: "string" });
  assert.equal(wrapped.type, "object");
  assert.deepEqual(wrapped.required, ["input"]);

  const passthrough = ensureObjectSchema({ type: "object", properties: { a: { type: "string" } } });
  assert.equal(passthrough.type, "object");
});

test("downgradeSchemaTo30 converts 2020-12 keywords", () => {
  const downgraded = downgradeSchemaTo30({
    type: "object",
    properties: {
      maybe: { type: ["string", "null"] },
      constant: { const: "fixed" },
      bounded: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
      referenced: { $ref: "#/components/schemas/X", description: "with sibling" },
    },
    $schema: "https://json-schema.org/draft/2020-12/schema",
  }) as Record<string, any>;

  assert.equal(downgraded.$schema, undefined);
  assert.deepEqual(downgraded.properties.maybe, { type: "string", nullable: true });
  assert.deepEqual(downgraded.properties.constant, { enum: ["fixed"] });
  assert.deepEqual(downgraded.properties.bounded, {
    type: "number",
    minimum: 0,
    exclusiveMinimum: true,
    maximum: 10,
    exclusiveMaximum: true,
  });
  assert.deepEqual(downgraded.properties.referenced, {
    description: "with sibling",
    allOf: [{ $ref: "#/components/schemas/X" }],
  });
});
