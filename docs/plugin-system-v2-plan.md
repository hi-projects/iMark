# iMark 插件系统改造：完整的 VS Code 扩展模型

## Context

iMark 现在的插件模型是自研的三层结构：

- `main.mode: 'node'` —— 主进程 CommonJS，完整 Node 权限；
- `main.mode: 'restricted'` —— 隐藏沙箱页 + `window.imark` + IPC 权限门；
- `render` —— 直接注入主渲染进程的普通脚本，同 realm，拿得到 CM6 与 DOM；
- 无代码 `capability` —— 绑定宿主内置能力。

这套模型能跑，但它和 VS Code 的扩展模型不是一回事：没有 `package.json` 清单、没有
`contributes` / `activationEvents`、没有按需激活、没有 `activate(context)` / `deactivate()`、
没有可注入的 `imark` 模块、没有 webview，插件也不能自由使用 Node 生态。用户明确要求
**按 VS Code 的模型重做，不做任何向后兼容**；只迁移三款官方内置插件，删除
`note-embed` / `todo-marks`（来源不明的示例插件）。

目标结果：第三方作者按 VS Code 的习惯写 `package.json` + `import * as imark from 'imark'`，
应用按激活事件懒加载扩展，**扩展跑在可分组隔离的 utility process 里**（默认每个扩展一个，
也支持共享宿主 + affinity 分组）并拥有完整 Node 能力，通过 `contributes` 把命令、快捷键、
设置、行首菜单、状态栏和 webview 接入 iMark 界面。

### 已确认的产品决策

1. 只迁移 `ai-for-edit`、`git-sync`、`quick-edit` 三款官方插件。
2. 彻底删除 `note-embed`、`todo-marks`（源码、内置包、文档、相关验收）。
3. 完整 VS Code 模型，不保留 v1 包格式、`window.imark`、render 层、restricted 层、
   `capability` 的兼容路径。
4. **不保留任何旧版本数据**：不迁移旧配置/密钥/安装记录；启动时清理旧插件目录、旧
   `installed.json` 与旧 settings 键，三款官方插件按全新安装处理。
5. 扩展代码按 VS Code 信任模型运行：**以当前用户权限执行，不做权限沙箱**。安装确认框
   必须把这一点写清楚。webview 仍然是与宿主隔离的沙箱页面。
6. **两套拓扑都实现，但只有一套宿主运行时**：`extensionHost.mode` 选 `isolated`
   （默认，每个扩展一个 utility process）或 `shared`（所有扩展共用一个宿主），
   `extensionHost.affinity` 按 VS Code 的 affinity 模型把指定扩展分到同一/独立宿主。
   group size = 1 就是“每插件一进程”，group size = N 就是“共享宿主”。不用
   `worker_threads`：线程共享进程，原生崩溃或 `process.abort()` 会带走整个 Electron
   主进程；`utilityProcess` 有独立 PID，可以按宿主 kill/重启/限流。

---

## 一、总体架构

```
┌──────────────────────── main (Electron) ────────────────────────┐
│  ExtensionService                                               │
│   ├─ installed registry / install / uninstall / enable          │
│   ├─ settings + safeStorage secrets + state                     │
│   ├─ contributions snapshot ───────────────► renderer           │
│   ├─ HostPlanner: hostMode + affinity + extensionDependencies   │
│   └─ ExtensionHostProcess[group 0]  [group 1] …                 │
│        (utilityProcess.fork，按宿主懒启动，可装 1..N 个扩展)      │
│        │  process.parentPort RPC（每个宿主独立）                  │
│        ▼                                                        │
│  Extension Host × N (Node, full privileges)                     │
│   ├─ 进程内 runtime prelude：按调用方注入 require('imark')       │
│   ├─ 每个扩展：activation events / activate() / deactivate()    │
│   ├─ commands / configuration / secrets / state / output        │
│   ├─ TextDocument 镜像 + TextEditor 代理                         │
│   └─ WebviewPanel 元数据 + HTML                                 │
└─────────────────────────────────────────────────────────────────┘
        │ IPC                         ▲ document/editor RPC
        ▼                             │
┌──────────────────── renderer (sandboxed) ───────────────────────┐
│  editor store / CM6（文档真身）                                  │
│  contributions: 命令面板、状态栏、设置页、行首「+」、快捷键        │
│  WebviewHost: sandbox iframe + imark-webview:// 协议             │
└─────────────────────────────────────────────────────────────────┘
```

**没有唯一的中心 Extension Host。** 宿主数量由分组策略决定：默认每个扩展一个进程，
也可以让多个扩展共用一个进程，或用 affinity 把指定扩展拆出去。每个宿主进程里跑同一份
很小的 runtime prelude（`extensionHostProcess.ts`），负责按调用方注入 `require('imark')`、
RPC 和 activate/deactivate 调用。它不是跨宿主的中心：不加载未分配给它的扩展、不维护
全局扩展表、不代理跨宿主请求。若连这个 prelude 都不要，插件就只能自己实现 IPC 协议，
`import * as imark from 'imark'` 和 VS Code 式 API 也就不存在了。

### VS Code 为什么共用一个 Extension Host

VS Code 的**默认**拓扑是每个窗口一个本地进程宿主（affinity 0），所有扩展都加载在
里面；远程开发时另有远程机器上的宿主，Web 扩展跑在 Worker 里。它这样做不是为了做
插件间隔离，而是为了：

1. **内存与启动成本**：每个 Node/Electron 进程都有 V8、Node 运行时、模块缓存的固定开销。
   一个窗口装几十上百个扩展，如果每个都开进程，常驻内存会不可接受；共用宿主可以摊销
   这份成本，扩展模块也能共享同一份 Node 运行时。
2. **跨扩展调用足够便宜**：`executeCommand`、扩展依赖、共享事件、`vscode` API 的服务
   都在同一进程内，直接函数调用即可；换成每插件一进程，每次跨扩展命令都要序列化、
   IPC、再反序列化。
3. **贡献点天然是全局的**：命令 ID、菜单、状态栏、配置项最终汇入同一张注册表；一个
   进程内的注册表最简单，也最容易保证“先声明/后声明”的顺序。
4. **隔离目标不同**：VS Code 的进程边界主要是 **UI renderer ↔ 扩展代码**，目的是让扩展
   的 Node 代码碰不到 DOM、卡不住界面；扩展之间默认是互相信任的，安装即授权。所以
   它没有动机为每个扩展付一份进程成本。
5. **崩溃可以整体恢复**：VS Code 接受“一个坏扩展拖垮整个 Extension Host”的风险，靠
   Extension Host 崩溃重启、Extension Bisect、禁用扩展来兜底，而不是靠进程隔离。

**VS Code 并不是永远只有一个宿主。** 源码里的 `ExtensionRunningLocationTracker`
（`src/vs/workbench/services/extensions/common/extensionRunningLocationTracker.ts`）
把可执行的扩展分成若干 affinity 组：

- 默认所有扩展的 affinity 都是 0，映射到同一个 `LocalProcessRunningLocation(0)`；
- `extensionDependencies` 会把有依赖关系的扩展并到同一组；
- 清单里的 `extensionAffinity`（proposed API，需 `enabledApiProposals`）把指定扩展
  与另一个扩展同置；
