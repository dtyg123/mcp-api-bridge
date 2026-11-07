import type { BridgeTool } from "../types.js";

export type PromptKind = "mcp" | "rest" | "service" | "add-mcp" | "add-api";

export type PromptContext = {
  baseUrl: string;
  mcpPath: string;
  restPath: string;
  mcpToken: string;
  restToken: string;
  /** Per-source token, when the source has its own access token. */
  sourceToken?: string;
  configFile: string;
  tools: BridgeTool[];
  source?: string;
  hint?: Record<string, string>;
};

const MAX_TOOLS_IN_PROMPT = 80;

function authLine(token: string): string {
  return token ? `Authorization: Bearer ${token}` : "（当前未启用鉴权，无需 Header）";
}

function toolLines(tools: BridgeTool[]): string {
  if (tools.length === 0) return "_（当前没有可用工具，请先在管理台添加来源）_";
  const shown = tools.slice(0, MAX_TOOLS_IN_PROMPT);
  const lines = shown.map((tool) => {
    const summary = tool.description.replace(/\s+/g, " ").trim().slice(0, 110);
    return `- \`${tool.name}\`（${tool.source}）：${summary || tool.originalName}`;
  });
  if (tools.length > shown.length) lines.push(`- …还有 ${tools.length - shown.length} 个，请以 tools/list 或 /tools 为准`);
  return lines.join("\n");
}

