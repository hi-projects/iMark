# iMark 项目架构

本文描述 iMark 的整体结构、进程边界、启动流程与关键子系统。插件（扩展）系统与插件开发分别见
[插件系统架构](plugin-system.md) 与 [插件开发文档](plugin-development.md)。

## 1. 项目定位

iMark 是一个基于 **CodeMirror 6 + Electron + Vue 3** 的所见即所得 Markdown 编辑器，交互参照
Obsidian 的 Live Preview 与 Vault 工作流。核心约束：

- **文档始终是纯 Markdown 源码**。所见即所得由 CodeMirror 装饰层实现，不引入富文本模型。
- **系统能力只在主进程**。渲染层开启 `sandbox` + `contextIsolation`，通过一次性的
  `contextBridge` 通道访问文件系统、对话框、剪贴板图片等能力。
- **插件（扩展）代码只在独立宿主进程里运行**，永远不 `require` 进主进程。扩展以当前用户权限
  运行，没有权限沙箱；安装确认框的作用是让用户知情，不是门禁。
- **磁盘是权威**。仓库文件、扩展目录、自定义样式都以磁盘上的内容为准，应用不维护第二份清单。

术语：界面与历史文档里“插件”和“扩展”指同一件事；代码统一使用 `Extension` / `extension`，
插件源码目录为 `plugins-src/`，数据目录为 `plugins/`。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面容器 | Electron 44 | 主进程 / preload / 渲染进程；`sandbox: true`、`contextIsolation: true`、无 Node 集成 |
| 构建 | electron-vite 3 + Vite 6 | 主进程与 preload 外部化依赖；渲染层支持 HMR |
| UI | Vue 3.5 `<script setup>` + TypeScript 5.9 | 轻量 `reactive` store，不引入 Pinia |
| 编辑器 | CodeMirror 6 | `@codemirror/state` / `view` / `commands` / `language` |
| Markdown 语法 | `@codemirror/lang-markdown` + Lezer GFM | 语法树是装饰层与公式解析的地基 |
| 公式 / 图表 | KaTeX 0.19 / Mermaid 12 | 编辑期与导出共用渲染服务；字体、图标本地打包 |
| 导出 | markdown-it 14 + highlight.js 11 | 只服务“导出 HTML”，与编辑器内核解耦 |
| 打包 | electron-builder 26 | Windows NSIS / Linux 目标见 `electron-builder.yml` |
| 市场服务端 | 零依赖 Node ESM | `server/`，只使用 `node:` 内置模块 |

## 3. 仓库结构

```text
src/
├── shared/                 主/渲染/构建脚本/服务端共用的类型与纯函数
│   ├── api.ts              WindowApi：preload 暴露给渲染层的桥
│   ├── ipc-channels.ts     IPC 通道常量
│   ├── types.ts            Settings、VaultNode、启动意图等
│   ├── extensionApi.ts     扩展作者看到的 `imark` 模块（类型 + 纯工具类）
│   ├── extensionPackage.ts 清单/信封校验、integrity、配置字段翻译
│   ├── extensionProtocol.ts 宿主 ↔ 主进程 ↔ 渲染层的线协议 DTO
│   └── theme/tokens.css    两档主题的 CSS 变量
├── main/                   主进程
│   ├── index.ts            启动编排
│   ├── window.ts           BrowserWindow、WCO、关闭确认
│   ├── ipc.ts              主进程 IPC 注册
│   ├── dataDir.ts          数据根与 Chromium profile 槽位
│   ├── vault.ts            仓库文件树与文件操作
│   ├── files.ts            读取、原子写、粘贴图片回收
│   ├── settings.ts         settings.json 读写与校验
│   ├── secrets.ts          safeStorage 加密的密钥库
│   ├── protocol.ts         `imark://` 本地图片协议
│   ├── userStyles.ts       自定义样式目录与监听
│   ├── extensions/         扩展服务、宿主规划、宿主进程、运行时
│   ├── market/             市场客户端、安装器、内置包补装
│   └── system.ts           默认 Markdown 程序注册
├── preload/index.ts        一次性取用的 IPC 桥
└── renderer/src/
    ├── main.ts             渲染层初始化顺序
    ├── App.vue             应用外壳与启动恢复
    ├── stores/             响应式界面状态
    ├── services/           文件、标签页、仓库、扩展桥、市场、通知
    ├── editor/             CodeMirror 组装、格式命令、公式解析
    ├── editor/wysiwyg/     语法树 → 装饰（build / rules / widgets / selection）
    ├── components/         界面组件（含设置页、市场页、插件表单）
    └── styles/             样式模块与运行时样式注册表

