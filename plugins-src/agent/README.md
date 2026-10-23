# Agent Core

Agent 对话宿主。扩展只负责把附件落盘、把路径和工具权限交给 Agent；**怎么读取/解析文件由 Agent 自己决定**。

Agent Core 不认识任何具体后端。后端（provider）是独立扩展，例如 **Claude Code**；安装并启用后，Core 会发现并调用它。后续接入其它 Agent 后端也只需要新增 provider 扩展，不改 Core。

## 配置

打开「设置 → 扩展 → Agent Core」：

- **权限模式**
  - `read+parse`（默认）：允许 Agent 运行命令、写会话目录，适合让它自己调 `pdftotext`、Python、MinerU 等工具；
  - `read-only`：只允许读取；PDF 需要模型原生支持。
- **单个附件上限（MB）**：超过上限的文件会在上传阶段被拒绝。

具体后端的命令路径、模型、超时、隔离与 API 密钥由对应的 provider 扩展自己提供（例如 `imark.claude-code`）。

## 附件与会话

- 附件按 128 KiB 分块上传，写入 `extensions-data/imark.agent/sessions/<uuid>/attachments/`；
- 会话消息、`document.md` 快照和 `prepared/` 产物都在同一会话目录；
- 扩展只扫描 `prepared/` 做预览，不解析其中的源文件；
- 卸载扩展时平台会删除整个 `extensions-data/imark.agent/`。

## 权限与隐私

- 扩展以当前用户权限运行；`read+parse` 允许 Agent 运行 Bash/Python，**Windows 上没有 OS 级沙箱**。
- Agent 只拿到会话目录和文件路径；当前文档是只读快照，结果通过编辑器写回，不直接改 vault。
- 附件会随对话发送给 Agent 背后的模型服务，请只添加你愿意发送的内容。

## Provider 扩展契约

provider 扩展的清单必须声明：

```json
{
  "main": "./main.js",
  "extensionDependencies": ["imark.agent"],
  "contributes": { "imark.agentProviders": ["my-provider"] }
}
```

`activate()` 返回 `{ apiVersion: 1, providers: [...] }`。每个 provider 实现
`@shared/agentProvider` 里的 `AgentProvider`：`info`、`detect()`、`createSession()`。
Core 通过 `imark.extensions.getExtension(id).exports` 读取同一个宿主里的导出对象。

- `extensionDependencies` 既保证 Core 先激活，也保证两者在同一个宿主进程（导出对象不能跨宿主传输）。
- provider 自己读取自己的配置和 secret；Core 只传通用会话参数（会话 ID、cwd、权限模式、模型、可用命令、取消信号）。
- `detect()` 由 provider 自己实现：CLI、网络、凭据怎么探测由它决定。Core 只在选择器里汇总结果，不提供「检查后端」动作。
- Core 在自己的 `activate()` 里绝不等待 provider；注册表惰性求值，Core 启动完成后才打开。
- 每次 `createSession()` 都重新读取 provider 配置，因此设置改动下一轮生效。
- provider 通常不声明 `activationEvents`，由 Core 按需激活；如果它自己提供设置页动作，需要声明对应的 `onCommand:<命令>`。

参考实现：[`plugins-src/claude-code`](../claude-code/)。