- 用户设置 `extensions.experimental.affinity` 给扩展一个正整数，`1+` 表示独立宿主；
  源码明确忽略 `<= 0` 的值，并且宿主已启动时只记日志要求 reload window；
- 不同 host kind（`LocalProcess` / `LocalWebWorker` / `Remote`）天然是不同宿主。

所以“默认 2 个宿主”不是普遍情况：普通本地窗口默认就是一个 `LocalProcess` 宿主，
再叠加一个 `LocalWebWorker` 宿主或远程宿主才会看到多个。真正要抄的是**分组机制**，
不是某个固定数字。

iMark 采用同一套机制，但默认值不同：**默认 `extensionHost.mode = 'isolated'`（每扩展
一个宿主）**，因为这次改造的目标就是单插件崩溃不影响别人；`'shared'` 与
`extensionHost.affinity` 提供 VS Code 式的共享/分组。两种模式共用同一个宿主运行时，
group size = 1 即“每插件一进程”，group size = N 即共享宿主。清单、`contributes`、
`activationEvents`、`activate(context)`、`imark` API 与 VS Code 同构，插件作者在
两种拓扑下写出的代码逐字相同。代价与收益：每个额外宿主约 30–60MB 常驻内存；共享宿主
省内存、跨扩展调用更快，但 `globalThis`、`process`、事件循环和崩溃半径也共享。

### 为什么不是「一个宿主进程 + 若干插件线程」

- VS Code 要的是 **UI ↔ 扩展代码** 的边界，不是扩展之间的边界。宿主必须在 UI 进程
  之外；一旦另起进程，一个宿主装下所有扩展就是最便宜的做法。再给每个插件分线程，
  等于重新引入它明确不想要的“每插件执行单元”，还要为跨 isolate 的共享状态付 RPC。
- Node 的 worker 不是轻量线程：每个 worker 有独立 V8 isolate、事件循环与模块表，跨
  worker 只能传消息或转移 ArrayBuffer。省下的只是 OS 进程开销，省不掉 isolate 基线、
  编译代码与模块实例；既没有单宿主的共享堆收益，也没有进程的崩溃隔离。
- JS 异常可以只终止 worker，但 native addon 段错误、原生 OOM、原生崩溃会带走整个
  进程；VS Code 允许扩展使用 native 模块，线程挡不住。native addon 在线程里的兼容性
  也比进程差。
- 调试与观测退化：一个宿主一个 debug target，N 个 worker 就是 N 个；进程还能单独
  看 CPU/内存、单独 kill、单独限流。
- 反证：VS Code 桌面端用独立进程，远程端用远程机器上的进程；只有 Web 版在浏览器
  不允许起进程时才用 Web Worker，并且只支持 API 面小得多的 web 扩展。

对 iMark：线程方案要付和进程方案一样的 RPC/API 成本，却拿不到崩溃隔离；若放进
Electron 主进程，worker 崩溃会带走整个应用。所以不做“宿主 + 线程”；「共享宿主」与
「每插件一进程」不是两套运行时，而是同一套宿主运行时的两种分组，本次两套都实现，
默认每插件一进程。

职责边界：

- **renderer** 是打开文档、CM6 视图、选区、撤销栈的唯一真身。
- **main** 是安装记录、配置、密钥、状态、文档注册表、webview 协议与 token 的唯一真身。
- **每个宿主进程**只负责分配给它的扩展：模块、命令处理器、装饰类型、webview HTML
  与文档镜像；同宿主的扩展共享进程，互相信任。
- 三者之间全部走显式 DTO；不传函数、不传 Electron 对象、不把密钥下发给 renderer/webview。

进程模型：

- 未激活的扩展**不占进程**；启用但从未命中的扩展也不占。宿主在一个组内第一个扩展
  激活时才 fork。
- 崩溃以**宿主组**为单位：isolated 模式下一组只有一个扩展，等价于单插件崩溃只重启
  自己；shared 模式下同组扩展一起重启。按 1s/2s/4s 退避，60 秒内三次崩溃后停止自动
  重启该组，设置页提供「重新加载」。其他组完全不受影响。
- 单个扩展 `activate` 抛错只标记该扩展失败，不杀宿主、不影响同组其他扩展。
- 停用/卸载/重载会从宿主卸载该扩展并释放其 disposable；组内没有扩展时 kill 宿主。
  配置、密钥、状态始终由 main 保管，重新激活时重新注入。
- 跨扩展命令、面板消息、状态栏点击都由 main 按扩展 ID 路由，宿主之间不直接通信。
- 共享模式下同组扩展共享 `globalThis`、`process`、事件循环与 `require` 缓存；这是
  用隔离换成本的明确取舍，安装确认与设置页要写清楚。

---

## 二、清单与包格式 v2

### 2.1 `package.json` 清单

每个扩展目录根部的 `package.json` 就是清单。构建时剥掉 `scripts`、`devDependencies`、
`dependencies`、`private` 等运行时无关字段，信封里保存剥好的那份。

```json
{
  "name": "git-sync",
  "publisher": "imark",
  "version": "2.0.0",
  "displayName": "Git 定时同步",
  "description": "按间隔提交并推送当前仓库",
  "engines": { "imark": "^0.1.0" },
  "main": "./main.js",
  "icon": "icon.png",
  "activationEvents": [
    "onStartupFinished",
    "onCommand:imark.git-sync.syncNow",
    "onCommand:imark.git-sync.testAll"
  ],
  "capabilities": { "filesystem": "user", "network": true, "secrets": true, "git": true },
  "contributes": {
    "commands": [
      { "command": "imark.git-sync.syncNow", "title": "立即同步", "category": "Git 同步" }
    ],
    "keybindings": [
      { "command": "imark.git-sync.syncNow", "key": "ctrl+alt+s", "when": "hasVault" }
    ],
    "configuration": {
      "title": "Git 定时同步",
      "properties": {
        "imark.git-sync.targets": {
          "type": "array",
          "default": [],
          "title": "同步目标",
          "imark": { "kind": "targets", "targetSecret": { "label": "访问令牌" }, "section": "仓库" }
        },
        "imark.git-sync.intervalMinutes": {
          "type": "number",
          "default": 30,
          "minimum": 1,
          "maximum": 1440,
          "title": "同步间隔（分钟）",
          "imark": { "section": "计划" }
        }
      }
    },
    "imark.lineMenu": [
      {
        "id": "table",
        "label": "表格",
        "command": "imark.quick-edit.insertTable",
        "dialog": {
          "title": "插入表格",
          "fields": [
            { "key": "rows", "kind": "number", "label": "行数", "default": 3, "min": 1, "max": 50 },
            { "key": "cols", "kind": "number", "label": "列数", "default": 3, "min": 1, "max": 20 }
          ]
        }
      }
    ],
    "imark.actions": [
      { "command": "imark.git-sync.syncNow", "label": "立即同步", "scope": "global", "primary": true },
      {
        "command": "imark.git-sync.testTarget",
        "label": "测试连接",
        "scope": "target",
        "targetSetting": "imark.git-sync.targets"
      }
    ]
  }
}
```

规则：

- 扩展 ID = `${publisher}.${name}`；`publisher` / `name` 都用 `^[a-z0-9][a-z0-9-]{1,63}$`。
  目录名也用 ID，内置包文件名 `<id>.imkpkg.json`。
