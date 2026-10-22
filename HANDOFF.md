# Agent Core / Claude Code 拆分：交接与继续执行

> 2026-10-22。当前工作树**未提交**。换机器请先看「0. 回家后第一件事」和「7. 如何把代码带回家」。

## 0. 回家后第一件事

当前源码停在：`plugins-src/claude-code/provider.ts` 刚把 `import type * as imark` 改成
`import * as imark`（为了运行时创建输出通道），**尚未重新构建 / typecheck**。
所以先跑这三条，不要直接跑验收：

```bash
cd ~/workspace/iMark-main
env -u ELECTRON_RUN_AS_NODE npm run plugins:build
env -u ELECTRON_RUN_AS_NODE npm run typecheck
env -u ELECTRON_RUN_AS_NODE npm run build
```

然后至少重跑 Agent 验收（provider 改过）：

```bash
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs agent
```

Linux 有桌面/不需要无头时可去掉 `xvfb-run -a`。`env -u ELECTRON_RUN_AS_NODE` 只在这台
开发机的 shell 默认设置它时需要；别的机器没有这个变量也无害。

接着跑「6. 尚未跑完的验收」里的 18 个。全部通过后，再做「8. 手工冒烟」。

## 1. 这次改了什么

把原来的 Agent 插件拆成两个官方扩展：

```
Agent Core (imark.agent)                 Claude Code (imark.claude-code)
  ├─ 对话 / 会话 / 附件 / 产物             ├─ extensionDependencies: ["imark.agent"]
  ├─ 权限模式 / 写回文档                   ├─ contributes["imark.agentProviders"]: ["claude-code"]
  ├─ ProviderRegistry（惰性扫描同宿主）     ├─ 自己的配置 imark.claude-code.*
  └─ 不含任何 Claude CLI 代码               └─ 自己的 secret: apiKey
```

- Core 扩展 ID **保留 `imark.agent`**，只改 `displayName` 为 **Agent Core**。命令、设置键、
  会话目录、菜单 ID 都不变。
- 新 provider 扩展 ID 是 `imark.claude-code`，`displayName` 为 **Claude Code**。
- 两者都随应用内置、**默认关闭**。
- 旧 `imark.agent.claudeCode.*` 设置与 secret **不迁移、不再读取**。
- provider 不需要 `activationEvents`；Core 第一次列后端时才 `activate()` 它。
- Core 与 provider 必须同宿主（`extensionDependencies` 保证），provider 从
  `activate()` 返回 `{ apiVersion: 1, providers }`，Core 通过
  `imark.extensions.getExtension(id).exports` 读取。`exports` 是进程内对象，跨宿主不可见。

## 2. 环境

本次开发机实测：

- Linux aarch64（NVIDIA Tegra），Node `v24.21.0`，npm `11.19.0`。
- 无头跑验收需要 `xvfb-run`（`xvfb-run -a node verify/run.mjs <名字>`）。
- 干净安装：`npm ci`。仓库自带 `package-lock.json`。
- 这台机器的 npm 镜像拉 Electron 大包可能卡住；当时是 `curl` 续传后注入 npm cache 解决的。
  换机器若 `npm ci` 卡在 electron 下载，先检查镜像/代理，不要反复重装。

## 3. 新增 / 删除 / 修改的文件（本次拆分相关）

新增：

| 文件 | 职责 |
|---|---|
| `src/shared/agentProvider.ts` | Core ↔ provider 的唯一契约：类型、`AGENT_PROVIDER_API_VERSION=1`、ID 常量 |
| `plugins-src/agent/core/providers.ts` | `ProviderRegistry`：惰性扫描、依赖校验、激活、exports 校验、错误聚合 |
| `plugins-src/claude-code/package.json` | Claude Code 清单、依赖、配置、provider 贡献 |
| `plugins-src/claude-code/main.ts` | `activate()` 返回 `{ apiVersion, providers }` |
| `plugins-src/claude-code/provider.ts` | `ClaudeCodeProvider` / `ClaudeSession` |
| `plugins-src/claude-code/config.ts` | 读 `imark.claude-code.*` 与 secret `apiKey` |
| `plugins-src/claude-code/claudeArgs.ts` | CLI 参数拼装 |
| `plugins-src/claude-code/claudeStream.ts` | stream-json 解析、错误分类 |
| `plugins-src/claude-code/spawn.ts` | CLI 探测与子进程管理 |
| `plugins-src/claude-code/README.md` | 插件说明 |
| `src/main/market/builtin/imark.claude-code.imkpkg.json` | `plugins:build` 生成的内置包（已纳入工作树） |

