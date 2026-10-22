# Agent

通用 Agent 对话面板。插件只负责把附件落盘、把路径和工具权限交给 Agent；**怎么读取/解析文件由 Agent 自己决定**。

首个 provider 是 **Claude Code**（本机 CLI）。插件不内置任何 PDF/Office 解析器，也不把 Claude Code runtime 打进扩展包。

## 配置

打开「设置 → 扩展 → Agent」：

- **权限模式**
  - `read+parse`（默认）：允许 Agent 运行命令、写会话目录，适合让它自己调 `pdftotext`、Python、MinerU 等工具；
  - `read-only`：只允许 Read/Glob/Grep；PDF 需要模型原生支持。
- **Claude Code 可执行文件**：留空自动探测 PATH / `%USERPROFILE%\.local\bin\claude.exe` / 已安装的 VS Code Claude Code 扩展自带 native binary；也可以填 `claude.exe`、`claude.cmd` 的完整路径。
- **模型**：留空使用 CLI 默认；可填 `sonnet` / `opus` / `haiku` 或完整模型名。
- **隔离**：
  - `safe`（默认）：禁用 CLAUDE.md/技能/hooks 等自定义，保留登录态；
  - `restricted`：进一步限制文件工具与设置文件；
  - `off`：完全使用 Claude Code 自己的设置。
- **API 密钥**：可选。留空复用本机 `claude` 登录态；填写后只通过子进程环境变量注入，不进入界面、日志或会话文件。

## 附件与会话

- 附件按 128 KiB 分块上传，写入 `extensions-data/imark.agent/sessions/<uuid>/attachments/`；
- 会话消息、`document.md` 快照和 `prepared/` 产物都在同一会话目录；
- 插件只扫描 `prepared/` 做预览，不解析其中的源文件；
- 卸载扩展时平台会删除整个 `extensions-data/imark.agent/`。

## 权限与隐私

- 扩展以当前用户权限运行；`read+parse` 允许 Agent 运行 Bash/Python，**Windows 上没有 OS 级沙箱**。
- Agent 只拿到会话目录和文件路径；当前文档是只读快照，结果通过编辑器写回，不直接改 vault。
- 附件会随对话发送给 Agent 背后的模型服务（Claude Code 等），请只添加你愿意发送的内容。

## 增加新 provider

实现 `providers/<id>.ts` 的 `AgentProvider` / `AgentSession`，在 `providers/index.ts` 注册，并在 `package.json` 增加该 provider 的命令/模型配置。核心、webview、会话、附件与写回逻辑都不需要改。
