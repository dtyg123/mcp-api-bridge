import type { JsonSchema } from "../types.js";
import { isPlainObject } from "./json.js";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Lightweight structural validation: required fields, types, enums, combinators. */
export function validateArgs(schema: JsonSchema, value: unknown, path = ""): string[] {
  return validate(schema, value, path || "arguments", 0);
}

function validate(schema: JsonSchema, value: unknown, path: string, depth: number): string[] {
  if (depth > 32 || !isPlainObject(schema)) return [];
  const issues: string[] = [];
  const label = path || "value";

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    issues.push(`${label} must be one of ${JSON.stringify(schema.enum)}`);
    return issues;
  }

  const type = schema.type;
  if (typeof type === "string") {
    if (!matchesType(value, type)) {
      issues.push(`${label} must be of type ${type} (got ${typeOf(value)})`);
      return issues;
    }
  } else if (Array.isArray(type) && type.length > 0) {
    if (!type.some((item) => typeof item === "string" && matchesType(value, item))) {
      issues.push(`${label} must be of type ${type.join(" | ")} (got ${typeOf(value)})`);
      return issues;
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (value[key] === undefined) issues.push(`${path ? `${path}.` : ""}${key} is required`);
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (value[key] === undefined) continue;
      issues.push(...validate(propSchema as JsonSchema, value[key], path ? `${path}.${key}` : key, depth + 1));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path ? `${path}.` : ""}${key} is not an accepted argument`);
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => {
      issues.push(...validate(schema.items as JsonSchema, item, `${path}[${index}]`, depth + 1));
    });
  }

  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) issues.push(...validate(item as JsonSchema, value, path, depth + 1));
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const results = schema.anyOf.map((item) => validate(item as JsonSchema, value, path, depth + 1));
    if (results.every((result) => result.length > 0)) {
      issues.push(`${label} does not match any allowed schema`);
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const results = schema.oneOf.map((item) => validate(item as JsonSchema, value, path, depth + 1));
    const passing = results.filter((result) => result.length === 0).length;
    if (passing !== 1) issues.push(`${label} must match exactly one alternative (matched ${passing})`);
  }

  return issues;
}

function coerceValue(schema: JsonSchema | undefined, raw: unknown): unknown {
  if (!schema || !isPlainObject(schema)) return raw;
  if (raw === undefined) return undefined;

  const type = schema.type;
  if (type === "array" || (Array.isArray(type) && type.includes("array"))) {
    const items = isPlainObject(schema.items) ? (schema.items as JsonSchema) : undefined;
    if (typeof raw === "string") {
      const values = raw.length === 0 ? [] : raw.split(",");
      return values.map((item) => coerceValue(items, item));
    }
    if (Array.isArray(raw)) return raw.map((item) => coerceValue(items, item));
    return [coerceValue(items, raw)];
  }

  if (typeof raw !== "string") return raw;

  if (type === "number" || type === "integer") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (type === "boolean") {
    const normalized = raw.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    return raw;
  }
  if (type === "object" || isPlainObject(schema.properties)) {
    if (raw.trim().startsWith("{")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (Array.isArray(type) && type.includes("boolean") && ["true", "false"].includes(raw.toLowerCase())) {
    return raw.toLowerCase() === "true";
  }
  return raw;
}

/** Turn Express query params into typed tool arguments using the input schema. */
export function coerceQueryArgs(schema: JsonSchema, query: Record<string, unknown>): Record<string, unknown> {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(query)) {
    out[key] = coerceValue(properties[key] as JsonSchema | undefined, raw);
  }
  return out;
}