删除：`plugins-src/agent/providers/`（`claude-code.ts`、`claudeArgs.ts`、`claudeStream.ts`、
`spawn.ts`、`index.ts`）——全部搬进 `plugins-src/claude-code/`。

修改：

- 契约与校验：`src/shared/extensionFormat.json`、`src/shared/extensionPackage.ts`、
  `server/src/validate.mjs`（服务端 canonical/校验必须与客户端同步）。
- 平台能力：`src/main/extensions/hostRuntime.ts`（`activate()` 返回值写入
  `Extension.exports`，每次激活先清空）。
- 依赖生命周期：`src/main/extensions/installer.ts`（依赖未安装拒绝安装）、
  `src/main/extensions/service.ts`（被依赖时拒绝卸载/禁用；启用时递归启用依赖）。
- 内置包：`src/main/market/bundled.ts`（五款，Core 在 Claude 前，
  两者 `enable: false`）、`src/main/index.ts`（注释改五款）。
- Agent Core：`plugins-src/agent/package.json`、`plugins-src/agent/main.ts`、
  `core/config.ts`、`core/protocol.ts`、`core/types.ts`、`webview/chat.ts`、
  `plugins-src/agent/README.md`。
- 构建：`plugins-src/tsconfig.json`（加入 `claude-code/**/*.ts`）、
  `scripts/build-plugins.mjs`（esbuild 显式 `@shared` alias）。
- 文档：`README.md`（五款官方扩展、provider 契约、默认策略）。
- 验收：`verify/agent-harness.ts`、`extensions-host-groups-harness.ts`、
  `bundled-upgrade-harness.ts`、`market-ui-harness.ts`、
  `install-confirm-harness.ts`、`market-package-harness.ts`。

## 4. 核心不变量（改代码前先读）

1. **方向固定**：provider → Core，不允许 Core 在清单里反向依赖 provider。
2. **同宿主**：`extensionDependencies` 同时负责依赖顺序与宿主合并；`exports` 不能跨宿主。
3. **无死锁**：Core 的 `activate()` 绝不能 `await providers.list()`。注册表有
   `ready` 门闩，入口在 `host.start().finally()` 里调 `markProvidersReady()`。
4. **provider 自带配置**：Core 只传通用会话参数（`hostSessionId`、`cwd`、`mode`、
   `model`、`availableCommands`、`signal`）。超时/隔离/额外参数/API key 由 provider 自己读。
5. **每轮重读**：Core 每轮（含重试）都调用 `createSession()`，所以 provider 设置下一轮生效。
6. **协议版本**：`apiVersion` 不等于 1 的导出对象只产生诊断，不注册。
7. **清单校验双端一致**：`imark.agentProviders` 必须非空、≤8、id 匹配
   `/^[a-z][a-z0-9-]{0,63}$/`、不重复、有 `main`、并依赖 `imark.agent`。
8. **依赖保护**：依赖未安装 → 安装失败；被已安装扩展依赖 → 拒绝卸载；
   被已启用扩展依赖 → 拒绝禁用；启用时递归启用依赖链。

## 5. 生成包应满足

```bash
node -e '
const fs=require("fs");
for (const id of ["imark.agent","imark.claude-code"]) {
  const m=JSON.parse(fs.readFileSync(`src/main/market/builtin/${id}.imkpkg.json`,"utf8")).manifest;
  console.log(id, m.version, m.displayName, "deps=", m.extensionDependencies,
    "providers=", m.contributes?.["imark.agentProviders"],
    "config=", Object.keys(m.contributes?.configuration?.properties||{}));
}'
```

预期：

- `imark.agent`：`1.0.0` / `Agent Core` / 无 deps / 无 `imark.agentProviders` /
  配置只有 `imark.agent.mode`、`imark.agent.attachmentMaxMB`。
- `imark.claude-code`：`1.0.0` / `Claude Code` / `["imark.agent"]` /
  `["claude-code"]` / 配置全部以 `imark.claude-code.` 开头。

服务端规则同步自检（发布前必跑）：

```bash
node --input-type=module -e '
import fs from "node:fs";
import { validateEnvelope } from "./server/src/validate.mjs";
const raw=JSON.parse(fs.readFileSync("src/main/market/builtin/imark.claude-code.imkpkg.json","utf8"));
console.log(validateEnvelope(raw));
'
```

## 6. 验收状态

已全绿（本次工作树，provider 最后一处日志改动之前）：

