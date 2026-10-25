# 插件（扩展）系统架构

本文描述 iMark 的扩展模型：包格式、安装流程、宿主拓扑、运行时协议、贡献点、webview 与市场。
扩展作者的使用说明见 [插件开发文档](plugin-development.md)。

> 术语：界面与文档中的“插件”与“扩展”是同一概念。代码统一用 `Extension` / `extension`；
> 源码目录是 `plugins-src/`，安装后的数据目录是 `plugins/`。

## 1. 设计原则

1. **VS Code 式模型**：扩展清单是扩展目录根部的 `package.json`，入口是可选的 CommonJS
   `main.js`，通过 `require('imark')` 使用宿主注入的 API。
2. **主进程永不加载扩展代码**：扩展只在 `utilityProcess` 宿主中执行；主进程只做管理、路由与
   校验。
3. **磁盘是权威**：`plugins/<id>/package.json` 存在且合法就算已安装；`installed.json` 只记录
   来源与完整性信息，不是安装事实。
4. **清单是契约**：未知字段、非法路径、非法贡献点直接拒绝；安装到磁盘的清单必须与校验过的
   对象逐字节一致。
5. **信任模型**：扩展代码以当前用户权限运行，**没有权限沙箱**。`capabilities` 是安装披露，
   不是运行时门禁；确认框只保证用户知情。

## 2. 包格式

### 2.1 信封

一个扩展包是单文件 JSON（`.imkpkg.json`）：

```json
{
  "format": "imk-plugin",
  "formatVersion": 1,
  "manifest": { "...": "package.json 去掉构建字段后的清单" },
  "files": {
    "main.js": { "encoding": "base64", "size": 1234, "sha256": "…" }
  },
  "data": {
    "main.js": "ZXhwb3J0cy5hY3RpdmF0ZSA9ICgpID0+IHt9"
  },
  "integrity": "…"
}
```

- `manifest` 是唯一清单；`package.json` 本身**不作为包内文件**，安装时由宿主写回磁盘。
- `files` 记录每个文件的 size 与 sha256；`data` 存 base64 内容。
- `integrity = sha256(stableStringify({ manifest, files: { name: sha256 } }))`。
  `stableStringify` 递归排序对象键，因此打包器、服务端、客户端只要对象内容相同就得到同一个值。
- 格式常量、键序、白名单与体积上限集中在
  [src/shared/extensionFormat.json](../src/shared/extensionFormat.json)，应用、构建脚本与市场
  服务端共用同一份数据。

### 2.2 清单字段

必填：`publisher`、`name`、`version`、`engines.imark`。
常用可选：`displayName`、`description`、`author`、`license`、`homepage`、`repository`、
`bugs`、`main`、`icon`、`activationEvents`、`extensionDependencies`、`extensionAffinity`、
`capabilities`、`contributes`、`categories`、`keywords`。

- 扩展 ID = `<publisher>.<name>`，两段都匹配 `^[a-z0-9][a-z0-9-]{1,63}$`。
- `main` 必须是包内 `.js` / `.cjs`；不填 = 纯声明式扩展。
- `homepage` 必须是 https。
- `activationEvents` 支持 `*`、`onStartupFinished`、`onLanguage:markdown`、
  `onCommand:<命令>`、`onWebviewPanel:<viewType>`；未知事件只警告。
- `contributes` 支持的键：`commands`、`keybindings`、`menus`、`configuration`、
  `imark.lineMenu`、`imark.actions`、`imark.agentProviders`。
- `engines.imark` 是版本范围（`^1.0.0` / `>=1.0.0` / `>1.0.0`），安装时校验。
- 未知顶层字段直接报错，不静默丢弃。

### 2.3 体积与路径限制

| 项 | 上限 |
|---|---|
| 整包信封 | 16 MiB |
| 单文件 / 入口 | 8 MiB |
| README | 512 KiB |
| 图标 | 128 KiB |
| 文件数 | 96 |
| 路径长度 / 深度 | 180 字符 / 4 段 |
| 命令 / 快捷键 / 配置项 | 50 / 50 / 80 |
| 行首菜单 / 动作 / 菜单项 | 12 / 20 / 20 |
| Agent provider | 8 |

