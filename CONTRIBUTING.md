# 贡献指南

感谢你愿意改进 MCP ⇄ API Bridge。下面的约定能让 PR 更快被合并。

## 开发环境

- Node.js >= 20.9（CI 覆盖 20 / 22）
- 不需要数据库、不需要外部服务：测试里的上游 MCP Server 和 REST 服务都是本地模拟

```bash
npm ci
npm run build
npm test          # 编译 + node:test（单元 + 端到端）
npm run dev       # tsx watch，改 src/ 自动重启
```

`npm test` 会连接本机随机端口、拉起一个真实的 stdio MCP 子进程，全部离线完成。

## 目录约定

| 路径 | 职责 |
| --- | --- |
| `src/convert/openapi-to-tools.ts` | OpenAPI 操作 → 工具（参数映射、请求构造、响应转换） |
| `src/convert/tools-to-openapi.ts` | 工具 → OpenAPI 文档 |
| `src/openapi/` | 文档加载、`$ref` 内联、Swagger 2.0 转换 |
| `src/upstream/mcp.ts` | MCP 客户端（stdio / HTTP / SSE） |
| `src/mcp/gateway.ts` | 聚合 MCP Server |
| `src/http/` | Express 路由、鉴权、Streamable HTTP 端点 |
| `src/admin/` | 管理台后端（来源持久化、连通性测试、提示词生成） |
| `src/web/admin.html` | 管理台前端（纯 HTML/CSS/JS，无构建步骤） |
| `test/fixtures/` | 测试夹具（OpenAPI / Swagger 2.0 文档、echo MCP Server） |

前端刻意保持"单文件 + 原生 JS"，改完不需要额外构建，`npm run build` 会把 `src/web` 复制到 `dist`。

## 提交前自查

```bash
npm run build
npm test
```

- 新功能请补测试，放在 `test/*.test.ts`
- 修 bug 请加一个能复现该 bug 的用例
- 涉及协议/映射行为变更时，同步更新 README 的「转换规则」表格
- 不要提交 `bridge.config.yaml`、`.env`、`data/`（已在 `.gitignore` 中）

## 代码风格

- TypeScript strict，ESM，导入路径带 `.js` 后缀
- 不引入新的运行时依赖，除非确实无法用标准库 + 现有依赖解决（当前只有 `express`、`yaml`、`@modelcontextprotocol/sdk`）
- 对外部输入一律先 `isPlainObject` / 类型校验再使用
- 中文注释用于解释"为什么"，不要复述代码

## 提交信息

```
feat: 支持 Swagger 2.0 文档
fix: 修复 multipart 文件字段丢失
docs: 补充雨云 API 接入示例
test: 覆盖 collectionFormat 序列化
chore: 升级 @modelcontextprotocol/sdk
```

## Pull Request

1. 从 `main` 开分支
2. 描述里写清楚：动机、行为变化、如何验证（最好附一条可复现的 curl 或测试名）
3. CI 必须全绿
4. 行为不兼容的改动请标注 `BREAKING CHANGE`

## 安全问题

请勿通过公开 Issue 报告安全漏洞，见 [SECURITY.md](SECURITY.md)。

## 许可证

提交即表示你同意以 [MIT](LICENSE) 许可证发布你的贡献。