| harness | 结果 |
|---|---|
| agent | 78 passed / 0 failed（**最后改动后需重跑**） |
| extensions-host-groups | 34 / 0 |
| extensions-model | 37 / 0 |
| bundled-upgrade | 49 / 0 |
| market-package | 48 / 0 |
| market-ui | 30 / 0 |
| install-confirm | 35 / 0 |
| extensions-editor / extensions-webview / quick-edit / git-sync / git-sync-auth / git-sync-proxy | exit 0 |

**尚未跑完的 18 个**（全量回归在第 9 个 `ai-for-edit` 处被中断）：

```bash
for n in ai-for-edit table-render code-block code-indent font-zoom math-block mermaid \
         editor-enter cursor session-restore tabs image-paste autosave-modes data-dir \
         settings-reflow settings-system notification userstyle-dir; do
  echo "=== $n ==="
  env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs "$n" || break
done
```

之后建议再跑一次全部 31 个（列表固定在 `verify/run.mjs` 的帮助输出里）：

```bash
for n in extensions-model extensions-host-groups extensions-editor extensions-webview \
         quick-edit git-sync git-sync-auth git-sync-proxy ai-for-edit agent \
         market-package market-ui install-confirm bundled-upgrade table-render \
         code-block code-indent font-zoom math-block mermaid editor-enter cursor \
         session-restore tabs image-paste autosave-modes data-dir settings-reflow \
         settings-system notification userstyle-dir; do
  echo "=== $n ==="
  env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs "$n" || break
done
```

注意：

- `verify/run.mjs` 每次清空并复用 `.verify-ud/<名字>`，不会碰真实 `~/.imark`。
- 它只重新打包 harness；`out/main` 必须先用 `npm run build` 生成。
- 改了 `src/preload/**` 或 `src/renderer/**` 后也要先 `npm run build`，否则 harness 跑旧产物。
- Windows/macOS 有显示环境时去掉 `xvfb-run -a`。

## 7. 如何把代码带回家

**整个工作树未提交**（148 个文件改动，其中也包含更早的 v1.0.0 清理）。已在当前机器
生成源码快照（排除 `node_modules` / `out` / `.git` / `.imark` / `.verify-ud`）：

```
/home/byd/workspace/iMark-main-worktree-2026-10-22.tar.gz
```

回家后：

```bash
tar -xzf iMark-main-worktree-2026-10-22.tar.gz -C ~/workspace/iMark-main
cd ~/workspace/iMark-main
npm ci
```

如果两台机器都能访问同一个 git 远端，更稳的方式是由用户自己决定是否提交：

```bash
git add -A
git commit -m "WIP: Agent Core / Claude Code 拆分"
git push -u origin <分支名>
```

**不要替用户提交**，除非用户明确要求。

## 8. 手工冒烟（验收全绿之后）

内置包版本仍是 `1.0.0`，而本地开发数据里可能已经装过同版本的旧 Agent
（`displayName` 还是「Agent」）。补装逻辑只在**版本更高**时升级，所以开发环境要先清插件数据：

```bash
rm -rf .imark/plugins        # 仅开发数据；会触发五款内置包重新补装
env -u ELECTRON_RUN_AS_NODE npm run dev
```

然后在「设置 → 扩展」里确认：

1. 五款内置扩展都出现：quick-edit 默认开，git-sync / ai-for-edit / Agent Core /
   Claude Code 默认关。
2. 先启用 Agent Core：菜单能打开聊天面板，显示「Agent Core」，选择器显示「无可用后端」，
   发送按钮禁用，提示「未安装或未启用任何 Agent 后端插件」。
3. 再启用 Claude Code（会自动带上对 Core 的依赖）：Core 所在宿主重启，聊天面板重开后
   provider 选择器出现 Claude Code。
4. 在 Claude Code 设置里填本机 CLI 路径（留空自动探测），发一轮消息；确认流式文本、
   工具时间线、取消、`--resume` 与结果写回正常。
5. 尝试卸载/禁用 Agent Core：应被拒绝，错误信息点名 Claude Code。

若不想清 `.imark`，可用隔离数据目录启动验证。

## 9. 剩余风险 / 下次优先看

- `plugins-src/claude-code/provider.ts` 最后一处 import 修复尚未 typecheck/构建/跑 harness。
- 全量 31 项回归未跑完；先跑 `agent`，再跑上面 18 个。
- provider 的 `detect()` 缓存 60 秒（key = command + timeoutSec）；改设置后最多等 1 分钟，
  或重载宿主。
- 没有做 provider 管理器 UI、热插拔、跨宿主对象传输、旧配置迁移（有意不做）。
- 发布时 Core/Provider 版本应随应用正常递增；目前都是 `1.0.0`。