plugins-src/                官方扩展源码（构建后进 src/main/market/builtin/）
server/                     自托管扩展市场（零依赖 Node）
scripts/                    dev 启动壳、扩展打包脚本
verify/                     端到端验收 harness 与 fixtures
docs/                       本文档
```

## 4. 进程与信任边界

```text
┌──────────────────────────── Electron 主进程 ────────────────────────────┐
│ 启动编排 / 窗口 / 原生菜单 / IPC / 文件 / settings / secrets             │
│ 扩展服务 ExtensionService（安装、启用、配置、宿主规划、命令路由）         │
│ 市场客户端（net.fetch）                                                   │
└───────┬───────────────────────────┬──────────────────────────────┬──────┘
        │ contextBridge（一次性）    │ utilityProcess.fork           │ imark-webview://
        ▼                           ▼                              ▼
┌───────────────┐          ┌──────────────────────┐        ┌────────────────────┐
│ 渲染进程       │◀────────▶│ 扩展宿主进程 1..N     │        │ sandbox iframe      │
│ Vue + CM6      │  编辑器桥 │ require('imark')      │        │ 扩展 webview 页面   │
│ 文档真身       │  IPC/端口 │ 命令、配置、密钥、文档 │        │ postMessage 通信    │
└───────────────┘          └──────────────────────┘        └────────────────────┘
```

四条硬边界：

1. **主进程永不加载扩展代码。** 扩展入口只在 `extensionHostProcess.js` 里 `require`。
2. **文档真身在渲染层。** 主进程与宿主拿到的是镜像；编辑请求带 `expectedVersion`，版本不连续
   时渲染层拒绝，宿主等下一次全量同步。
3. **密钥明文只存在于主进程与扩展宿主内存。** 渲染层与 webview 的消息类型里没有密钥字段；
   界面只显示掩码。
4. **渲染层没有系统能力。** preload 只暴露 `window.__imarkTakeApi()`，`services/api.ts`
   在第一条 import 时取走并保存为模块级常量；之后同一 realm 里的扩展脚本再调用只能拿到
   `null`。完整 API 形状见 [src/shared/api.ts](../src/shared/api.ts)。

### 4.1 安全相关实现

- `BrowserWindow`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- 外链：主进程在 `shell.openExternal` 前校验 `^https?://`。
- 本地图片：`imark://` 特权协议只允许读**当前文档所在目录**与**仓库根**两个范围
  （见 [src/main/protocol.ts](../src/main/protocol.ts)），防止文档里的相对路径读到仓库外文件。
- 扩展 webview：独立 origin `imark-webview://<extensionId>`，每次面板创建都有随机 token；
  协议处理器校验 token、扩展归属与 `localResourceRoots`，并只返回白名单 MIME。
- 市场下载：先比对响应头 integrity，再用与应用内安装完全相同的 `validateEnvelope()` 与逐文件
  sha256 校验；确认框里的内容与最终安装的字节来自同一次下载。

## 5. 启动流程

### 5.1 主进程（`src/main/index.ts`）

模块求值阶段（必须在 `app.whenReady()` 之前）：

1. 设置 Windows `AppUserModelID`（与 `electron-builder.yml` 的 appId 一致）。
2. 开发模式下关闭崩溃上报，避免 Chromium 的 Crashpad 噪声。
3. `protocol.registerSchemesAsPrivileged()` 注册 `imark` 与 `imark-webview`。
4. `prepareDataDirs()`：同步决定数据根与 Chromium profile，详见 §6。返回 `false` 表示
   `--user-data-dir` 指定的 profile 已被另一个实例占用，直接退出。

`app.whenReady()` 之后：

1. `registerIpc()`、`registerImarkProtocol()`、`registerExtensionWebviewProtocol()`。
2. `startInstanceBroker()`：启动本机 IPC 端点，接收其它实例的“聚焦仓库窗口”请求。
3. `ensureUserStylesDir()`、`loadSettings()`、`fileFromArgv()`。
4. 决定启动仓库：带文件时按“已开窗口包含该文件 → 最近仓库包含该文件”的顺序判断；没有文件时，
   只有勾选“直接打开上次仓库”才恢复。随后 `claimVault()` 认领；若仓库已在另一个窗口打开且
   联系得上，本实例把文件转交过去并退出。