包内路径必须是相对 POSIX 路径，不含 `..`、不以 `/` 开头、不含反斜杠或 NUL；扩展名必须在白名单
内；任何路径段都不能是保留段 `__imark`。

### 2.4 校验链

安装与“查看源码”共用同一条校验链（[src/main/extensions/installer.ts](../src/main/extensions/installer.ts)）：

1. `validateEnvelope()`：结构、清单、路径、扩展名、体积、文件数、`files` / `data` 一致性、
   `main` 与 `icon` 确实在包内。
2. 逐文件：base64 解码后比对声明的 `size` 与 `sha256`。
3. 整包：重算 integrity，并与包内声明、市场响应头 `X-Imk-Integrity`（如果有）比对。
4. `engines.imark` 与应用版本比对。
5. `extensionDependencies` 必须已安装（直接读磁盘清单，手动拷入的扩展也算）。

任何一步失败都不会落盘。

## 3. 安装、启用与卸载

### 3.1 安装

入口有三类：市场下载、本地文件、本地目录打包；内置包也走同一条路径。

1. 主进程读包并**预览**（`previewEnvelope`）：清单、形态、体积、整包 sha256、入口 sha256、
   能力、贡献摘要、是否降级。
2. 预览结果放进一次性令牌表（5 分钟过期），渲染层只拿到令牌；用户确认后回传令牌，主进程
   取回**同一份已校验字节**安装。渲染层从头到尾没碰过字节，也不能指定路径。
3. `installExtensionPackage()` 把文件解到 `plugins/.staging/<id>.<stamp>/`，再校验一次入口哈希，
   写入 `package.json`，然后把旧目录 rename 成 `<id>.old-*`、暂存目录 rename 成就位目录，最后
   删除旧目录并写 `installed.json`。失败时回滚并清理暂存。
4. `reloadEntries()` 重新扫描磁盘、重新规划宿主，贡献点立即刷新。

### 3.2 启用与依赖

- 启用态与配置在 `settings.extensions.<id>`，默认 `{ enabled: true, config: {} }`。
- 启用一个扩展时，它的整条 `extensionDependencies` 链会被一并启用；缺失依赖直接拒绝。
- 禁用/卸载被其它已启用扩展依赖的扩展会被拒绝，并列出依赖方。
- 卸载会删除程序文件、`installed.json` 记录、`<id>:` 前缀的密钥、`extensions-data/<id>/`
  （globalState / storage）、日志、设置里的启用态与配置，并移除它的 webview 面板。

### 3.3 磁盘布局

```text
<数据根>/
├── plugins/
│   ├── <publisher>.<name>/      扩展目录（package.json + main.js + webview/**）
│   ├── installed.json           登记表：来源、版本、integrity、安装时间
│   ├── .staging/                安装暂存（随机后缀）
│   └── <id>.old-*/              升级时短暂保留的旧目录
├── extensions-data/
│   ├── <id>/state.json          globalState / workspaceState
│   ├── <id>/                    globalStorageUri / storageUri
│   └── webviews.json            待恢复的 webview 面板元数据
└── logs/extensions/<id>.log     扩展日志（扩展 log + 宿主审计/操作摘要）
```

`installed.json` 版本不匹配时按空表处理；目录扫描会把磁盘上仍然有效的扩展重新登记为
`source: local`。

## 4. 宿主拓扑

### 4.1 分组规划

见 [src/main/extensions/hostPlanner.ts](../src/main/extensions/hostPlanner.ts)。分组是纯函数：

```text
候选 = 已启用 && 有 main 的扩展
key =
  用户 affinity 正整数     → affinity:<n>
  mode = shared            → mode:shared
  mode = isolated          → extension:<id>
强制合并：
  extensionDependencies 双方
  清单里的 extensionAffinity
组内按依赖拓扑排序（环按字典序兜底）
```

`settings.extensionHost = { mode: 'shared' | 'isolated', affinity: Record<id, number> }`，
默认 `shared`。设置变化时只重启受影响的宿主（`changedHostIds`）。

