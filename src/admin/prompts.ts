import type { OutputConfig } from "../config.js";
import type { BridgeTool } from "../types.js";

export type PromptContext = {
  baseUrl: string;
  mcpPath: string;
  restPath: string;
  tools: BridgeTool[];
  /** Token that unlocks this output; empty means the global token (or none). */
  token: string;
};

const MAX_TOOLS_IN_PROMPT = 80;

function toolLines(tools: BridgeTool[]): string {
  if (tools.length === 0) return "_（这个输出没有单独列出的工具，调用 `tools/list` 或直接请求路径）_";
  const shown = tools.slice(0, MAX_TOOLS_IN_PROMPT);
  const lines = shown.map((tool) => {
    const summary = tool.description.replace(/\s+/g, " ").trim().slice(0, 70);
    return `- \`${tool.name}\`${summary ? `：${summary}` : ""}`;
  });
  if (tools.length > shown.length) lines.push(`- …另有 ${tools.length - shown.length} 个，以 tools/list 为准`);
  return lines.join("\n");
}

function mcpConfig(output: OutputConfig, ctx: PromptContext): string {
  const headers = ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {};
  return JSON.stringify(
    {
      mcpServers: {
        [output.name]: {
          type: "http",
          url: `${ctx.baseUrl}${ctx.mcpPath}/${output.name}`,
          ...(ctx.token ? { headers } : {}),
        },
      },
    },
    null,
    2,
  );
}

function firstCall(output: OutputConfig, ctx: PromptContext): string {
  const tool = ctx.tools[0];
  const base = `${ctx.baseUrl}${ctx.restPath}/${output.name}`;
  if (!tool) return `curl '${base}'${ctx.token ? ` \\\n  -H 'authorization: Bearer ${ctx.token}'` : ""}`;
  const sample = Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {})
    .slice(0, 3)
    .map((key) => `"${key}": "…"`)
    .join(", ");
  return `curl -X POST '${base}/${tool.name}' \\\n  -H 'content-type: application/json'${
    ctx.token ? ` \\\n  -H 'authorization: Bearer ${ctx.token}'` : ""
  } \\\n  -d '{${sample}}'`;
}

/** Compact, copy-paste ready prompt for one output. Schemas stay on the server. */
export function buildPrompt(output: OutputConfig, ctx: PromptContext): string {
  const lines: string[] = [
    "# 任务",
    `通过「MCP ⇄ API 网关」的输出 **${output.name}** 调用接口。服务端只注册了这个输出里的工具，其它工具不可见。`,
    "",
    "# 连接信息",
  ];

  if (output.form.includes("mcp") && output.mode !== "proxy") {
    lines.push(
      `- MCP 端点：\`${ctx.baseUrl}${ctx.mcpPath}/${output.name}\`（Streamable HTTP）`,
      `- 鉴权：${ctx.token ? `Authorization: Bearer ${ctx.token}` : "（当前无需鉴权）"}`,
      "",
      "# 客户端配置（可直接粘贴）",
      "```json",
      mcpConfig(output, ctx),
      "```",
    );
  }

  if (output.form.includes("api")) {
    lines.push(
      `- REST 调用：\`${ctx.baseUrl}${ctx.restPath}/${output.name}\``,
      ...(output.mode === "proxy"
        ? ["- 路径、方法、请求体与上游一致，直接调用即可"]
        : [
            `- 单个工具：\`POST ${ctx.baseUrl}${ctx.restPath}/${output.name}/{tool}\``,
            `- OpenAPI 文档：\`${ctx.baseUrl}/openapi/${output.name}.json\``,
          ]),
      `- 鉴权：${ctx.token ? `Authorization: Bearer ${ctx.token}` : "（当前无需鉴权）"}`,
      "",
      "# 调用示例",
      "```bash",
      firstCall(output, ctx),
      "```",
    );
  }

  lines.push(
    "",
    `# 可用工具（共 ${ctx.tools.length} 个）`,
    output.mode === "mirror"
      ? "工具名与上游完全一致：\n" + toolLines(ctx.tools)
      : toolLines(ctx.tools),
    "",
    "# 使用要求",
    "1. 只使用上面列出的工具；需要其它能力时先问我。",
    "2. 按 `inputSchema` 传参；缺少必填信息先问我，不要编造。",
    "3. 工具返回错误时把原文告诉我，不要自行补充结果。",
  );

  return lines.join("\n");
}