5. `initExtensions()`：加载扩展登记表、清理中断安装、恢复 webview 记录。
6. `ensureBundledProvisioned()`：补装四款官方内置包（quick-edit / git-sync / agent / claude-code）。
7. `buildAppMenu()`：扩展快捷键必须在此之前进入原生菜单。
8. `setPendingOpenFile()`、`prepareTaskbarIcon()`（Windows 任务栏按钮图标）、`createMainWindow()`。
9. `ready-to-show` 后补做暂存的聚焦/文件投递；`did-finish-load` 后 `service.startup()`
   激活 `*` 与 `onStartupFinished` 扩展，并恢复 webview 面板。
10. 启动自定义样式监听与一次性更新检查（延迟 8 秒，失败静默）。

退出：主窗口 `closed` 后 `app.quit()`；`will-quit` 停止样式监听、实例协调端点与所有扩展宿主。

### 5.2 渲染层（`src/renderer/src/main.ts`）

初始化顺序有硬性要求：

1. `import './services/api'` **必须是第一条 import**——在扩展代码加载前取走 IPC 桥。
2. `initNotificationCapture()`：包装浏览器 `Notification`，把通知收进通知中心。
3. `initEditorBridge()`：接住编辑器第一条事务与 `editor.ready` 快照。
4. `initExtensionService()` / `initExtensionUiHost()` / `initWebviews()`：在挂载前订阅，
   避免启动激活阶段的消息丢失。
5. 挂载 Vue 应用，再初始化行首菜单、市场进度、自定义样式。

`App.vue` 挂载后读取 settings 与启动意图，应用主题并同步窗口控件配色，然后按“启动参数文件 →
恢复上次仓库 → 停在选择页”的顺序进入界面。

## 6. 数据目录与多实例

### 6.1 数据根

见 [src/main/dataDir.ts](../src/main/dataDir.ts)。数据根是**整个应用数据的唯一根**：

| 模式 | 数据根 | profile |
|---|---|---|
| 应用目录可写（安装版 / 开发版） | `<应用目录>/.imark` | `<数据根>/profile` |
| 应用目录不可写（Program Files、AppImage、macOS .app、网络盘） | `~/.imark` | `<数据根>/profile` |
| `--imark-data-dir=D` | `D` | `D/profile`，或命令行 `--user-data-dir` |
| `--user-data-dir=U` | `U` | `U` |

布局：

```text
<数据根>/
├── css/                    自定义样式（文件或目录）
├── plugins/                扩展包、installed.json、.staging/、<id>.old-*/
├── instances/              多开协调：哪个实例开着哪个仓库（临时文件）
├── logs/extensions/        每个扩展一个完整日志文件
├── extensions-data/        扩展 globalState、storageUri、webviews.json
├── settings.json           界面偏好、仓库列表、扩展启用态与配置
├── secrets.json            safeStorage 加密的扩展密钥与市场令牌
└── profile/                Chromium userData + sessionData
    └── Local State         safeStorage 密钥（必须跟 profile 走）
```

### 6.2 多开

- 数据根（设置、扩展、密钥）所有实例共用；Chromium profile 一个实例一份：
  第一个实例用 `profile/`，之后依次 `profile-2/`、`profile-3/`……
- 每个槽位先 `setPath` 再 `requestSingleInstanceLock()`；锁绑在 userData 上，进程退出自动释放。
- Windows 上把主 profile 的 `os_crypt.encrypted_key` 抄进新槽位，否则第二个实例解不开共用
  `secrets.json` 里的令牌。
- 显式 `--user-data-dir` 不分槽：位置由调用方决定，被占用时本实例退出。
- **同一个仓库只开一个窗口**：`vaultHandoff.ts` 在 `instances/<仓库哈希>.json` 里登记 PID 与本机
  IPC 端点（Windows 命名管道 / Unix socket）。另一个实例打开同一仓库时请求现有窗口聚焦并投递
  文件；联系不上时返回 `busy`，不制造第二个写入者。

## 7. 主进程模块