- `engines.imark` 必填，用现有 `satisfiesRange` 校验。
- `main` 可省略（纯声明式扩展，只贡献命令/设置/菜单，没有处理器）。
- **清单里没有 `execution` / `process` 字段**：执行拓扑由用户设置
  `extensionHost.mode` / `extensionHost.affinity` 决定，不是插件作者的契约。可选的
  `extensionAffinity: string[]` 只是“与这些扩展同置”的提示（对应 VS Code 的 proposed
  API），不能用来强制独立或共享。API 保持拓扑无关 —— 跨扩展调用一律经 main、返回值必须
  可结构化克隆、不暴露 PID/进程内幕；插件代码在两种模式下逐字相同。
- `activationEvents` 支持：`*`、`onStartupFinished`、`onCommand:<id>`、`onLanguage:markdown`、
  `onWebviewPanel:<viewType>`。未知事件只记警告，不阻止安装。
- `extensionDependencies` 做拓扑排序；依赖先激活。
- `capabilities` 只是**安装披露**，不做运行时拦截。字段：`filesystem: "workspace" | "user"`、
  `network`、`secrets`、`git`、`process`、`shell`。
- `contributes` 支持：`commands`、`keybindings`、`configuration`（对象或数组）、
  `menus.commandPalette`、iMark 私有的 `imark.lineMenu` / `imark.actions`。
- `configuration.properties` 用标准 JSON Schema 子集（`type`、`default`、`enum`、
  `minimum`、`maximum`、`title`、`description`、`markdownDescription`、`order`），
  额外 `imark` 元数据：`kind: "text" | "textarea" | "password" | "number" | "boolean" |
  "select" | "targets" | "endpoints"`、`section`、`showWhen: { key, value }`、`rows`、
  `resettable`、`required`、`endpointModel`、`targetSecret`。设置页仍然复用现有
  `PluginField` / `TargetsField` / `EndpointsField`，由主进程把 configuration 翻译成
  `ExtensionSettingField[]`。
- 运行时注册的命令（`registerCommand` 但未在清单声明）也进命令面板，title 用命令 id。

### 2.2 信封 v2

`format: 'imk-plugin'`、`formatVersion: 2`、`manifest`（剥好的 package.json）、`files`、
`data`、`integrity`。

- **integrity 改为递归键排序的 stable stringify**：
  `sha256(stableStringify({ manifest, files: { name: sha256 } }))`。
  不再依赖清单键序。客户端、构建脚本、市场服务端各实现一份同构函数。
- 扩展名白名单增加 `html`；`fileBytes` 8 MiB、`entryBytes` 8 MiB、`envelopeBytes` 16 MiB
  （AI 的 webview 包含 PDF.js）。路径深度仍为 3，AI 的 `webview/chat.js` 满足。
- 安装目录 `userData/plugins/<publisher.name>/`，写入 `package.json`；`installed.json`
  记录 id/publisher/name/version/main/activationEvents/capabilities/integrity/mainSha256/source。
- v1 信封一律拒绝：`formatVersion !== 2` 即失败，没有迁移/兼容分支。

共享文件：

- `src/shared/pluginFormat.json` → `src/shared/extensionFormat.json`（v2 数据、限制、白名单）。
- `src/shared/pluginPackage.ts` → `src/shared/extensionPackage.ts`
  （`validateManifest`、`validateEnvelope`、`stableIntegrityInput`、`descriptorFromManifest`、
  `satisfiesRange`、`compareVersions`；保留并改造现有实现）。
- `src/shared/plugins.ts` 重写为扩展视图类型；保留 `PluginField`、`PluginTarget`、
  `PluginEndpoint`、`PluginActionResult` 等设置页需要的形状，新增 `ExtensionView`、
  `ExtensionDescriptor`、`ExtensionContributions`、`ExtensionStatus`、
  `ExtensionHostGroup`（hostId、extensionIds、pid、内存、运行状态）。
- `src/shared/whenClause.ts`（新）：`&&`、`||`、`!`、`==`、`!=`、括号、布尔/字符串字面量，
  上下文键 `hasEditor`、`hasVault`、`editorFocus`、`editorTextFocus`、`resourceLangId`、
  `isDirty`、`workspaceFolderCount`。
- `src/shared/extensionProtocol.ts`（新）：宿主进程 ↔ main、main ↔ renderer 的全部 RPC DTO。

---

## 三、宿主进程与 `imark` 运行时

### 3.1 宿主进程与 `imark` 注入

- `src/main/extensions/extensionHostProcess.ts` 作为 electron-vite 的第二个 main 入口，
  输出 `out/main/extensionHostProcess.js`。main 的 `HostPlanner` 按分组策略把扩展分到
  宿主；`HostProcess` 为一个组 fork 一次：
  `utilityProcess.fork(join(__dirname, 'extensionHostProcess.js'), [hostId], { serviceName: `iMark Extension Host ${hostId}`, stdio: 'pipe' })`。
  打包时若 asar 阻止 fork，对 `out/main/extensionHostProcess.js` 做 asarUnpack。
- 这个文件只是**每宿主一份的 runtime prelude**：它加载 main 在 `init` 里分配给它的
  `extensionId[]`，不加载其他扩展、不维护全局扩展表、不代理跨宿主请求。
- Electron main 也不加载插件代码：它只负责分组、fork、发 `init`、路由消息与持久化，
  不执行 `activate`、不持有插件模块。
- 宿主启动后 main 发送 `init`（组内扩展描述、路径、各自配置/状态、工作区、主题、应用
  版本）；进程通过 `process.parentPort` 收发消息；stdout/stderr 接到 main 的扩展日志，
  并带 `[extId]` 前缀。
- **按调用方注入 `require('imark')`**：patch `Module._load`，对 `'imark'` 请求按
  `parent.filename` 落在哪个扩展根目录，返回该扩展的 API 对象；`Module._resolveFilename`
  对 `'imark'` 返回虚拟路径。路径用 realpath 归一并校验前缀，禁止穿越。组内只有一个
  扩展时退化为“返回唯一 API 对象”，与 isolated 模式同一条代码路径。
- 每个扩展用独立的 `createRequire(join(extensionPath, 'main.js'))` 加载，读取
  `activate` / `deactivate`；每个扩展有自己的 disposable 集合与日志前缀。卸载单个扩展
  只清它的 require 子树；重载整个宿主时 kill 后重新 fork，进程内 `require.cache` 清空。
- `context`：
  - `subscriptions`、`extensionPath`、`extensionUri`、`extensionMode`、`extension`；
  - `globalStorageUri`（`userData/extensions-data/<id>`）、`storageUri`；
  - `globalState` / `workspaceState`（main 持久化，进程内缓存，100ms 防抖写回）；
  - `secrets`（RPC 到 main，safeStorage；明文只进该扩展所在宿主）；
  - `environmentVariableCollection` 不实现。
- 所有 `register*` / `create*` 返回 `Disposable`，同时自动挂到**该扩展**的 disposable
  集合；`deactivate()` 后按注册逆序 dispose，再清该扩展的定时器。
- 共享宿主的额外约束：`globalThis`、`process`、`require.cache`、事件循环是组内共享的；
  一个扩展调用 `process.exit()`、阻塞事件循环或触发原生崩溃，会带走同组其他扩展。
  这是 shared 模式的已知代价，不做每扩展 VM/线程模拟。