纯声明式扩展（没有 `main`）不需要宿主进程。

### 4.2 宿主进程

`ExtensionHostProcess`（[hostProcess.ts](../src/main/extensions/hostProcess.ts)）用
`utilityProcess.fork()` 启动 `out/main/extensionHostProcess.js`，参数里带 hostId：

- 两阶段就绪：`process`（进程起来）→ `initialized`（收到 init 并建好运行时）。
- 主进程 → 宿主：`init`、`activate`、`deactivate`、配置/密钥/文档/主题/工作区变更，以及
  `shutdown`。
- 宿主 → 主进程：`ready`、`activated`、`deactivated`、`request`、`response`、`log`、`status`、
  `output`、`decoration`、`webview.*` 等。
- stdout/stderr 按行转成扩展日志；`console.*` 在宿主内被接管，带上扩展归属。

### 4.3 崩溃与重启

宿主意外退出时：

- 同宿主内所有扩展标记为 `crashed`，运行时注册（命令、状态栏、webview）清空。
- 按 1s / 2s / 4s 退避重启；60 秒内第三次崩溃进入 `crash-loop`，停止自动重启。
- 重启成功后只重新激活此前“应该活着”的扩展（`wantActive`）。
- 设置页可手动“重新加载扩展”或“重新加载宿主”，会重置失败计数。

单个扩展激活连续失败 3 次也会停止自动重试，避免无限拉起。

## 5. 宿主运行时与协议

### 5.1 `require('imark')` 注入

[hostRuntime.ts](../src/main/extensions/hostRuntime.ts) 在宿主进程里 patch 了
`Module._load`：

- `require('imark')` 返回一个**按调用方扩展归属**构造的 API 对象。
- 归属按 `parent.filename` 是否位于扩展根目录判断；shared 宿主里也能分清是谁在调用。
- 同一扩展多次 `require` 拿到同一个 API 对象。

### 5.2 协议约束

[src/shared/extensionProtocol.ts](../src/shared/extensionProtocol.ts) 的线协议有三条硬规则：

1. 只传可结构化克隆的值（不传函数、Electron 对象、Buffer、类实例）。
2. 密钥只出现在 main ↔ 宿主方向；renderer 与 webview 的 DTO 里没有密钥字段。
3. 文档以 renderer 为准：宿主收到增量与版本号；编辑请求带 `expectedVersion`，版本不连续时
   由 renderer 拒绝，宿主等待下一次全量同步。

所有请求带 `requestId`，响应统一是 `{ kind: 'response' }`。

### 5.3 文档镜像与编辑器桥

- 渲染层每次事务递增版本号，把变更（或全量文本）经 `editor:to-main` 发给主进程；
  主进程 `DocumentRegistry` 维护镜像并广播给宿主。
- `TextEditor.edit()` 在宿主内收集编辑，排序并拒绝重叠，然后经主进程转到渲染层
  `applyEdits`；版本不匹配时返回 `ok: false`，扩展的 `edit()` 得到 `false`。
- `window.activeTextEditor` / `visibleTextEditors` 来自渲染层的可见标签集合。
- 装饰（`createTextEditorDecorationType` + `setDecorations`）以 DTO 形式下发，渲染层再校验
  允许的 CSS 属性后应用。
- `imark.flushActiveDocument()` 请求主进程让渲染层把当前文档写盘，返回是否成功。

### 5.4 配置、密钥与状态

- **配置**：`workspace.getConfiguration(section)` 读的是宿主 init 时下发的生效配置。
  生效值 = 清单默认值 ← 全局值 ← 当前仓库覆盖值，并按字段类型归一化。
  `update()` 只能改自己 ID 前缀下的键；写入后主进程广播 `configuration.changed`。
- **密钥**：`context.secrets` 经主进程 `safeStorage` 存取；扩展只能读自己的键
  （主进程在键前拼 `<id>:`）。明文不出主进程与宿主。