| 模块 | 职责 |
|---|---|
| `index.ts` | 启动编排、协议注册、扩展初始化、更新检查 |
| `window.ts` | 窗口创建、Windows WCO 配色、任务栏 RelaunchCommand、脏检查关闭流程 |
| `ipc.ts` | 文件、设置、仓库、样式、系统集成等 IPC |
| `dataDir.ts` | 数据根解析、profile 槽位、safeStorage 密钥共享 |
| `vault.ts` | 递归列出 md/markdown/mdown/txt；新建、重命名、回收站删除 |
| `files.ts` | 读文件（剥 BOM、探测 CRLF/LF）、原子写、粘贴图片保存与回收 |
| `settings.ts` | 加载/校验/合并/串行写盘；唯一的设置变更通知源 |
| `secrets.ts` | safeStorage 加密；加密不可用时降级明文并在界面提示 |
| `protocol.ts` | `imark://`：只读当前文档目录与仓库根内的图片 |
| `userStyles.ts` | `css/` 目录读取、导入、`fs.watch` + 存在性看门狗 |
| `menu.ts` | 原生菜单与扩展命令栏；重复快捷键去重 |
| `openFile.ts` | 从 argv 提取待打开文件、暂存/取走 |
| `launchArgs.ts` | `--new-window` 启动意图、AppUserModelID |
| `vaultHandoff.ts` | 多实例仓库占用与窗口聚焦 |
| `system.ts` | Windows ProgID / 打开方式 / 任务栏 `.ico`；Linux xdg-mime |
| `appIcon.ts` / `iconData.ts` | 窗口图标路径解析；扩展图标转 data URL |
| `extensions/` | 扩展系统（见 [插件系统架构](plugin-system.md)） |
| `market/` | 市场客户端与安装流程（见 [插件系统架构](plugin-system.md)） |

### 7.1 设置

`settings.ts` 是唯一写入口。读取时做浅校验（主题枚举、侧栏宽度、自动保存延迟、扩展配置形状），
写盘前先把磁盘上的最新 JSON 与本次 `partial` 合并，再走串行队列 + 原子写。多个实例同时改设置时，
后写的实例不会用旧快照覆盖别人刚写的字段。

`onSettingsChanged` 的订阅者包括窗口 WCO 配色与扩展服务；不要在其他地方另写设置文件。

### 7.2 原子写与多实例

`writeFileAtomic()` 的临时文件名带 PID 与随机后缀，避免两个实例的 rename 互相搬走中间文件。
设置、扩展登记表、扩展状态、webview 记录、密钥库都走它。

## 8. 渲染层

### 8.1 应用外壳

`App.vue` 只有两个视图：

- `picker`：`VaultPicker.vue`，最近仓库、打开文件夹、创建仓库、跳过选择的开关；
- `editor`：左侧 `FileExplorer`、中间标签栏 + `EditorPane` + `WebviewHost`、右侧大纲、
  底部 `StatusBar`；浮层包括快速切换器、行首菜单、扩展参数对话框、设置、通知中心、Toast。

界面状态集中在 `stores/app.ts`（`reactive`），但**文档内容不放进响应式**：每个标签页各持有一份
`EditorState`，存在 `services/tabs.ts` 的模块级 Map 里；切换标签时对同一个 `EditorView`
`setState()`。这样撤销历史、选区、滚动位置天然按标签隔离，扩展也只需要认当前视图。

### 8.2 服务层

| 服务 | 职责 |
|---|---|
| `fileService` | 新建/打开/保存/另存为/导出、脏标记、保存后回收无引用图片 |
| `tabs` | 标签模型、`EditorState` 生命周期、撤销历史、会话恢复 |
| `autoSave` | 四种自动保存模式；未落盘文件、无改动、上一轮未完成时跳过 |
| `vaultService` | 仓库加载/认领/恢复、文件树刷新、拖拽移动、外部文件打开 |
| `editorBridge` | 渲染层 ↔ 主进程的文档/选区/装饰/主题桥，版本号唯一来源 |
| `extensionService` | 扩展视图缓存与 IPC 往返（无乐观更新） |
| `extensionUiHost` | 扩展的模态消息/输入框/QuickPick 队列 |
| `webviews` | webview 面板状态、iframe 挂载、消息路由与排队 |
| `marketService` | 市场浏览、安装预览、进度、发布 |
| `notice` / `notificationCapture` | 右下角气泡、通知中心历史、浏览器通知接管 |
| `userStyleService` | 把选中的自定义样式注入/卸载 |
| `exportHtml` | markdown-it + KaTeX + Mermaid 单文件导出 |

### 8.3 主题与样式

