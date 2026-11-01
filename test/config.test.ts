import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

async function withConfig(content: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-config-"));
  const file = path.join(dir, "bridge.yaml");
  await writeFile(file, content);
  try {
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadConfig applies defaults and interpolates environment variables", async () => {
  process.env.BRIDGE_TEST_TOKEN = "abc123";
  await withConfig(
    `
server:
  port: 9999
  auth:
    rest: \${BRIDGE_TEST_TOKEN}
    mcp: \${BRIDGE_TEST_MISSING:-fallback}
logging:
  level: warn
mcpServers:
  - name: fs
    transport:
      type: stdio
      command: node
      args: ["x.js"]
apis:
  - name: demo
    spec: ./demo.yaml
    exposure:
      rest: false
`,
    async (file) => {
      const config = await loadConfig(file);
      assert.equal(config.server.port, 9999);
      assert.equal(config.server.host, "0.0.0.0");
      assert.equal(config.server.basePath, "");
      assert.equal(config.server.mcp.path, "/mcp");
      assert.equal(config.server.mcp.sessionMode, "stateful");
      assert.equal(config.server.auth.restToken, "abc123");
      assert.equal(config.server.auth.mcpToken, "fallback");
      assert.equal(config.logging.level, "warn");
      assert.equal(config.mcpServers[0].transport.type, "stdio");
      assert.deepEqual(config.apis[0].exposure, { rest: false, mcp: true, prefix: "" });
      assert.equal(config.apis[0].spec, "./demo.yaml");
      assert.equal(config.configDir, path.dirname(file));
      assert.equal(config.openapi.version, "3.1");
    },
  );
});

test("loadConfig rejects duplicate source names", async () => {
  await withConfig(
    `
mcpServers:
  - name: dup
    transport: { type: stdio, command: node }
apis:
  - name: dup
    spec: ./spec.yaml
`,
    async (file) => {
      await assert.rejects(() => loadConfig(file), ConfigError);
    },
  );
});

test("loadConfig rejects invalid transports", async () => {
  await withConfig(
    `
mcpServers:
  - name: broken
    transport: { type: stdio }
`,
    async (file) => {
      await assert.rejects(() => loadConfig(file), /stdio transport requires "command"/);
    },
  );
});

test("CLI style JSON configs are accepted", async () => {
  await withConfig(JSON.stringify({ server: { port: 7000 }, logging: { format: "json" } }), async (file) => {
    const config = await loadConfig(file);
    assert.equal(config.server.port, 7000);
    assert.equal(config.logging.format, "json");
    assert.deepEqual(config.mcpServers, []);
    assert.deepEqual(config.apis, []);
  });
});