- **状态**：`globalState` / `workspaceState` 由主进程按扩展 100ms 防抖写盘；
  `globalStorageUri` / `storageUri` 是扩展私有目录；`logUri` / `logPath` 是日志文件。
- **输出**：`window.createOutputChannel(name)` 写入扩展日志；设置页可直接打开日志。

## 6. 贡献点与界面投影

`buildContributions()`（[contributions.ts](../src/main/extensions/contributions.ts)）把“已启用且
未加载失败”的扩展清单 + 运行时注册表合成一份快照，命令面板、原生菜单、状态栏、行首菜单、
设置页动作都读同一份：

| 贡献点 | 产物 |
|---|---|
| `commands` | 命令面板项；原生菜单“扩展”栏 |
| `keybindings` | 菜单加速键；与应用快捷键/其它扩展冲突时标 `dropped` |
| `menus.commandPalette` | 命令面板可见性与 `when` 条件 |
| `configuration` | 设置页表单（`settingsFieldsOf()` 翻译成字段描述） |
| `imark.lineMenu` | 行首“+”菜单条目与一次性参数对话框 |
| `imark.actions` | 设置页动作按钮（可按目标逐行执行） |
| `imark.agentProviders` | Agent Core 的后端清单 |

`when` 子句由 [src/shared/whenClause.ts](../src/shared/whenClause.ts) 解析；支持
`&&`、`||`、`!`、括号、`==`、`!=` 与字面量，不支持 `=~`、`in` 与数组。

原生菜单在窗口创建前就构建；贡献点变化会重建菜单。重复快捷键按“应用 > 先注册的扩展”顺序
保留，被摘掉的快捷键仍可从命令面板执行。

## 7. webview

### 7.1 生命周期

1. 扩展调用 `window.createWebviewPanel(viewType, title, showOptions, options)`。
2. 宿主同步生成 `panelId` 与随机 token，主进程登记到 `WebviewRegistry`，渲染层收到
   `webview.create` 并挂一个 sandbox iframe。
3. iframe 的 URL 是 `imark-webview://<extensionId>/__imark_panel__/index.html?token=…&rev=…`。
4. 扩展设置 `webview.html` 后，渲染层重载 iframe；页面通过 `postMessage` 与宿主通信。
5. 面板元数据（不含 HTML）持久化到 `extensions-data/webviews.json`；启动时扩展的序列化器
   `deserializeWebviewPanel()` 重新生成 HTML。

### 7.2 隔离与校验

- 每个扩展一个稳定 origin `imark-webview://<extensionId>`；iframe 是
  `sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"`。
- 资源请求校验四道门：privileged scheme、token 查表、扩展归属（hostname）、
  `localResourceRoots` 路径范围。
- `webview.asWebviewUri()` 把包内文件变成带 token 的协议 URL；`webview.cspSource` 用于拼 CSP。
- 主题变量与 bootstrap 只能用 `postMessage` 送进去，渲染层不碰 iframe DOM。
- `presentation` 支持 `sidebar` / `overlay` / `floating`；运行时可用
  `panel.imark.setPresentation/setSize/setPosition/setStatus` 调整。

## 8. 内置官方扩展

`src/main/market/bundled.ts` 在启动时补装四款官方扩展（包由 `npm run plugins:build` 生成）：

| 扩展 | 默认 | 说明 |
|---|---|---|
| `imark.quick-edit` | 启用 | 行首“+”菜单插入表格 |
| `imark.git-sync` | 关闭 | 定时 commit + push 到多个 Git 远端 |
| `imark.agent` | 关闭 | Agent Core：会话、附件、提示词、provider 注册表 |
| `imark.claude-code` | 关闭 | Claude Code 后端，依赖 Agent Core |

策略：

- 开发阶段版本统一固定为 `1.0.0`，内容变化按**整包 integrity** 判断；不一致就整包覆盖。
- 同 ID 的本地/市场安装也会被内置包覆盖，避免旧副本遮住随应用发布的新代码。
- 内置包走与市场下载完全相同的校验与安装路径，没有任何“内置所以跳过校验”的近道。
- 默认启用策略写在宿主（`enable` 字段），不写进包。