function mcpClientConfig(ctx: PromptContext): string {
  const headers: Record<string, string> = {};
  const token = ctx.sourceToken || ctx.mcpToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const config = {
    mcpServers: {
      bridge: {
        type: "http",
        url: `${ctx.baseUrl}${ctx.mcpPath}${ctx.source ? `/${ctx.source}` : ""}`,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

function restExample(ctx: PromptContext): string {
  const tool = ctx.tools[0];
  const path = `/api/{source}/{tool}`;
  if (!tool) return `curl -X POST '${ctx.baseUrl}${ctx.restPath}/<source>/<tool>' \\\n  -H 'content-type: application/json' \\\n  -d '{}'`;
  const sample = Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {})
    .slice(0, 3)
    .map((key) => `"${key}": "…"`)
    .join(", ");
  const header = ctx.restToken ? ` \\\n  -H 'authorization: Bearer ${ctx.restToken}'` : "";
  return `curl -X POST '${ctx.baseUrl}${ctx.restPath}/${tool.source}/${tool.originalName}' \\\n  -H 'content-type: application/json'${header} \\\n  -d '{${sample}}'`;
}

export function buildPrompt(kind: PromptKind, ctx: PromptContext): string {
  const lines: string[] = [];
  const scope = ctx.source ? `（仅 ${ctx.source}）` : "";

  if (kind === "mcp") {
    lines.push(
      "# 任务",
      "请通过 **MCP** 连接我的「MCP ⇄ API 网关」，并在需要时调用其中的工具。",
      "",
      "# 连接信息",
      `- 传输方式：Streamable HTTP（MCP 2025 规范，兼容 JSON 响应）`,
      `- 端点：\`${ctx.baseUrl}${ctx.mcpPath}\`${ctx.source ? `（单来源端点：\`${ctx.baseUrl}${ctx.mcpPath}/${ctx.source}\`）` : ""}`,
      `- 鉴权：${authLine(ctx.mcpToken)}`,
      "",
      "# 客户端配置（Claude Desktop / Cursor / Cline / Cherry Studio 等，可直接粘贴）",
      "```json",
      mcpClientConfig(ctx),
      "```",
      "",
      "如果客户端只支持 stdio，用容器以 stdio 模式启动：",
      "```bash",
      `docker run -i --rm -v "${ctx.configFile}:/app/bridge.config.yaml:ro" mcp-api-bridge:latest --stdio`,
      "```",
      "",
      "# 工具命名规则",
      "工具名为 `{来源}__{工具名}`，例如 `petstore__getPetById`；同名工具由网关自动去重加后缀。",
      "",
      `# 当前可用工具${scope}（共 ${ctx.tools.length} 个）`,
      toolLines(ctx.tools),
      "",
      "# 使用要求",
      "1. 先调用 `tools/list` 获取最新工具清单，不要凭记忆猜工具名。",
      "2. 严格按每个工具的 `inputSchema` 传参；缺少必填信息时先问我，不要编造。",
      "3. 工具返回 `isError: true` 时，把错误原文告诉我，不要自行补充结果。",
      "4. 结果里的图片/资源块（image、resource）按原样展示或引用，不要丢失。",
    );
  } else if (kind === "rest") {
    lines.push(
      "# 任务",
      "请通过 **HTTP / OpenAPI** 调用我的工具网关（MCP 工具已统一封装为 REST 接口）。",
      "",
      "# 基本信息",
      `- OpenAPI 文档：\`${ctx.baseUrl}/openapi.json\``,
      `- 调用地址：\`POST ${ctx.baseUrl}${ctx.restPath}/{source}/{tool}\``,
      `- 请求体：工具参数对象（JSON）`,
      `- 鉴权：${authLine(ctx.restToken)}`,
      `- 简单工具也可用 GET：\`GET ${ctx.baseUrl}${ctx.restPath}/{source}/{tool}?参数=值\``,
      "",
      "# 响应结构",
      "```json",
      '{ "ok": true, "isError": false, "text": "文本结果", "data": {}, "content": [], "meta": {} }',
      "```",
      "`ok`/`isError` 表示工具是否成功；`data` 是结构化结果；`text` 是可直接展示的文本。",
      "",
      "# 调用示例",
      "```bash",
      restExample(ctx),
      "```",
      "",
      `# 可用工具${scope}（共 ${ctx.tools.length} 个）`,
      toolLines(ctx.tools),
      "",
      "# 使用要求",
      "1. 需要参数细节时先读 `/openapi.json`，按其中 schema 传参。",
      "2. 不要把参数包在 `arguments` 里，请求体直接就是参数对象。",
      "3. 收到 `ok: false` 时把 `text` 里的错误信息告诉我，不要重试编造数据。",
    );
  } else if (kind === "service") {
    // One self-contained prompt per service: single-source endpoint + only that
    // service's tools, so an AI can be scoped to exactly this service.
    const name = ctx.source || "全部来源";
    lines.push(
      "# 任务",
      `请通过「MCP ⇄ API 网关」使用**独立服务 ${name}**。该端点只注册了下面这些工具（服务端限制）：调用其它来源的工具会被拒绝（Unknown tool）。`,
      "",
      "# 连接信息（单来源）",
      `- MCP 端点：\`${ctx.baseUrl}${ctx.mcpPath}${ctx.source ? `/${ctx.source}` : ""}\``,
      `- REST 调用：\`POST ${ctx.baseUrl}${ctx.restPath}/${ctx.source ?? "{source}"}/{tool}\``,
      ...(ctx.sourceToken ? [] : [`- OpenAPI 文档：\`${ctx.baseUrl}/openapi.json\``]),
      `- 鉴权：${authLine(ctx.sourceToken || ctx.mcpToken)}${
        ctx.sourceToken ? "（该令牌只能访问本服务，不能访问聚合端点）" : ""
      }`,
      "",
      "# 客户端配置（只接入该服务）",
      "```json",
      mcpClientConfig(ctx),
      "```",
      "",
      `# 该服务可用的工具（共 ${ctx.tools.length} 个）`,
      toolLines(ctx.tools),
      "",
      "# 使用要求",
      "1. 只使用上面列出的工具；需要其它服务的能力时先问我，不要自行切换。",
      "2. 严格按每个工具的 `inputSchema` 传参；缺少必填信息先问我，不要编造。",
      "3. 工具返回 `isError: true` 时，把错误原文告诉我，不要自行补充结果。",
    );
  } else if (kind === "add-mcp") {
    const hint = ctx.hint ?? {};
    lines.push(
      "# 任务",
      "我要在这个 MCP ⇄ API 网关里新增一个 **MCP Server** 来源，请生成一段可直接导入管理台的 JSON。",
      "",
      "# 输出要求",
      "- 只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要注释。",
      "- 字段必须完整，未知信息用 \"TODO: 待补充\" 占位，不要编造真实地址或密钥。",
      "",
      "# 目标格式",
      "```json",
      JSON.stringify(
        {
          type: "mcp",
          name: "my-server",
          description: "一句话说明",
          transport: { type: "stdio", command: "npx", args: ["-y", "@scope/mcp-server"], env: {} },
          exposure: { rest: true, mcp: true, prefix: "" },
        },
        null,
        2,
      ),
      "```",
      "远程服务把 transport 换成：",
      '`{ "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } }`',
      "（也支持 `\"type\": \"sse\"` 连接旧版 SSE 端点）",
      "",
      "# 约束",
      "- `name` 只能包含字母、数字、`.`、`_`、`-`，以字母或数字开头，最长 64。",
      "- stdio：`command` 必须是可直接执行的文件名（npx / uvx / node / python），把包名放 `args`。",
      "- 需要密钥时放到 `env`（stdio）或 `headers`（http），不要写进 args 或 url。",
      "- 网关会把该 MCP Server 的每个工具自动映射成 REST 接口和 MCP 工具。",
      "",
      "# 我的服务器信息",
      `- 名称：${hint.name || "（我还没想好，请建议一个）"}`,
      `- 启动方式 / 地址：${hint.command || hint.url || "（见下方补充说明）"}`,
      `- 补充说明：${hint.note || "（无）"}`,
    );
  } else {
    const hint = ctx.hint ?? {};
    lines.push(
      "# 任务",
      "我要在这个 MCP ⇄ API 网关里新增一个 **OpenAPI 服务** 来源，请生成一段可直接导入管理台的 JSON。",
      "",
      "# 输出要求",
      "- 只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要注释。",
      "",
      "# 目标格式",
      "```json",
      JSON.stringify(
        {
          type: "api",
          name: "my-service",
          description: "一句话说明",
          spec: "https://example.com/openapi.json",
          baseUrl: "",
          headers: {},
          security: { BearerAuth: { token: "TODO: 待补充" } },
          include: [],
          exclude: [],
          exposure: { rest: true, mcp: true, prefix: "" },
        },
        null,
        2,
      ),
      "```",
      "",
      "# 字段说明",
      "- `spec`：OpenAPI 3.x 文档地址（JSON 或 YAML）；本地文件可用绝对路径。",
      "- `baseUrl`：留空则用文档里的 `servers[0].url`；文档里没有时必填。",
      "- `security`：按文档 `components.securitySchemes` 里的名字填凭证，支持 `token` / `apiKey` / `username`+`password`。",
      "- `include` / `exclude`：按 `\"GET /pet/{petId}\"` 或 operationId 过滤，支持 `*` 通配；留空表示全部暴露。",
      "- 每个 operation 会变成一个 MCP 工具，工具名为 `{name}__{operationId}`。",
      "",
      "# 我的服务信息",
      `- 名称：${hint.name || "（请建议一个）"}`,
      `- OpenAPI 文档地址：${hint.spec || "（见下方补充说明）"}`,
      `- 补充说明：${hint.note || "（无）"}`,
    );
  }

  return lines.join("\n");
}