- **线程不作为备选**：`worker_threads` 与主进程共享同一个 OS 进程，扩展里的原生崩溃、
  无限制内存都会带走整个 Electron 主进程，无法做到“一个插件坏掉不影响别人”。
  utilityProcess 的独立 PID 才能满足这个要求；代价是每个激活宿主多一份 Node 运行时
  内存，所以未激活不 fork、停用即 kill。

### 3.2 分组、激活与路由

- main 的 `ExtensionService` 维护 `Map<extensionId, HostProcess>`、
  `Map<hostId, HostProcess>` 与 `Map<commandId, extensionId>`（运行时注册时上报）。
- `HostPlanner` 在启动、安装、启用/禁用、改 `extensionHost.mode` / `affinity` 时计算
  分组：
  1. `mode: 'isolated'`：每个扩展初始一组；`'shared'`：所有扩展初始一组（group 0）。
  2. 沿 `extensionDependencies` 合并有依赖的扩展（与 VS Code 一致）。
  3. 合并清单 `extensionAffinity` 的同置提示；再应用用户设置 `extensionHost.affinity`：
     正整数相同的扩展进同一组，独立组从 1 开始编号。
  4. 组内按 `extensionDependencies` 拓扑排序，依赖先激活。
- 启动时先激活声明了 `*` 的扩展；窗口与编辑器就绪后激活 `onStartupFinished` 的扩展。
  每个命中只 fork 它所在的宿主一次，随后激活该扩展。
- 执行命令前若命令没有 owner：按 `onCommand:<id>` 找到声明它的扩展并激活；仍未注册则
  报错并提示。`commands.executeCommand` 一律经 main 路由到 owner 扩展；跨扩展调用也只
  跨一次宿主边界，宿主之间不直接通信。
- markdown 文档打开时触发 `onLanguage:markdown`；`onWebviewPanel` 在恢复面板时触发。
- 单个扩展 `activate` 失败：写日志、`showErrorMessage`、标记 `activationFailed`；同一扩展
  连续 3 次失败后不再自动重试，直到用户手动「重新加载此扩展」。
- 同一扩展并发激活合并为一个 Promise；命令调用等待该扩展激活完成。
- 宿主意外退出：组内扩展一起标记 `crashed`。按 1s/2s/4s 重启整个宿主并重新激活组内
  扩展；60 秒内三次退出后停止自动重启该组，设置页可手动重新加载。isolated 模式下
  等价于只影响一个扩展。main 会清理该组遗留的状态栏、装饰、面板消息队列。
- 修改 `extensionHost.mode` / `extensionHost.affinity`：立即重算分组，只重启受影响的宿主
  （kill + fork + 重新激活），未受影响的宿主不动。设置页显示「宿主 #N：extA、extB」。
  重启会丢扩展的内存状态；`globalState`/`workspaceState`/`secrets` 已由 main 持久化，
  激活时重新注入。
- 共享模式下同一扩展连续导致宿主崩溃 3 次：标记为 `crash-loop` 并提示用户，提供
  「隔离到独立宿主」按钮（写入 affinity，重启该组）。这是对 VS Code 手动 reload/禁用
  的补充，不改变默认行为。

### 3.3 API 面（`imark` 模块）

按 VS Code 习惯实现以下子集（不提供 `vscode` 模块）：

| 命名空间 | 内容 |
| --- | --- |
| `commands` | `registerCommand`、`executeCommand`、`getCommands` |
| `window` | `activeTextEditor`、`visibleTextEditors`、`onDidChangeActiveTextEditor`、`onDidChangeTextEditorSelection`、`createStatusBarItem`、`showInformationMessage` / `Warning` / `Error`、`showInputBox`、`showQuickPick`、`createOutputChannel`、`createWebviewPanel`、`registerWebviewPanelSerializer`、`activeColorTheme` |
| `workspace` | `workspaceFolders`、`getConfiguration`、`onDidChangeConfiguration`、`onDidChangeTextDocument`、`onDidOpen/Close/SaveTextDocument`、`openTextDocument`、`saveAll`、`fs`（Node fs 薄封装）、`onDidChangeWorkspaceFolders` |
| `env` | `appName`、`appVersion`、`language`、`uriScheme` |
| `extensions` | `getExtension`、`all` |
| `imark` | `reportStatus`、`renderMarkdown`、`flushActiveDocument`、`onDidChangeTheme` |
| 类型/工具 | `Uri`、`Position`、`Range`、`Selection`、`EventEmitter`、`Disposable`、`CancellationToken(Source)`、`StatusBarAlignment`、`ViewColumn`、`TextEditorRevealType`、`ColorThemeKind`、`ExtensionMode` |

关键语义：

- `commands.executeCommand(id, ...args)` 经 main 路由到 owner 扩展所在宿主（或内置命令）；
  返回值必须可结构化克隆，不可克隆的值抛错。
- `workspace.getConfiguration(...).update(...)` 与设置页写入都落到 main，再广播给所有
  活跃宿主和 renderer；每个扩展只收到自己的变更事件，不直接读写磁盘。
- `extensions.getExtension(id)` / `extensions.all` 的元数据由 main 下发；跨宿主不共享
  模块、全局变量或内存。同宿主的扩展共享进程与 `globalThis`（shared 模式），但不提供
  跨扩展对象引用，`exports` 只返回元数据。
- `window.activeTextEditor` / `visibleTextEditors` 由 renderer 状态驱动；`TextEditor` 按文档
  绑定，切换标签后旧编辑器对象仍可用于该文档。
- `TextDocument`：`uri`、`fileName`、`languageId='markdown'`、`version`、`isDirty`、
  `isClosed`、`lineCount`、`eol`、`getText(range?)`、`lineAt`、`offsetAt`、`positionAt`、
  `save`、`validateRange/Position`。
- `TextEditor.edit(callback)`：回调里 `insert/replace/delete` 收集成一批，一次 RPC 发给
  renderer，在同一个 CM6 transaction 里应用（默认进撤销栈），返回 `Promise<boolean>`。
  文档镜像只从 renderer 的变更事件更新，扩展侧不做乐观写入。
- `TextEditor.setDecorations(type, ranges)`：整组替换。装饰类型支持 `backgroundColor`、
  `borderColor`、`borderStyle`、`borderWidth`、`color`、`textDecoration`、`isWholeLine`；
  renderer 端校验颜色/样式白名单后用 CM6 `Decoration.mark` / `widget` 渲染，禁止任意 CSS。
- `selection` / `selections` / `revealRange` / `setSelection` 走 RPC。
- `workspace.getConfiguration('imark.git-sync').get('intervalMinutes')`：值来自 settings +
  清单默认值；`update` 写回 settings，main 广播给所有相关宿主和 renderer。
- `context.secrets`：main 侧 key 为 `<extensionId>:<key>`；AI 用
  `secrets.get('endpoints:<id>')`，git-sync 用 `secrets.get('targets:<id>')`。
- `imark.reportStatus({ status, message, detail, targetResults })` 更新设置页状态卡；
  `targetResults` 按目标合并，沿用旧 `setState` 语义。
- `imark.renderMarkdown(text)`：宿主进程 → main → renderer 复用
  `src/renderer/src/services/exportHtml.ts` 的 `renderMarkdownFragment`，同一套数学/表格规则。
