import type { JsonSchema } from "../types.js";
import { deepClone, isPlainObject } from "../util/json.js";

export const FREE_FORM_OBJECT: JsonSchema = { type: "object", additionalProperties: true };

function sanitizeDefName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Rewrite every `$ref` string in a schema tree. */
export function mapRefs<T>(node: T, mapper: (ref: string) => string): T {
  if (Array.isArray(node)) return node.map((item) => mapRefs(item, mapper)) as unknown as T;
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out[key] = mapper(value);
      continue;
    }
    out[key] = mapRefs(value, mapper);
  }
  return out as unknown as T;
}

/**
 * Pull `$defs` / `definitions` out of a schema into a flat map, rewriting local
 * refs so they still point at the hoisted copies (all under `#/$defs/...`).
 */
export function hoistDefinitions(
  schema: JsonSchema,
  prefix: string,
): { schema: JsonSchema; defs: Record<string, JsonSchema> } {
  const defs: Record<string, JsonSchema> = {};
  const rename = new Map<string, string>();
  const working = deepClone(schema);

  const collect = (node: Record<string, unknown>, depth: number): void => {
    if (depth > 24) return;
    for (const keyword of ["$defs", "definitions"]) {
      const container = node[keyword];
      if (!isPlainObject(container)) continue;
      for (const [name, definition] of Object.entries(container)) {
        if (!isPlainObject(definition)) continue;
        if (rename.has(name)) continue;
        const base = `${prefix}${sanitizeDefName(name)}`;
        let candidate = base;
        let index = 2;
        while (candidate in defs) {
          candidate = `${base}_${index}`;
          index += 1;
        }
        rename.set(name, candidate);
        defs[candidate] = definition as JsonSchema;
        collect(definition as Record<string, unknown>, depth + 1);
      }
      delete node[keyword];
    }
    for (const value of Object.values(node)) {
      if (isPlainObject(value)) collect(value, depth + 1);
      else if (Array.isArray(value)) {
        for (const item of value) if (isPlainObject(item)) collect(item as Record<string, unknown>, depth + 1);
      }
    }
  };

  collect(working as Record<string, unknown>, 0);

  const rewriteRef = (ref: string): string => {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    if (!match) return ref;
    const target = rename.get(decodeURIComponent(match[1]));
    return target ? `#/$defs/${target}` : ref;
  };

  for (const [key, definition] of Object.entries(defs)) {
    defs[key] = mapRefs(definition, rewriteRef);
  }

  const rewritten = mapRefs(working, rewriteRef) as JsonSchema;

  return { schema: rewritten, defs };
}

export function pointsToComponents(schema: JsonSchema): JsonSchema {
  return mapRefs(schema, (ref) => ref.replace(/^#\/\$defs\//, "#/components/schemas/"));
}

/** MCP requires `inputSchema` to be an object schema. Normalize whatever we got. */
export function ensureObjectSchema(schema: unknown): JsonSchema {
  if (!isPlainObject(schema)) return { ...FREE_FORM_OBJECT };
  const cloned = deepClone(schema) as JsonSchema;
  const type = cloned.type;
  if (type === "object" || (type === undefined && (isPlainObject(cloned.properties) || cloned.properties === undefined))) {
    if (cloned.type === undefined && (isPlainObject(cloned.properties) || cloned.additionalProperties !== undefined)) {
      cloned.type = "object";
    }
    return cloned;
  }
  if (Array.isArray(type) && type.includes("object")) return cloned;
  // Primitive / array root schema - wrap it so MCP validation still works.
  return {
    type: "object",
    properties: { input: cloned },
    required: ["input"],
    additionalProperties: false,
  };
}

/**
 * Best-effort downgrade of a JSON Schema 2020-12 fragment to the OpenAPI 3.0
 * dialect. Anything unsupported is left in place (tools generally tolerate it).
 */
export function downgradeSchemaTo30(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((item) => downgradeSchemaTo30(item));
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (["$schema", "$id", "$comment", "examples", "prefixItems", "contentEncoding", "contentMediaType", "unevaluatedProperties", "unevaluatedItems"].includes(key)) {
      if (key === "examples" && Array.isArray(value) && out.example === undefined && value.length > 0) {
        out.example = downgradeSchemaTo30(value[0]);
      }
      continue;
    }
    out[key] = downgradeSchemaTo30(value);
  }

  const type = out.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((item) => item !== "null");
    if (type.includes("null")) out.nullable = true;
    if (nonNull.length === 1) out.type = nonNull[0];
    else if (nonNull.length === 0) delete out.type;
    else out.type = nonNull;
  }

  if (typeof out.const !== "undefined") {
    out.enum = [out.const];
    delete out.const;
  }

  if (typeof out.exclusiveMinimum === "number") {
    if (out.minimum === undefined) out.minimum = out.exclusiveMinimum;
    out.exclusiveMinimum = true;
  }
  if (typeof out.exclusiveMaximum === "number") {
    if (out.maximum === undefined) out.maximum = out.exclusiveMaximum;
    out.exclusiveMaximum = true;
  }

  // In 3.0, siblings of $ref are ignored: wrap them in allOf.
  if (typeof out.$ref === "string" && Object.keys(out).length > 1) {
    const ref = out.$ref;
    const siblings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out)) if (key !== "$ref") siblings[key] = value;
    return { ...siblings, allOf: [{ $ref: ref }] };
  }

  return out;
}

/** Extract the `required` list from a schema, tolerating junk. */
export function requiredList(schema: JsonSchema | undefined): string[] {
  if (!schema || !Array.isArray(schema.required)) return [];
  return schema.required.filter((item): item is string => typeof item === "string");
}
