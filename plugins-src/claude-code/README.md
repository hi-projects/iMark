# Claude Code

Agent Core 的 Claude Code 后端插件。

- 依赖 `imark.agent`（Agent Core）。扩展宿主会把两者放进同一个宿主进程，Core 先激活。
- 通过 `contributes["imark.agentProviders"]: ["claude-code"]` 声明自己提供的 provider。
- `activate()` 返回 `{ apiVersion: 1, providers: [...] }`；Core 从 `extensions.getExtension("imark.claude-code").exports` 读取。
- 不声明 `activationEvents`，由 Core 在需要 provider 时惰性激活。

## 配置

| 键 | 说明 |
| --- | --- |
| `imark.claude-code.command` | CLI 路径；留空自动探测 PATH、`~/.local/bin` 与 VS Code 扩展内的 native binary |
| `imark.claude-code.model` | 默认模型；对话面板的模型输入框可覆盖 |
| `imark.claude-code.isolation` | safe / restricted / off，控制 CLAUDE.md、技能与 hooks 等自定义 |
| `imark.claude-code.timeoutSec` | 单轮超时 |
| `imark.claude-code.maxTurns` | 单轮最大 assistant 轮数 |
| `imark.claude-code.extraArgs` | 每行一个追加参数；会拒绝改变协议/权限/会话的参数 |
| `imark.claude-code.apiKey` | 可选 API 密钥，存于本扩展的 secret 槽位，只通过子进程环境变量注入 |

每次 `createSession()` 都会重新读取这些设置，所以修改后下一轮生效。

## 运行方式

每次发送启动一个 `claude -p --verbose --output-format stream-json --include-partial-messages`
子进程；首轮用 `--session-id`，后续用 `--resume` 续接。只读模式会限制工具；
read+parse 允许在会话目录内使用 Write 与白名单命令。插件只把附件路径交给
Claude Code，由它自行读取和解析。

## 测试

`verify/agent-harness.ts` 用 `verify/fixtures/fake-claude.js` 模拟 CLI，覆盖参数、
流式事件、续接、工具白名单与错误码。