- 不实现：TreeView、任务、终端、调试、语言服务器、notebook、workspace edit、多根工作区。

### 3.4 文档镜像与编辑器桥

- main 维护唯一的 `DocumentRegistry`：`uri`、版本、文本、dirty、eol、是否打开、语言。
  每个活跃扩展（无论宿主怎么分组）只持有自己的一份镜像，由 main 统一广播变更。
- renderer 在启动、打开/关闭标签、内容变化、保存、选区变化时发事件；内容变化发
  CM6 `iterChanges` 增量 `{from,to,insert}` + `version`，main 按扩展订阅转发给相关宿主；
  版本不连续时要求全量重同步。
- 扩展 `openTextDocument(uri)`：文件已打开用镜像，未打开由 main 读盘创建只读文档。
- 扩展 `window.showTextDocument(doc)`：main 让 renderer 打开标签并激活。
- 扩展编辑：宿主进程 RPC `editor.applyEdits(docUri, edits)` → main → renderer 单次
  dispatch；renderer 返回 `{ok, version}`，随后正常变更事件回到该扩展。
- 装饰与选区状态按文档保存在 renderer；切换标签后重新应用该文档的装饰。
- 文档上限沿用 AI 插件的 `MAX_INPUT_CHARS` 等；单条 IPC 超限时截断并报错。

---

## 四、贡献点与渲染层

### 4.1 命令 / 快捷键 / 菜单

- main 从所有**已启用**扩展的 `contributes` 生成快照：commands、keybindings、menus、
  lineMenu、actions、configuration、enabled 状态。
- 命令面板展示声明的命令 + 运行时注册的命令；`menus.commandPalette.when` 为假时隐藏。
- `contributes.keybindings` 映射成 Electron 原生菜单加速键（沿用
  [menu.ts](src/main/menu.ts) 的 `setPluginCommands` / `dedupeAccelerators` 机制）：
  应用快捷键优先，扩展之间先声明者优先，冲突时摘掉加速键并写扩展日志。
- 行首「+」菜单由 [lineMenu.ts](src/renderer/src/services/lineMenu.ts) 改为读取扩展贡献；
  对话框字段仍用现有 `PluginField.vue` 渲染；确认后执行命令并传
  `{ values, source: 'lineMenu' }`。
- 设置页操作按钮读取 `contributes.imark.actions`；`scope:'target'` 时传
  `{ targetId, source: 'action' }`。

### 4.2 状态栏

- `window.createStatusBarItem(alignment, priority)` 在 renderer 状态栏左右两侧各开一个
  扩展槽位；`text`、`tooltip`、`command`、`color`、`backgroundColor`、`name` 生效。
- 点击执行命令；`show/hide/dispose` 同步 DOM。
- 每个扩展最多 5 条、全局最多 12 条，文本 80 字；超出写日志。
- 旧的 render 层自绘按钮入口（`ensureStatusButton`）删除。

### 4.3 设置页

- [PluginSettings.vue](src/renderer/src/components/plugins/PluginSettings.vue) 原地重写为
  扩展设置页，数据源换成 `ExtensionDescriptor`，表单仍由 configuration 派生。
- 展示：显示名/ID/版本/来源、启用开关、配置文件、密钥、动作按钮、状态卡、输出日志、
  安装信息（integrity / mainSha256 / 来源）、卸载、重新加载。
- 新增「宿主」区：`hostMode`（isolated / shared）全局选择、每个扩展的 affinity 值、
  当前宿主组成（宿主 #N：extA、extB）、每个宿主的 PID / 内存、重新加载宿主。
- 共享宿主提示：同宿主扩展共享进程与 `globalThis`，一个扩展 `process.exit()`、阻塞
  事件循环或原生崩溃会影响同组；设置页提供「隔离到独立宿主」。
- 保留现有 `PluginField.vue`、`TargetsField.vue`、`EndpointsField.vue` 的渲染能力，
  字段类型与密钥槽位命名适配扩展 ID。
- 市场页继续用 `MarketInstalled` / `MarketDetail` / `InstallConfirmDialog`，文案与字段
  改为扩展模型。

### 4.4 Webview

- 权限方案：`imark-webview` 注册为 privileged scheme（`standard`、`secure`、
  `supportFetchAPI`、`corsEnabled`、`stream`），必须在 `app.whenReady()` 前注册。
  URL：`imark-webview://<extensionId>/<panelPath>/index.html?token=<token>`。
  authority 稳定（保证 localStorage 跨启动保留），token 每次创建面板随机生成，所有
  资源请求都校验 token 与 `localResourceRoots`，路径用 `safeJoin` 限制在扩展目录内。
- renderer 用 sandbox iframe：
  `sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"`；
  iframe 与宿主应用跨源，`allow-same-origin` 只让它访问自己的 origin。
- CSP 由扩展 HTML 的 meta 提供，默认模板：
  `default-src 'none'; img-src {{cspSource}} data: blob: https: http:; font-src {{cspSource}};
  style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}' {{cspSource}};
  connect-src https: http: ws: wss:; frame-src 'none'; worker-src blob: {{cspSource}}`。
- `WebviewPanel` / `Webview` API：
  - `webview.html`、`webview.options`、`webview.cspSource`、`webview.asWebviewUri()`、
    `webview.postMessage()`、`webview.onDidReceiveMessage`、`webview.getState/setState`；
  - `panel.onDidDispose`、`panel.onDidChangeViewState`、`panel.reveal`、`panel.dispose`；
  - iMark 私有 `panel.imark.setPresentation()` / `setSize()` / `setPosition()` /
    `setTitle()`；`WebviewOptions.imark`: `{ presentation: 'sidebar' | 'overlay' |
    'floating', width, height, transparent, anchor }`。
- renderer 组件 `WebviewHost.vue` 放在编辑器区域：
  - `sidebar`：右侧停靠，默认 420px，可拖宽；
  - `overlay`：铺满编辑器区域；
  - `floating`：右下角小窗，宿主画拖拽把手，位置写回面板状态。
- 每个面板记录 `ownerExtensionId`；iframe 消息、`postMessage`、销毁事件只路由到该扩展
  进程，其他扩展收不到也伪造不了。
- main 在 HTML 与 renderer 挂载都就绪后才创建 iframe；`postMessage` 在挂载前排队。
- `retainContextWhenHidden: true` 时只 `display:none`，不销毁 iframe。
- `registerWebviewPanelSerializer`：main 持久化打开中的面板（viewType、状态、位置、尺寸），
  下次启动按 `onWebviewPanel:<viewType>` 激活并恢复；没有序列化器的面板丢弃。
- 主题：renderer 把当前主题的 CSS 自定义属性（`--bg-editor`、`--text`、`--accent` 等）
  随 bootstrap 注入 iframe，主题变化时推送更新。AI 的旧样式依赖这些变量，否则外观会崩。
- 安全：webview 永远拿不到密钥；扩展也不把 `context.secrets` 的内容写进 HTML。

---

## 五、三款官方插件迁移

三款都改为 `publisher: imark`、`version: 2.0.0`，新 ID：
`imark.git-sync`、`imark.quick-edit`、`imark.ai-for-edit`。旧 ID 的安装记录、配置、密钥
**一律丢弃，不迁移**；新版本首次启动按全新安装处理。