- 颜色全部走 `src/shared/theme/tokens.css` 的 CSS 变量，`<html data-theme>` 切换 `light` / `dark`。
- CodeMirror base theme 已定义的属性（`.cm-cursor`、`.cm-scroller` 等）必须通过
  `EditorView.theme` 覆盖，外部 CSS 会因特异度不足被静默忽略。
- `styles/index.ts` 集中导入所有 CSS，层叠顺序固定；`styles/registry.ts` 提供运行时
  `registerStyle(id, css)` / `unregisterStyle(id)`，第一个调用方是用户自定义样式。
- 窗口右上角的 WCO 控件由主进程绘制；渲染层应用主题后通过 `window:set-theme` 主动上报实际主题。

## 9. 编辑器内核

### 9.1 所见即所得

核心在 `src/renderer/src/editor/wysiwyg/`：

```text
Lezer 语法树（增量解析）
   ↓  docChanged / viewportChanged / selectionSet
ViewPlugin 遍历可见范围
   ↓  按节点名分发（rules.ts）
Decoration.mark / replace / replace({widget})
   ↓
RangeSet + EditorView.atomicRanges
```

关键点：

- 光标与节点区间相交（闭区间）时标记显形，否则隐藏 `**`、`` ` ``、`#`、`](url)` 等语法字符。
- 所有 replace 区间同时注册为原子区间，方向键与点击不会落进隐藏字符。
- 中文输入法组合期间（`compositionstart` 到 `compositionend`）跳过重建，避免候选窗被打断。
- 跨行块（表格、块级公式、Mermaid）只替换首行成 widget，其余行清空并折叠为零高度；首行不在
  视口内时整块退回源码，避免出现空白。详见 `rules.ts` / `widgets.ts` 的注释。
- 表格的单元格输入、行列增删、整表对齐/删除、矩形选区等都在 `widgets.ts` 内实现。

### 9.2 公式与图表

- `editor/math.ts` 给 Lezer 注册 `InlineMath` / `DisplayMath` / `MathBlock` 解析器，代码块与
  行内代码里的 `$` 不会被误判。
- `MathWidget` 用 KaTeX 同步渲染；`throwOnError: false`、`trust: false`。
- `services/mermaid.ts` 动态 import Mermaid、串行队列渲染、按“主题 + 源码”缓存，本地注册
  Lucide 图标包；widget 用 `ResizeObserver` + `mustMeasureContent` 修正异步撑高后的行高缓存。
- 导出层复用同一套 KaTeX / Mermaid 逻辑，输出单文件 HTML。

## 10. 扩展系统与市场（概览）

扩展清单是 `package.json`，代码在 `utilityProcess` 宿主里通过 `require('imark')` 运行。
`ExtensionService` 负责安装、启用态、配置、密钥、激活事件、宿主分组、命令路由与崩溃重启；
内置的四款官方扩展随应用补装，走与市场下载完全相同的校验路径。

市场服务端在 `server/`，零依赖、数据落 JSON + 按 sha256 去重的 blob。安装遵循
“预览 → 用户确认 → 安装”，确认框展示整包 sha256、入口 sha256、能力声明与贡献摘要。

完整设计见 [插件系统架构](plugin-system.md)。

## 11. 构建、开发与验收

```bash
npm run dev             # 开发模式（先构建插件）
npm run plugins:build   # plugins-src → src/main/market/builtin/*.imkpkg.json
npm run typecheck       # node + web + plugins
npm run build           # electron-vite build
npm run dist[:win|:linux]
npm run market          # 启动自托管市场（server/）
```

验收 harness 在 `verify/`，用 `node verify/run.mjs <名字>` 运行。它会：

1. 用 esbuild 把 harness 与主进程源码打到 `out/main/`；
2. 清掉 `ELECTRON_RUN_AS_NODE`；
3. 使用仓库内独立的 `.verify-ud/<名字>` 作为 `--user-data-dir`；
4. 每次都从干净目录重来。

注意：harness 不会重新构建 preload 与渲染层页面；改了 `src/preload/` 或 `src/renderer/`
之后要先跑 `npx electron-vite build`，否则测到的是旧产物。

## 12. 延伸阅读

- [插件系统架构](plugin-system.md)：包格式、安装、宿主拓扑、协议、市场、Agent provider。
- [插件开发文档](plugin-development.md)：清单字段、API、webview、行首菜单、调试与发布。
