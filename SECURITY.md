# 安全策略

## 支持范围

只有最新发布版本会收到安全修复。

## 报告漏洞

**不要**在公开 Issue 里报告安全问题。请使用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 → Security → Report a vulnerability），或在无法使用该功能时通过仓库维护者主页上的联系方式私下联系。

请尽量提供：

- 影响版本 / commit
- 复现步骤（配置片段、请求、负载）
- 影响范围（例如：未授权读取上游数据、SSRF、路径穿越、密钥泄露）

我会在 7 天内确认收到，并在修复发布后致谢（如果你愿意署名）。

## 部署方的安全责任

这个网关会**代表你调用上游 API 和 MCP Server**，所以它自身的安全边界等于你给它配置的凭证权限。部署时请至少确认：

| 项 | 要求 |
| --- | --- |
| `server.adminToken` / `BRIDGE_ADMIN_TOKEN` | 公网部署**必须**设置；管理台能增删来源、读到配置里的凭证引用 |
| `server.auth.rest` / `server.auth.mcp` | 对公网暴露对应接口时设置 |
| TLS | 不要在公网直接暴露 8080，前面套 Nginx / Caddy |
| `PUBLIC_BASE_URL` | 反向代理后设置，避免生成的文档里出现内网地址 |
| `.env` / `bridge.config.yaml` | 含密钥，已被 `.gitignore` 排除，不要提交 |
| 上游凭证 | 按最小权限申请；`apis[].security` 只填真正需要的方案 |
| `data/` 目录 | 含管理台新增的来源（可能有明文 token），注意文件权限与备份加密 |

## 已知的信任模型

- 来源由部署者配置，网关不会自动发现网络上的服务。
- `apis[].spec` 可以是任意 URL，网关会去拉取（这是功能，不是漏洞）；不要让不可信用户控制来源配置。
- stdio MCP 上游会以网关进程的身份执行命令（`mcpServers[].transport.command`），同样属于部署者的受信配置。
- `/openapi.json` 只暴露工具签名，不暴露上游凭证；但工具签名本身可能泄露内部系统结构，按需用 `rest`/`mcp` token 保护。