### 5.1 quick-edit → `imark.quick-edit`

- `package.json` 贡献：命令 `imark.quick-edit.insertTable`；`imark.lineMenu` 一条「表格」，
  `dialog` 含 rows/cols；`activationEvents: ["onCommand:imark.quick-edit.insertTable"]`。
- `main.ts` 改成 `export function activate(context)`：`commands.registerCommand`，
  从 `args.values` 取 rows/cols（做同样的 1–50 / 1–20 夹取），生成表格文本。
- 插入逻辑用 `window.activeTextEditor.edit`：在光标行下方补空行、插入文本，再把选区
  放到第一个表头单元格（移植旧 `lineMenu.ts` 的 `insertBlockBelow` 规则）。
- 不注册状态栏、不写配置。

### 5.2 git-sync → `imark.git-sync`

- 配置字段全部映射到 `contributes.configuration.properties`：
  `targets`（`imark.kind: targets` + `targetSecret`）、`intervalMinutes`、`syncOnStart`、
  `proxyMode`、`proxyUrl`、`commitMessage`、`authorName`、`authorEmail`、`autoInitRepo`、
  `initBranch`、`writeGitignore`、`writeReadme`。
- 命令：`syncNow`、`testAll`、`detectProxy`、`testTarget`（target action）。
  状态栏一条：文本「Git 同步」，点击 `syncNow`，显示运行中/成功/部分失败/失败。
- 激活：`onStartupFinished` + 每个命令的 `onCommand`。启动同步仍受 `syncOnStart` 控制。
- API 替换：
  - `imk.getConfig` → `workspace.getConfiguration('imark.git-sync')`；
  - `imk.secrets` → `context.secrets`（key `targets:<targetId>` / `targets:<targetId>#password`）；
  - `imk.setState` → `context.globalState` + `imark.reportStatus`；
  - `imk.git.*` / `imk.net` → 扩展侧直接 `node:child_process`、`node:https`/`fetch`；
  - `imk.vault.root` → `workspace.workspaceFolders?.[0].uri.fsPath`；
  - `imk.flushDocument` → `workspace.saveAll(false)`；
  - `imk.ui.notify` → `window.showInformationMessage/Warning/ErrorMessage`；
  - `imk.log` → `window.createOutputChannel('Git 同步')`。
- 现有 `proxy.ts`、`commitLocal`、`pushAll`、`ensureRepo`、失败分类逻辑原样保留，
  只改外围 API。定时器/AbortController 在 `deactivate` 清理。

### 5.3 ai-for-edit → `imark.ai-for-edit`

结构拆成「扩展侧逻辑」+「webview UI」：

- **扩展侧**（复用现有 `main.ts` / `aiClient.ts` / `prompts.ts`）：
  - 配置：`endpoints`（`imark.kind: endpoints` + 每行模型 + 每行密钥）、
    `generatePrompt`、`beautifyPrompt`、`timeoutSec`、`scannedPdfImages`、
    `characterEnabled`、`characterStyle`。
  - 密钥：`context.secrets.get('endpoints:<endpointId>')`。
  - 网络：沿用 `fetch` + AbortController + 超时；密钥只在扩展侧使用。
  - 命令：`openChat`、`generate`（行首菜单带 prompt）、`testConnection`、
    `testTarget`（target action）。
  - 状态栏：一条「AI」按钮，打开对话面板。
  - 生命周期：`onStartupFinished` 创建状态栏；`characterEnabled` 为真时创建 floating
    character webview；配置变化时重建/销毁 character；`deactivate` 关闭面板。
  - 面板：chat 用 `presentation:'sidebar'`、`retainContextWhenHidden:true`；
    character 用 `presentation:'floating'`、透明背景；两者都 `enableScripts:true`。
  - 注册 `registerWebviewPanelSerializer` 恢复 chat；character 由配置重建。
- **webview 侧**（复用 `render.ts` 3.7k 行 UI + `pdf.ts`）：
  - 新增 `webview/shim.ts`，在 `render.ts` 之前执行，模拟旧
    `ImkRenderLayerApi`：
    - `imk.plugin.getConfig()` 读 `window.__IMK_BOOTSTRAP__.config`（扩展侧写入 HTML）；
    - `imk.plugin.log` → `postMessage` 到扩展侧 → OutputChannel；
    - `imk.plugin.handle({ onEnable, onDisable, onConfigChange })` 保存生命周期；
    - `imk.main.send/onMessage` 映射到 `acquireImarkApi().postMessage` 与 `message` 事件；
    - `imk.markdown.render(text)` 发请求给扩展侧，再走 `imark.renderMarkdown`；
    - `imk.editor.getView()` 返回伪 `EditorView`：`state.doc.length/toString()`、
      `state.selection.main.head`、`state.facet(...)` 恒真、`dispatch({changes, selection})`
      转成 `TextEditor.edit` 请求；
    - `imk.editor.onDocChanged` 由扩展侧推送的文档快照/增量驱动；
    - `imk.editor.kit.view.EditorView.editable` 提供占位对象。
  - `render.ts` 的小改动：按 bootstrap `mode`（`chat` / `character`）初始化；删除旧模型里
    自绘的状态栏按钮；适配 iframe 视口（`position: fixed` 的遮罩/面板改为面板内布局）。
  - 聊天记录继续用 localStorage；origin 按扩展稳定，所以升级后仍能恢复。
  - PDF 文本/扫描页图片仍在 webview 里解析（`pdf.ts` 已用主线程伪 worker，不依赖
    blob worker）；图片通过 `legacy.send('attach.image')` 分条发给扩展侧。
- 行首菜单：`imark.lineMenu` 一条「AI 生成」，dialog 里填 prompt；命令打开 chat 并发送
  `preview.open { mode:'generate', prompt, auto:true }`。
- 设置页动作：`test-connection`（全局）与 `test-target`（每个 endpoint 一行）。
- 保留所有 `MAX_*` 上限与截断提示；`imark.reportStatus` 显示最近一次请求结果。

---

## 六、市场、构建与服务端

### 6.1 构建

`scripts/build-plugins.mjs` 重写：

- 用 esbuild 逐个打包扩展：
  - `plugins-src/<dir>/main.ts` → `dist/<dir>/main.js`（`platform: node`、`format: cjs`、
    `target: node22`、`external: ['imark']`；Node 内置模块自动外置）。
  - AI 额外打包 `webview/chat.ts` / `webview/character.ts` → `webview/*.js`
    （`platform: browser`、`format: iife`、`minify`；含 PDF.js）。
  - 复制 `README.md`、`icon.png`、`webview/*.html`、许可证文件等静态资源。
- 读取 `plugins-src/<dir>/package.json`，剥掉运行时无关字段，得到信封 manifest。
- 生成 `formatVersion: 2` 信封，`integrity = sha256(stableStringify({manifest, files}))`，
  写到 `src/main/market/builtin/<publisher>.<name>.imkpkg.json`。
- 删除旧 `plugins-src/tsconfig.node.json` / `tsconfig.restricted.json` / `tsconfig.render.json`，
  改成单个 `plugins-src/tsconfig.json`（noEmit、`moduleResolution: bundler`、
  `paths: { "imark": ["../src/shared/extensionApi.ts"] }`、types node + DOM），
  供 `npm run typecheck:plugins` 使用。
