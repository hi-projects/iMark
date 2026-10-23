# Agent Core

Agent 对话宿主。扩展只负责把附件落盘、把路径交给 Agent；**怎么读取/解析文件由 Agent 自己决定**。

Agent Core 不认识任何具体后端。后端（provider）是独立扩展，例如 **Claude Code**；安装并启用后，Core 会发现并调用它。后续接入其它 Agent 后端也只需要新增 provider 扩展，不改 Core。

## 配置

打开「设置 → 扩展 → Agent Core」：

- **系统提示词**：文本域里默认展示内置规则（打包时从 `core/prompt.ts` 的 `SYSTEM_PROMPT` 注入到清单默认值，两者不会漂移）；可以整段自定义，点标题右侧的恢复图标回到内置版本，清空也等同于使用默认值。
- **单个附件上限（MB）**：超过上限的文件会在上传阶段被拒绝。

具体后端的命令路径、模型、超时与 API 密钥由对应的 provider 扩展自己提供（例如 `imark.claude-code`）。Core 不提供任何权限设置。

## 附件与会话

- 会话**完全不绑定文档**：切换文档不影响会话；需要当前文档时，点输入框上方的「＋ 本文档」把它当作一条普通附件加进来；
- 附件按 128 KiB 分块上传；内容按 sha256 存在共享的 `extensions-data/imark.agent/blobs/`，各会话的 `attachments/` 是指向它的硬链接，因此同一个文件放进多个会话只占一份磁盘（不支持硬链接的文件系统退回独立副本）；附件只属于发出的那一条消息，发送后从待发区移除，显示在对应的用户消息里；
- 会话消息、附件和 `prepared/` 产物都在同一会话目录；
- 扩展只扫描 `prepared/` 做预览，不解析其中的源文件；
- 对话面板与产物预览支持 Markdown、Mermaid、KaTeX 公式；图片会先按会话目录解析并内联成 data URI，再交给 webview 显示（面板 CSP 不放行本地文件路径）；
- 发送按钮左边的 ⓘ 悬停可查看本轮真正发给 Agent 的完整提示词（系统规则 + 附件绝对路径 + 产物清单 + 命令探测）；预览不改会话状态；
- 卸载扩展时平台会删除整个 `extensions-data/imark.agent/`。

## 权限与隐私

- 扩展以当前用户权限运行，**Windows 上没有 OS 级沙箱**。
- Agent 只拿到会话目录和文件路径；当前文档只有在用户主动添加时才以只读附件形式进入会话，结果通过编辑器写回，不直接改 vault。
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
- provider 自己读取自己的配置和 secret；Core 只传通用会话参数（会话 ID、cwd、取消信号）。
- `detect()` 由 provider 自己实现：CLI、网络、凭据怎么探测由它决定。Core 只在选择器里汇总结果，不提供「检查后端」动作。
- Core 在自己的 `activate()` 里绝不等待 provider；注册表惰性求值，Core 启动完成后才打开。
- 每次 `createSession()` 都重新读取 provider 配置，因此设置改动下一轮生效。
- provider 通常不声明 `activationEvents`，由 Core 按需激活；如果它自己提供设置页动作，需要声明对应的 `onCommand:<命令>`。

参考实现：[`plugins-src/claude-code`](../claude-code/)。
