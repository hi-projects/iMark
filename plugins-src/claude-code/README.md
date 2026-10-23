# Claude Code

Agent Core 的 Claude Code 后端扩展。

- 依赖 `imark.agent`（Agent Core）。扩展宿主会把两者放进同一个宿主进程，Core 先激活。
- 通过 `contributes["imark.agentProviders"]: ["claude-code"]` 声明自己提供的 provider。
- `activate()` 返回 `{ apiVersion: 1, providers: [...] }`；Core 从 `extensions.getExtension("imark.claude-code").exports` 读取。
- 设置页的「检查 Claude Code」调用本扩展自己的 `detect()`，结果写在本扩展的状态卡里；Core 不参与探测。
- 平时由 Core 在需要 provider 时惰性激活；设置页动作声明了 `onCommand:imark.claude-code.check`，点按钮时会先激活本扩展。

## 配置

CLI 的端点、令牌、模型等配置**唯一的事实是 Claude Code 自己的 settings.json**：

```
~/.claude/settings.json
```

（设置了 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/settings.json`。）

设置页「Claude Code（settings.json）」里的字段直接读写这个文件，不经过应用的配置存储，
未知字段与其它顶层键原样保留。覆盖的键：

| settings.json 键 | 设置页字段 |
| --- | --- |
| `env.ANTHROPIC_BASE_URL` | API 端点 |
| `env.ANTHROPIC_AUTH_TOKEN` | 认证令牌（Bearer，DeepSeek 等兼容端点用） |
| `env.ANTHROPIC_API_KEY` | API 密钥（x-api-key；与 AUTH_TOKEN 同时存在时以 AUTH_TOKEN 为准） |
| `env.ANTHROPIC_MODEL` | 默认模型；对话面板只读显示这个值，不提供模型选择 |
| `env.ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | Claude Code 使用 Opus/Sonnet/Haiku 别名时的映射 |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | 子代理模型 |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | 推理强度 |

清空字段会从 `env` 里删除对应键。模型与 API 密钥只保存在 settings.json，应用配置里不另存副本。

「Claude Code」与「扩展调用」里的设置只控制怎么启动 CLI：

| 键 | 说明 |
| --- | --- |
| `imark.claude-code.commandMode` | 自动检测 / 手动指定；自动检测依次查找 PATH、`~/.local/bin` 与编辑器扩展自带的 claude |
| `imark.claude-code.command` | 手动指定时的 CLI 完整路径；自动检测模式下忽略，留空会回退到自动检测 |
| `imark.claude-code.timeoutSec` | 单轮超时 |
| `imark.claude-code.maxTurns` | 单轮最大 assistant 轮数 |
| `imark.claude-code.extraArgs` | 字符串列表，一项一个追加参数；设置页用「+」逐条添加；会拒绝改变协议、配置或会话归属的参数 |

自动检测会依次尝试：PATH 上的 `claude` / `claude.exe` / `claude.cmd`、`~/.local/bin`，
以及编辑器扩展目录里 `anthropic.claude-code-*` 自带的 `resources/native-binary/claude`
（覆盖 VS Code、VS Code Insiders、VS Code Server、VSCodium、Cursor、Windsurf 及其远程版本；
存在多个版本时取最新的）。

每次 `createSession()` 都会重新读取这些调用参数，所以修改后下一轮生效；settings.json 由 CLI 每次启动时读取。

## 运行方式

每次发送启动一个 `claude -p --verbose --output-format stream-json --include-partial-messages`
子进程；首轮用 `--session-id`，后续用 `--resume` 续接。扩展不传任何权限或工具
参数，工具是否可用完全由 Claude Code 自己的 settings.json 决定。扩展只把附件
路径交给 Claude Code，由它自行读取和解析。

## 测试

`verify/agent-harness.ts` 用 `verify/fixtures/fake-claude.js` 模拟 CLI，覆盖参数、
流式事件、续接与错误码。