- `package.json` scripts：`typecheck:plugins` 改为单工程；删除 restricted/render 的
  typecheck/watch；`plugins:build` 保留。`electron.vite.config.ts` 的 main 入口增加
  `extensionHostProcess`，preload 删除 `plugin` 入口。

### 6.2 市场

- `src/shared/market.ts`：
  - `MarketPluginShape` 改为 `{ hasMain: boolean }`；
  - `PackagePreview` 增加 `publisher`、`displayName`、`main`、`activationEvents`、
    `capabilities`、`contributesSummary`，删除 `mainMode` / `hasRender` / `capability` /
    `permissions` / `newPermissions` / `renderSha256`；
  - `MarketQuery` 的 `mainMode` 改为 `hasMain: boolean | null`；
  - 更新/详情同理。
- `src/main/market/{bundled,installer,verify,pack,publish,updates,registry,ipc}.ts`：
  - 读 `package.json`；写 `package.json`；按 v2 校验；
  - `previewEnvelope` 返回新字段；`assertInstallable` 校验 engines / ID / 体积；
  - `upgradeBundled` 仍只升级 `source:'bundled'` 且版本更高；新 ID 的内置包由
    `ensureBundledProvisioned` 首次安装；
  - 市场下载/本地文件/本地目录安装都走同一条 v2 校验路径。
- 市场 UI：
  - 列表筛选「全部 / 含代码 / 纯声明」；标签「含代码」「纯声明」；
  - 详情页展示激活事件、capabilities、贡献摘要；
  - 安装确认框：含 `main` 的扩展必须勾选「我知道扩展代码将以我的用户权限运行」；
    展示入口 sha256、文件清单、来源；纯声明扩展只展示贡献点；
  - 删除 restricted/render/capability 的所有分支与文案。
- 服务端 `server/src/validate.mjs` 独立实现 v2 校验（stable integrity、package.json
  字段、contributes、activationEvents、limits、html 白名单）。
- `server/src/routes/packages.mjs`：`entryOf` 返回 `hasMain`、`activationEvents`、
  `capabilities`、`contributesSummary`；搜索参数 `hasMain`。服务端只处理 v2 信封；
  `server/data` 里的 v1 开发数据在本次改造中清空，不做兼容展示。
- `README.md` 第四/五/六节重写为 VS Code 模型文档：manifest 示例、激活事件、贡献点、
  `imark` API、webview、配置/密钥/状态/日志、构建发布、完整信任警告；删除旧
  node/restricted/render/capability 文档与 note-embed/todo-marks 示例。

### 6.3 旧版本数据：直接丢弃，不迁移

没有 `migrations.ts`，没有旧 ID 映射，没有旧配置/密钥转换。新版本启动时执行一次性清理
（settings 里写 `legacyDataCleared: 2`，仅用于避免重复扫描）：

- 若 `plugins/installed.json` 是 v1 形状（记录含 `mainMode` / 没有 `publisher`），删除整个
  `plugins/` 目录并重建；旧 ID 的目录、配置、密钥、状态全部不保留。
- 删除 `settings.plugins` 键；新模型只读写 `settings.extensions`（每个扩展的配置）与
  `settings.extensionHost`（`{ mode: 'isolated' | 'shared', affinity: Record<id, number> }`）。
  `extensionHost` 是新增键，没有旧值可迁移，默认 `isolated` + 空 affinity。
- 旧密钥文件里所有 v1 插件前缀的条目直接删除，不尝试解密、不转换。
- `note-embed` / `todo-marks` 的残留（目录、配置、密钥）一并删除。
- 清理失败只记日志并继续启动；不会把旧数据“救回来”。
- 三款官方插件随后由 `ensureBundledProvisioned` 按 v2 内置包全新安装，使用新的默认值。

---

## 七、删除范围

删除旧运行时与旧模型文件：

- `src/main/plugins/**`（host、api、contrib、ops、gate、script、renderLayer、capabilities、
  restrictedPage、installed）；
- `src/preload/plugin.ts`；
- `src/renderer/src/services/renderLayer.ts`、`pluginHostOps.ts`（重写为扩展版本）；
- `src/renderer/src/editor/pluginExtensions.ts`、`pluginSdk.ts`；
- `src/shared/pluginApi.ts`、`src/shared/pluginPackage.ts`、`src/shared/pluginFormat.json`；
- `plugins-src/note-embed/**`、`plugins-src/todo-marks/**`；
- `plugins-src/restricted.d.ts`、`plugins-src/render.d.ts`、三份旧 tsconfig；
- `src/main/market/builtin/{git-sync,quick-edit,ai-for-edit,note-embed,todo-marks}.imkpkg.json`
  （由新构建产物替换）；
- 旧验收：`verify/{phase1,phase2,phase3,phase3-smoke,phase3-throttle,layers,plugin-ui,samples}-harness.ts`。

保留但改造：`src/main/ipc.ts`、`src/main/menu.ts`、`src/main/window.ts`、`src/main/protocol.ts`、
`src/preload/index.ts`、`src/shared/ipc-channels.ts`、`src/shared/market.ts`、
`src/shared/types.ts`、市场组件、设置组件、`verify/run.mjs`。

---

## 八、实施阶段（每阶段可独立跑通）

### 阶段 1：格式与骨架

1. 新增 `extensionFormat.json`、`extensionPackage.ts`、`extensionApi.ts`、
   `extensionProtocol.ts`、`whenClause.ts`。
2. 重写 `plugins-src/tsconfig.json` 与 `scripts/build-plugins.mjs`。
3. 三份 `package.json` 清单；删除 note-embed / todo-marks。
4. `npm run typecheck:plugins` + 构建出三个 v2 信封（先不加载）。

### 阶段 2：宿主运行时核心

1. `extensionHostProcess.ts` + `processManager.ts` + `hostPlanner.ts`：分组、fork、init、
   多扩展加载、按调用方注入、激活、命令、配置、密钥、状态、日志、disposable、崩溃重启。
2. `module` 注入与 `imark` API 核心（commands/window/workspace/env/extensions/Uri/
   Position/Range/EventEmitter/Disposable），必须覆盖组内多扩展的归属判定。
3. `ExtensionService`：安装记录、启用/禁用、贡献快照、IPC、`extensionHost.mode` /
   `affinity` 设置与受影响宿主重启。
4. 验收：合成扩展的 `extensions-model` + `extensions-host-groups` harness（不依赖
   renderer）：isolated / shared / affinity 三种分组、组内注入归属、组崩溃与重启。

### 阶段 3：渲染层接入

1. 命令面板、状态栏槽位、行首菜单、快捷键、设置页。
2. `DocumentRegistry` + editor bridge（增删改、选区、装饰、保存、打开标签）。
3. 移植 quick-edit 并跑通端到端插入表格。
4. 验收：`extensions-editor`、`quick-edit`。

### 阶段 4：webview 与 AI

1. `imark-webview` 协议、token、资源服务、CSP、`WebviewHost.vue`、面板位置/尺寸。
2. `WebviewPanel` API、消息队列、状态持久化、序列化器。
3. AI 扩展侧编排 + `webview/shim.ts` + `render.ts` 模式拆分；主题变量注入。
4. 验收：`extensions-webview`、`ai-for-edit`（mock AI 服务）。

