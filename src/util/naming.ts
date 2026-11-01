/** MCP tool names must match `^[A-Za-z0-9_-]{1,64}$` in practice. */
const MAX_TOOL_NAME = 64;

export function sanitizeToolName(raw: string, fallback = "tool"): string {
  let name = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) name = fallback;
  if (name.length > MAX_TOOL_NAME) {
    const slug = shortHash(raw);
    name = `${name.slice(0, MAX_TOOL_NAME - slug.length - 1)}_${slug}`;
  }
  return name;
}

export function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

/** Register `name` in `used`, appending a counter when it already exists. */
export function claimName(name: string, used: Set<string>, maxLength = MAX_TOOL_NAME): string {
  let candidate = name;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `_${index}`;
    candidate = `${name.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Very small glob matcher: `*` matches anything, `?` matches one character. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
