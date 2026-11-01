// Minimal MCP stdio server used by the end-to-end tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "describe_pet",
    description: "Describe a pet (uses $defs to exercise schema hoisting).",
    inputSchema: {
      type: "object",
      properties: { pet: { $ref: "#/$defs/Pet" } },
      required: ["pet"],
      $defs: {
        Pet: {
          type: "object",
          properties: { name: { type: "string" }, kind: { type: "string", enum: ["cat", "dog"] } },
          required: ["name"],
        },
      },
    },
  },
  {
    name: "boom",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server({ name: "echo-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo:${args.text}` }] };
    case "add":
      return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
    case "describe_pet":
      return {
        content: [{ type: "text", text: JSON.stringify(args.pet) }],
        structuredContent: args.pet,
      };
    default:
      return { content: [{ type: "text", text: `tool ${name} failed` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