### 阶段 5：git-sync 与旧数据清理

1. git-sync 移植、配置/密钥/状态栏/命令。
2. `legacyDataCleared` 清理逻辑：v1 安装目录/配置/密钥直接删除，不做转换。
3. 验收：`git-sync`、`git-sync-auth`、`git-sync-proxy`、`legacy-cleanup`（本地 bare 远端）。

### 阶段 6：市场、构建、文档

1. 市场客户端/服务端 v2；安装确认框；发布/更新。
2. `README.md` 与插件作者文档。
3. 内置包重新生成；`ensureBundledProvisioned` 用新 ID。
4. 验收：`market-v2`、`install-confirm`、`bundled-upgrade`。

### 阶段 7：清理与全量验证

1. 删除旧文件与旧 harness；机械更新仅需 `initPluginHost` 的编辑器 harness
   （导入改为 `initExtensions`）。
2. `npm run typecheck`、`npx electron-vite build`、全部 harness 后台跑一遍。
3. 手工冒烟：三款插件的启用/禁用/设置/命令/行首菜单/状态栏/重启恢复。

---

## 九、验证方案

用户要求验证跑在后台。所有耗时命令用后台执行，不阻塞界面：

```bash
# 静态检查与构建
npm run typecheck
npx electron-vite build

# 单测/集成（按需逐个）
xvfb-run -a node verify/run.mjs extensions-model
xvfb-run -a node verify/run.mjs extensions-host-groups
xvfb-run -a node verify/run.mjs extensions-editor
xvfb-run -a node verify/run.mjs extensions-webview
xvfb-run -a node verify/run.mjs quick-edit
xvfb-run -a node verify/run.mjs git-sync
xvfb-run -a node verify/run.mjs git-sync-auth
xvfb-run -a node verify/run.mjs git-sync-proxy
xvfb-run -a node verify/run.mjs ai-for-edit
xvfb-run -a node verify/run.mjs market-v2
xvfb-run -a node verify/run.mjs install-confirm
xvfb-run -a node verify/run.mjs bundled-upgrade
xvfb-run -a node verify/run.mjs legacy-cleanup
```

新增/重写的验收点：

- **extensions-model**：v2 清单校验；`onCommand` 懒激活；`activate`/`deactivate`；
  `subscriptions` 释放；命令、状态栏、配置、密钥、globalState；重复命令冲突日志；
  激活失败隔离；isolated 下单扩展崩溃只重启自己、不影响其他扩展；停用后 PID 释放。
- **extensions-host-groups**：默认 isolated 下三个扩展三个 PID；切到 shared 后一个 PID，
  两个扩展各自拿到自己的配置/密钥/命令，`require('imark')` 按调用方归属正确；
  `extensionHost.affinity` 把 A、B 分到同一宿主、C 独立；`extensionDependencies` 同置；
  组内一个扩展 `process.exit(1)` 后同组一起重启、其他组不受影响；`activate` 抛错只标记
  该扩展；改设置只重启受影响的宿主；组内扩展全部停用后 PID 消失。
- **extensions-editor**：打开文档镜像、增量变更、`TextEditor.edit` 原子应用与撤销、
  选区/reveal、装饰渲染与清理、切换标签后装饰恢复、保存事件。
- **extensions-webview**：token 校验、资源越界拒绝、CSP、`postMessage` 双向、状态持久化、
  `retainContextWhenHidden`、序列化恢复、主题变量注入。
- **quick-edit**：行首菜单出现「表格」→ 对话框 → 插入 3×3 表格 → 光标在表头；
  禁用扩展后菜单消失。
- **git-sync**：本地 bare 远端；定时/立即同步；多目标成功/部分失败；密钥缺失提示；
  proxy 模式；`onStartupFinished` 启动同步；状态栏状态。
- **ai-for-edit**：mock OpenAI 兼容服务；打开 chat webview；发送对话；生成/美化；
  写入文档；取消；超时；端点轮换；密钥不进 DOM；扫描 PDF 图片路径；character 面板
  显示/隐藏；设置页测试连接。
- **market-v2**：打包 v2 信封、安装、预览字段、拒绝 v1 信封、integrity 重算、
  含代码扩展的确认门、纯声明扩展无确认门。
- **legacy-cleanup**：预置 v1 installed 记录/config/secrets/旧插件目录，启动后这些数据
  全部被删除，settings 只剩 `extensions`，三款官方插件以新 ID 全新安装（不是升级），
  note-embed/todo-marks 无残留。
- **编辑器既有 harness**：仅把初始化改成 `initExtensions`，逐条跑通，确保插件改造没有
  破坏编辑器、表格、数学、Mermaid、自动保存、标签页、通知、设置等原有功能。

手工验收（构建后启动应用）：

1. 设置页三款插件可启用/禁用；禁用后命令、状态栏、行首菜单立即消失。
2. quick-edit 插入表格、AI 对话/生成/美化、git-sync 立即同步和定时同步。
3. 关闭再打开应用，聊天面板、窗口位置、配置、启用态恢复。
4. 从市场安装一个含代码扩展，确认框出现完整权限警告；卸载后配置/密钥清理。
5. 打开扩展源码查看器，确认显示的是实际安装的 v2 包。
6. 设置页切换 isolated / shared、给扩展设 affinity，确认宿主组成与 PID 变化，命令、
   状态栏、行首菜单仍按扩展正确路由。

---

## 十、风险与边界

- **信任模型变化**：旧 restricted 沙箱被移除，所有扩展代码拥有当前用户权限。这是
  VS Code 模型的核心取舍；安装确认、README、设置页都要明确写出，不能只放在代码注释里。
- **webview 安全**：自定义 scheme + sandbox iframe + 每次 token + 资源根限制；任何一项
  缺失都会把扩展页面变成宿主页面。必须用 `extensions-webview` 覆盖 token 越权、
  路径穿越、跨 origin 访问。
- **文档镜像一致性**：所有编辑以 renderer 为准，扩展侧只用版本号；版本不连续时全量
  重同步，避免“扩展看到旧文本 → 覆盖用户输入”。
- **宿主分组与隔离**：isolated（默认）每个活跃扩展约 30–60MB；shared 省内存、跨扩展
  调用更快，但同组共享 `globalThis`、`process`、事件循环和崩溃半径。未激活不 fork、
  停用释放宿主；设置页显示宿主组成与 PID。默认模式是这次改造明确要的隔离，不能用
  “省内存”偷偷改回共享。
- **AI render.ts 复用风险**：3.7k 行 UI 通过 shim 复用，已确认只用到 15 处旧 API；
  仍需逐屏手测聊天、生成、美化、预览、附件、PDF、character。
- **打包/asar**：`utilityProcess.fork` 在 asar 下的行为需要实测；必要时 asarUnpack。
- **旧市场数据**：服务端只接受 v2 信封；现有 v1 `server/data/packages.json` 与 `blobs/`
  直接清空（开发数据，无用户），不做兼容展示；用户/令牌文件保留。
- **范围外**：不实现 VS Code 的 TreeView、任务、终端、调试、LSP、notebook、多根工作区、
  workspace edit、extension signing、`.vsix` 兼容；`imark` 模块代替 `vscode` 模块。