## 9. 扩展市场

### 9.1 服务端

`server/` 是零依赖 Node ESM 服务，默认 `127.0.0.1:8787`：

- 存储：`server/data/` 下的 JSON + 按 sha256 去重的 blob；原子写 + 同文件串行。
- 账号：注册/登录、长期发布令牌（服务端只存 sha256）。
- 包：发布、搜索、详情、按精确版本下载、下架/恢复、图标、源码预览所需的 README。
- 已发布版本不可变：同 `(id, version)` 重发返回 409；下架不删除。
- 发布时服务端**重算**逐文件 sha256 与整包 integrity，不符返回 400。

### 9.2 客户端

- 地址保存在 `settings.marketUrl`；开发者令牌保存在 `secrets.json`，按注册表地址分开存储，
  渲染层只知道“登录成谁”，拿不到明文令牌。
- 所有网络请求在主进程用 Electron `net.fetch` 发出（走系统代理与证书存储）；渲染层 CSP
  不允许外部连接。
- 更新检查只在启动后、打开市场页、手动刷新时跑；结果缓存 10 分钟，失败静默，不轮询。
- 安装预览与确认框展示：来源、发布者、形态、文件数/体积、整包 sha256、入口 sha256、
  激活事件、能力声明、贡献摘要；含代码扩展必须勾选风险确认。

## 10. Agent provider 子系统

Agent Core 自身不认识任何具体后端。后端是独立扩展：

```json
{
  "main": "./main.js",
  "extensionDependencies": ["imark.agent"],
  "contributes": { "imark.agentProviders": ["my-backend"] }
}
```

```ts
export function activate() {
  return {
    apiVersion: 2,
    providers: [provider]
  }
}
```

- `extensionDependencies` 保证 Core 先激活且两者在同一宿主；`exports` 是进程内对象，
  跨宿主读不到。
- Core 的 `ProviderRegistry` 惰性求值：Core 的 `activate()` 不等 provider，激活结束后
  `markReady()`；首次列后端时才 `activate()` provider。
- 协议版本严格匹配：`apiVersion !== 2` 只产生诊断，不注册。
- provider 自己读取配置、密钥、CLI 探测；Core 只传 `hostSessionId`、`providerSessionId`、
  `cwd` 与取消信号。
- 事件流 `AgentEvent`：`session`、`text`、`thinking`、`tool`、`status`、`notice`、
  `permission`、`result`、`error`。
- 权限：provider 发 `permission` 事件，Core 面板收集后调用
  `respondPermission(requestId, 'allow' | 'deny')`；回合结束时静默忽略。
- 会话按仓库隔离（`workspace` 字段），附件按内容 sha256 存共享 blob，会话内用硬链接。

完整契约见 [src/shared/agentProvider.ts](../src/shared/agentProvider.ts)，参考实现见
[plugins-src/claude-code/](../plugins-src/claude-code/)。

## 11. 关键文件

| 文件 | 职责 |
|---|---|
| `shared/extensionPackage.ts` | 清单/信封校验、canonical manifest、integrity、配置字段翻译 |
| `shared/extensionProtocol.ts` | main ↔ 宿主 ↔ renderer 的 DTO |
| `shared/extensionApi.ts` | 扩展作者看到的 `imark` 模块 |
| `shared/agentProvider.ts` | Agent Core ↔ provider 契约 |
| `main/extensions/service.ts` | `ExtensionService` 总装 |
| `main/extensions/installer.ts` | 包校验与原子安装 |
| `main/extensions/installedStore.ts` | 登记表与目录扫描 |
| `main/extensions/hostPlanner.ts` / `hostProcess.ts` | 宿主分组与进程 |
| `main/extensions/hostRuntime.ts` | `require('imark')`、API 实现、文档镜像 |
| `main/extensions/contributions.ts` | 贡献点快照 |
| `main/extensions/webviews.ts` / `webviewResources.ts` | 面板登记与 `imark-webview://` 资源 |
| `main/market/*` | 市场客户端、安装预览、内置包补装 |
| `server/src/*` | 自托管市场 |
