# iMark 插件系统 v2 改造 · 交接文档

> 更新时间：2026-10-21 深夜（续作）
> 当前状态：**阶段 1–7 已完成**。市场/服务端/文档已切到 v2，v1 运行时与旧包已删除；
> typecheck、构建、13 套 v2 验收与既有编辑器 harness 均已跑过（唯一遗留是 `table-render`
> 在本机的一次既有卡死，见 §11）。
> 完整设计计划已随仓库保存：[docs/plugin-system-v2-plan.md](docs/plugin-system-v2-plan.md)（这就是此前批准的七阶段计划）

这份文档给**换机器后接手的人 / Claude**。先读第 1、2、3 节，再按第 5、6 节的清单往下做。不要重新设计架构，也不要做旧版本兼容。

---

## 1. 一句话目标

把 iMark 的插件系统从自研三层模型（node / restricted / render / capability）改成 **VS Code 扩展模型**：

- 扩展清单 = 扩展目录根部的 `package.json`（v2 信封里的 manifest）；
- `contributes` / `activationEvents` / 懒激活 / `activate(context)` / `deactivate()`；
- 扩展代码跑在 `utilityProcess` 扩展宿主里，通过 `require('imark')` 拿到 API；
- 默认 `extensionHost.mode = 'isolated'`（每个扩展一个宿主进程），也支持 `'shared'` 与 `extensionHost.affinity` 分组；
- 三款官方扩展迁移：`imark.quick-edit`、`imark.git-sync`、`imark.ai-for-edit`；
- `note-embed`、`todo-marks` 彻底删除；
- **硬切，不保留任何 v1 包格式、旧配置、旧密钥、旧安装记录。**

## 2. 用户已经拍板、不要改的决策

1. 完整 VS Code 模型，**不做任何向后兼容**。没有 v1 包、没有 `window.imark`、没有 render/restricted/capability 兼容分支。
2. 只迁移三款官方插件；`note-embed` / `todo-marks` 删除（用户不知道它们是谁写的）。
3. 两套宿主拓扑都要：`isolated`（默认，每扩展一个进程）与 `shared`（共用宿主）+ affinity 分组。共用同一套宿主运行时。
4. 旧数据**直接丢弃**，不迁移。启动时一次性删除 v1 插件目录/配置/密钥/日志；三款官方插件按全新安装处理。
5. 信任模型：**扩展代码以当前用户权限运行，不做权限沙箱**。安装确认框必须明确写出这一点。webview 仍然是与宿主隔离的沙箱页面。
6. 密钥只留在主进程 `safeStorage` 与扩展宿主内存；渲染层/webview 只能拿到掩码。
7. 所有耗时验证放后台跑（`run_in_background`）。

## 3. 当前仓库状态（接手先看）

- 分支 `main`；**约有 100 个已修改/未跟踪文件，且尚未 commit**。换机器前必须先 `git add -A && git commit` 再 push，或整体拷贝工作树（不要漏掉未跟踪文件）。
- `.verify-ud/`、`out/`、`.imark/`、`node_modules/` 都是本机产物，不要拷、不要提交（已在 `.gitignore`）。
- **v1 运行时已删除**：`src/main/plugins/**`、`src/preload/plugin.ts`、旧 renderer 服务
  （`pluginService` / `pluginUi` / `renderLayer` / `pluginHostOps` / `pluginExtensions` / `pluginSdk`）、
  旧 `src/shared/plugin*.ts`、旧内置包 JSON 与旧 harness 均已不存在。共享类型只剩
  `src/shared/plugins.ts`（字段/目标/状态/日志）与 `extensionPackage.ts` / `extensionApi.ts` 等 v2 模块。
- `src/main/index.ts` 在 `initExtensions()` 之后调用 `ensureBundledProvisioned(service)`，再 `buildAppMenu()`。
- `src/main/market/builtin/` 只剩三份 `imark.*.imkpkg.json`；`npm run plugins:build` 可重新生成。
- `src/main/market/bundled.ts` 已重写为 v2（三款内置包、`source: 'bundled'` 才升级、并发复用同一个 Promise）。
- 最近确认：`npm run typecheck`（node/web/plugins）、`npx electron-vite build`、`npm run plugins:build` 全绿。
- 已验证通过（本机后台跑）：

| 验收 | 结果（2026-10-21 续作，本机 Windows） |
| --- | --- |
| `extensions-model` | 绿（37/37；含运行时启用补激活回归） |
| `extensions-host-groups` | 绿（33/33） |
| `extensions-editor` | 绿（67/67；修正了 harness 的 Windows `file://` 拼法） |
| `extensions-webview` | 绿（51/51） |
| `quick-edit` | 绿（48/48） |
| `git-sync` | 绿（69/69） |
| `git-sync-auth` | 绿（21/21） |
| `git-sync-proxy` | 绿（29/29） |
| `ai-for-edit` | 绿（164/164） |
| `market-v2` | 绿（39/39，新增） |
| `install-confirm` | 绿（30/30，重写） |
| `bundled-upgrade` | 绿（31/31，重写） |
| `legacy-cleanup` | 绿（38/38） |
| `market-ui` | 绿（13/13，新增；市场/已安装/发布/设置/卸载确认） |
| 编辑器既有 harness | `editor-enter`、`code-block`、`code-indent`、`math-block`、`mermaid`、`tabs`、`session-restore`、`autosave-modes`、`image-paste`、`cursor`、`font-zoom`、`settings-system`、`settings-reflow`、`userstyle-dir`、`data-dir` 绿 |
| `table-render` | **红/卡死（既有问题）**：在当前 CSS 下断言期望 2px 内边距、<30px 行高，实际是 8px / 34.9px；随后在「两张表的文档 + 页面 reload」处渲染进程 100% CPU。与插件改造无关，未在本轮修。 |

## 4. 环境与命令（本机踩过的坑）

```bash
# 这台机器的 shell 默认设置了 ELECTRON_RUN_AS_NODE，跑 Electron 前必须去掉
env -u ELECTRON_RUN_AS_NODE npm run typecheck
env -u ELECTRON_RUN_AS_NODE npx electron-vite build

# 单套验收（run.mjs 会自动清掉 ELECTRON_RUN_AS_NODE、给独立 userData）
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs <name>

# 三套 git-sync 验收
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs git-sync
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs git-sync-auth
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs git-sync-proxy
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs legacy-cleanup
```

重要：

- `verify/run.mjs` **只重新打包 harness，不重新构建应用**。改了 `src/preload/**` 或 `src/renderer/**` 后必须先 `npx electron-vite build`，否则 harness 里跑的是旧产物。
- 合成按键事件用 `Left` / `Down`，**不要用 `ArrowLeft`**（本项目的 harness 约定）。
- 新机器：`npm ci`；如果 `src/main/market/builtin/*.imkpkg.json` 缺失或过期，跑 `npm run plugins:build`（当前构建脚本已经是 v2）。
- start-up 需要 `--user-data-dir`；用 `verify/run.mjs` 跑会自动带上。

## 5. 阶段 6：市场、构建、文档（已完成）

### 5.1 重写共享市场类型 [src/shared/market.ts](src/shared/market.ts)

它现在 import 了 `PluginPermission`、`PluginDescriptor`、`PluginView`（阶段 7 要删的 v1 类型），必须先改。

建议目标形状（字段名可按实现微调，但语义必须是 v2）：

```ts
import type { ExtensionDescriptor, ExtensionView } from './extensions'
import type { ExtensionCapabilities } from './extensionPackage'

export interface MarketContributesSummary {
  commands: number
  keybindings: number
  configuration: number
  lineMenu: number
  actions: number
}

export interface MarketPluginShape {
  /** 是否有 main 入口（false = 纯声明式） */
  hasMain: boolean
}

export interface MarketEntry extends MarketPluginShape {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  author: string | null
  publisher: string
  activationEvents: string[]
  capabilities: ExtensionCapabilities
  contributesSummary: MarketContributesSummary
  homepage: string | null
  hasIcon: boolean
  downloads: number
  updatedAt: number
  publishedAt: number
}

export interface PackagePreview {
  id: string
  name: string
  displayName: string
  version: string
  author: string | null
  description: string
  /** 市场发布者；本地安装为 null */
  publisher: string | null
  descriptor: ExtensionDescriptor
  hasMain: boolean
  main: string | null
  activationEvents: string[]
  capabilities: ExtensionCapabilities
  contributesSummary: MarketContributesSummary
  integrity: string
  fileCount: number
  totalBytes: number
  files: PackageFileInfo[]
  mainSha256: string | null
  installed: { version: string; integrity: string } | null
  installedVersion: string | null
  downgraded: boolean
  origin: 'market' | 'local-file' | 'local-dir'
  originLabel: string
}

export interface MarketVersionInfo {
  version: string
  integrity: string
  publishedAt: number
  yanked: boolean
  size: number | null
  mainSha256: string | null
}

export interface MarketUpdate {
  id: string
  name: string
  currentVersion: string
  latestVersion: string
  hasMain: boolean
}

export interface MarketQuery {
  q: string
  page: number
  pageSize: number
  sort: MarketSort
  /** null = 不筛选；true = 只看含代码；false = 只看纯声明 */
  hasMain: boolean | null
}

export interface MarketInstalledData {
  extensions: ExtensionView[]
  bundled: string[]
}
```

删除：`mainMode`、`hasRender`、`capability`、`capabilityName`、`permissions`、`newPermissions`、`renderSha256`、`mainMode` 查询参数。

`PublishPreview` 同理：`hasMain`、`main`、`activationEvents`、`capabilities`、`contributesSummary`、`mainSha256`，无权限字段。

### 5.2 主进程市场模块

按顺序改，每改完一个跑 `typecheck:node`：

1. **[src/main/market/verify.ts](src/main/market/verify.ts)**
   - 不要继续用 `@shared/pluginPackage`。
   - 可以直接委托 [src/main/extensions/installer.ts](src/main/extensions/installer.ts) 里已导出的 `verifyExtensionPackage()`（它已经做了 v2 结构 + 逐文件 sha256 + stable integrity）。
   - `computeIntegrity` 用 `sha256(stableIntegrityInput(manifest, files))`。
   - `VerifiedPackage` 去掉 `renderSha256`；`mainSha256` 从 `manifest.main`（去掉 `./` 前缀）查 `files`。
   - `checkEngines` 保留，但类型换成 `ExtensionManifest`。

2. **[src/main/market/installer.ts](src/main/market/installer.ts)**
   - 删除 `checkAgainstCapability`、权限参数、`renderSha256`、`manifest.json` 写入。
   - 安装不再自己解包到 `.staging`，而是调用
     `getExtensionService()!.installPackage(envelope, { source, registryUrl, expectedIntegrity })`。
     `service.installPackage()` 已包含 v2 校验、暂存、原子就位、写 `installed.json`、重载条目。
   - `MarketProgress` 的 `load` 阶段可以简化成“安装完成”，不要伪造真实加载。
   - `previewEnvelope(raw, origin, installed)` 返回 5.1 的 `PackagePreview`：
     - `hasMain = Boolean(manifest.main)`
     - `main = manifest.main ?? null`
     - `activationEvents = manifest.activationEvents ?? []`
     - `capabilities = manifest.capabilities ?? {}`
     - `contributesSummary` 从 `manifest.contributes` 计数
     - `descriptor = descriptorFromManifest(manifest)`
   - `installed` 只需 `{ version, integrity }`；不再有 `grantedPermissions`。
   - `assertInstallable` 只检查 engines（结构/体积/ID 已由 `validateEnvelope` 负责）。

3. **[src/main/market/pack.ts](src/main/market/pack.ts)**
   - 读目录根部的 `package.json`（不是 `manifest.json`）。
   - `validateManifest()` 返回的 `value` 已经剥掉 `scripts` / `devDependencies` / `dependencies` / `private` / `type` / `files` / `publishConfig`，直接把 `checked.value` 放进信封。
   - 打包时跳过 `package.json`（清单只进 `envelope.manifest`）、`node_modules`、`dist`、`.git`、`*.ts/.tsx/.mts/.cts/.map`。
   - 检查 `manifest.main` / `manifest.icon` 文件存在；没有 render 概念。
   - integrity 用 stable stringify；上限用 `EXTENSION_LIMITS`。

4. **[src/main/market/publish.ts](src/main/market/publish.ts)**
   - 预览字段改 v2；`previewPublish` 用 `packDirectory` + `previewEnvelope`，不再有 permission/新旧权限。

5. **[src/main/market/updates.ts](src/main/market/updates.ts)**
   - `MarketUpdate` 改 `hasMain`；删除 `newPermissions` 比较与 `permission` 文案。

6. **[src/main/market/registry.ts](src/main/market/registry.ts) / [http.ts](src/main/market/http.ts) / [source.ts](src/main/market/source.ts)**
   - 解析服务端 v2 字段：`hasMain`、`displayName`、`activationEvents`、`capabilities`、`contributesSummary`。
   - `MarketQuery.hasMain` 原样传给服务端；删除 `mainMode` / `hasRender`。
   - `source.ts` 的源码查看仍要过 v2 `validateEnvelope`，按 `manifest.main` 标出入口文件。

7. **[src/main/market/ipc.ts](src/main/market/ipc.ts)**
   - `getPluginHost()` → `getExtensionService()`；所有 `host.list()` → `service.getExtensionViews()`。
   - `installedSnapshot()` 从 `service.getExtensionView(id)` / `getRecord(id)` 取 `{version, integrity}`，没有权限。
   - `MarketInstalled` 返回 `{ extensions, bundled }`。
   - `MarketInstallPending` 调 `service.installPackage()`；`MarketUninstall` 调 `service.uninstallExtension()`；
     `MarketRestoreBundled` 调 v2 `ensureBundledProvisioned(service)`。
   - `MarketPackDir` 的对话框标题改成“选择扩展目录（需含 package.json）”。

8. **[src/main/market/pending.ts](src/main/market/pending.ts)** 基本不动，确认类型里不再有权限。

### 5.3 重写内置包补装 [src/main/market/bundled.ts](src/main/market/bundled.ts)

建议整体重写，不要尝试修补 v1：

- import 三份 v2 JSON（注意 `?raw` 字符串方式与现有 `env.d.ts` 约定一致）：
  `imark.quick-edit.imkpkg.json`、`imark.git-sync.imkpkg.json`、`imark.ai-for-edit.imkpkg.json`。
- `BUNDLED` 策略不变：
  - quick-edit：`enable: true`（开箱即用）
  - git-sync / ai-for-edit：`enable: false`
- 删除所有 `CONFIG_MIGRATIONS` / `SECRET_MIGRATIONS` / 权限继承逻辑（用户明确要求不迁移旧数据）。
- `ensureBundledProvisioned(service: ExtensionService)`：
  - 对每个包，解析 `manifest.id` / `version`。
  - 如果已有记录：
    - 只有 `record.source === 'bundled'` 且内置版本更新时才 `service.installPackage(...)`；
    - 其他来源（market/local/dev）一律不碰。
  - 如果没装：`service.installPackage(envelope, { source: 'bundled' })`；
    - 若是全新安装且 `enable === false`，再 `service.setEnabled(id, false)`（因为默认偏好是 enabled=true）；
    - `enable === true` 不需要显式设置。
  - 并发保护：模块级 `let provisioning: Promise<void> | null`，重复调用复用同一个 Promise（启动与“恢复自带扩展”按钮可能并发）。
- `bundledIds()` 返回三款新 ID。
- **调用点**：
  - [src/main/index.ts](src/main/index.ts)：`initExtensions()` 之后、`buildAppMenu()` 之前调用 `await ensureBundledProvisioned(service)`；
  - [src/main/market/ipc.ts](src/main/market/ipc.ts) 的 `MarketRestoreBundled`。
- **不要**把补装塞进 `initExtensions()` 的默认路径：现有 v2 harness 会预置合成扩展，默认补装会污染断言。老 harness 里本来传 `ensureBundledProvisioned` 的，阶段 7 改成显式调用。

### 5.4 市场界面

1. [src/renderer/src/services/marketService.ts](src/renderer/src/services/marketService.ts)
   - 删除 `mainMode` / `hasRender` / `permissions` / `newPermissions` / `renderSha256`。
   - 查询筛选：`hasMain: null | true | false`（界面文案「全部 / 含代码 / 纯声明」）。
2. [src/renderer/src/components/market/MarketInstalled.vue](src/renderer/src/components/market/MarketInstalled.vue)
   - 数据源从 `MarketInstalledData.plugins: PluginView[]` 改为 `.extensions: ExtensionView[]`。
   - 展示 `descriptor.displayName`、`record.version`、来源、启用态。
   - 删除权限行与 `newPermissions` 警告。
3. [src/renderer/src/components/market/MarketDetail.vue](src/renderer/src/components/market/MarketDetail.vue)
   - 删除 restricted/render/capability 分支。
   - 展示：含代码/纯声明、激活事件、`capabilities`、贡献摘要（命令/快捷键/设置项/行首菜单/动作数量）、入口 sha256。
4. [src/renderer/src/components/market/InstallConfirmDialog.vue](src/renderer/src/components/market/InstallConfirmDialog.vue)（**安全关键**）
   - 含代码扩展（`hasMain`）必须勾选明确的确认项：
     「我知道扩展代码将以我的用户权限运行，可以读写我的文件、访问网络」。
   - 纯声明式扩展不需要这个勾选，只展示它贡献了什么。
   - 删除 render/permission/capability 区块；保留文件清单、总大小、整包 sha256、入口 sha256、来源、版本升降级提示。
   - 确认按钮在未勾选时必须禁用。
5. [src/renderer/src/components/market/MarketPublish.vue](src/renderer/src/components/market/MarketPublish.vue)
   - 预览改 v2：`hasMain`、`main`、`activationEvents`、`capabilities`、`contributesSummary`、`mainSha256`。
6. [src/renderer/src/components/market/MarketPage.vue](src/renderer/src/components/market/MarketPage.vue) 与列表筛选条：
   - 筛选「全部 / 含代码 / 纯声明」；
   - 标签改为「含代码」「纯声明」。

### 5.5 服务端

1. [server/src/validate.mjs](server/src/validate.mjs)
   - 独立实现 v2 校验：只接受 `formatVersion === 2`；`package.json` 清单字段；stable stringify integrity；activationEvents；contributes；limits；html 白名单。
   - 不要 import 应用源码（服务端是独立进程）；与共享实现保持同构，可参考 [src/shared/extensionPackage.ts](src/shared/extensionPackage.ts) 与 [src/shared/extensionFormat.json](src/shared/extensionFormat.json)。
2. [server/src/routes/packages.mjs](server/src/routes/packages.mjs)
   - `entryOf` 输出 `hasMain`、`displayName`、`activationEvents`、`capabilities`、`contributesSummary`；删除 `mainMode` / `hasRender` / `capability` / `permissions`。
   - 搜索参数改 `hasMain`。
   - 只处理 v2 信封。
3. 清空 `server/data` 里的 v1 开发数据（`packages.json` / `blobs/` 里的旧包）；用户/令牌文件保留。

### 5.6 README / 作者文档

重写 [README.md](README.md) 的插件相关章节（当前约 59k，第四/五/六节仍是 v1）：

- v2 `package.json` 清单示例；
- 扩展 ID 规则、`engines.imark`；
- `activationEvents` 支持列表；
- `contributes`：commands / keybindings / menus.commandPalette / configuration / `imark.lineMenu` / `imark.actions`；
- `require('imark')` API 摘要（commands / window / workspace / env / extensions / imark / Uri / Position / Range / EventEmitter / Disposable / TextEditor / WebviewPanel）；
- 宿主模式与 affinity（`isolated` / `shared` / `extensionHost.affinity`），明确 shared 的崩溃半径；
- 配置 / 密钥 / globalState / 输出日志 / webview 的写法；
- 构建与发布（`npm run plugins:build`、市场发布目录需含 `package.json`）；
- **完整信任警告**：扩展代码以当前用户权限运行，不做权限沙箱；只安装可信来源；
- 删除 node/restricted/render/capability 旧文档与 note-embed/todo-marks 示例。

### 5.7 阶段 6 验收

新增/重写三套：

1. `verify/market-v2-harness.ts`
   - 用 `packDirectory` 打包一个临时 v2 扩展目录（含 `package.json` + `main.js`）；
   - 校验 stable integrity、预览字段（`hasMain`、激活事件、贡献摘要）；
   - 通过 `service.installPackage` 安装，断言 `installed.json` v2 记录；
   - 构造/放入一份 v1 信封，断言 `formatVersion !== 2` 被拒绝；
   - 篡改文件字节/清单后 integrity 必须失败；
   - 纯声明扩展（无 `main`）预览 `hasMain === false`。
2. `verify/install-confirm-harness.ts`（重写）
   - 不打开界面，直接断言 `previewEnvelope` 的 v2 字段；
   - 含代码包 `hasMain === true` 且 `mainSha256` 非空；
   - 纯声明包没有 mainSha256、没有“以用户权限运行”确认项；
   - `PackagePreview` 不再含权限数组。
3. `verify/bundled-upgrade-harness.ts`（重写）
   - 预置 `installed.json` 记录 `imark.quick-edit` 为旧版本、`source: 'bundled'`；
   - 调 `ensureBundledProvisioned(service)`，断言升级到内置版本；
   - 预置一个 `source: 'market'` 的旧记录，断言**不被内置包覆盖**；
   - 全新 userData 调一次，断言三款都装上且 quick-edit 启用、git-sync/ai 默认关闭；
   - 重复调用幂等。

旧的 `market-search` / `market-detail` harness 目前是 v1 断言：要么改写成 v2（可以合并进 `market-v2`），要么删除，不能留着假装通过。

## 6. 阶段 7：清理与全量回归（已完成）

### 6.1 删除 v1 运行时与旧模型

按计划删除：

- `src/main/plugins/**`（host、api、contrib、ops、gate、script、renderLayer、capabilities、restrictedPage、installed、dev、registry、rendererBridge 等整目录）；
- `src/preload/plugin.ts`；
- `src/renderer/src/services/renderLayer.ts`、`pluginHostOps.ts`；
- `src/renderer/src/editor/pluginExtensions.ts`、`src/renderer/src/editor/pluginSdk.ts`；
- `src/shared/pluginApi.ts`、`src/shared/pluginPackage.ts`、`src/shared/pluginFormat.json`、`src/shared/pluginRpc.ts`（如仍被引用，一并改）；
- `plugins-src/note-embed/**`、`plugins-src/todo-marks/**`（源码当前已删除，确认无残留）；
- `plugins-src/restricted.d.ts`、`render.d.ts`、旧 tsconfig（当前 git 状态显示已删除，确认）；
- `src/main/market/builtin/{git-sync,quick-edit,ai-for-edit,note-embed,todo-marks}.imkpkg.json`（保留三份 `imark.*`）；
- 旧验收：`verify/{phase1,phase2,phase3,phase3-smoke,phase3-throttle,layers,plugin-ui,samples}-harness.ts`。

同时清理：

- `src/main/ipc.ts` / `src/preload/index.ts` / `src/shared/ipc-channels.ts` 中旧的插件 IPC 通道与类型；
- `src/renderer/src/services/pluginService.ts` / `pluginShape.ts` / `pluginStatus.ts` / `pluginUi.ts`：如果只服务旧模型就删，如果仍被 v2 设置页使用就改成 `ExtensionView`；
- [PluginSettings.vue](src/renderer/src/components/plugins/PluginSettings.vue) 已经是 v2 扩展设置页的话，确认不再 import v1 类型；否则按计划重写（宿主区、affinity、PID/内存、重新加载、隔离按钮）。

### 6.2 机械更新编辑器 harness

这些 harness 仍 import `../src/main/plugins/host`，阶段 7 必须改成 v2：

`autosave-modes`、`code-block`、`code-indent`、`cursor`、`editor-enter`、`image-paste`、`layers`、`math-block`、`mermaid`、`notification`、`perf`、`resizer-check`、`selprobe`、`session-restore`、`settings-system`、`table-render`、`tabs`、`bundled-upgrade`、`market-detail`、`market-search`、`phase1/2/3*`、`plugin-ui`、`samples`。

规则：

- 只调用 `initPluginHost()` 的：改成 `initExtensions()`；
- 调用 `initPluginHost(ensureBundledProvisioned)` 的：改成
  `const service = await initExtensions(); await ensureBundledProvisioned(service)`；
- 用到 `getPluginHost()` 的：改成 `getExtensionService()`；
- 用到 v1 插件 API/状态的（`phase*`、`layers`、`plugin-ui`、`samples`）：按计划删除，不要硬改；
- 退出时 `shutdownExtensions()` 替代旧的 `shutdownPluginHost()`（如果存在）。

### 6.3 全量验证

```bash
env -u ELECTRON_RUN_AS_NODE npm run typecheck
env -u ELECTRON_RUN_AS_NODE npx electron-vite build
```

然后后台逐个跑（按计划清单）：

```bash
extensions-model
extensions-host-groups
extensions-editor
extensions-webview
quick-edit
git-sync
git-sync-auth
git-sync-proxy
ai-for-edit
market-v2
install-confirm
bundled-upgrade
legacy-cleanup
```

再跑编辑器既有 harness（至少）：`editor-enter`、`table-render`、`code-block`、`code-indent`、`font-zoom`、`math-block`、`mermaid`、`tabs`、`session-restore`、`autosave-modes`、`notification`、`settings-system`、`image-paste`、`cursor`、`settings-reflow`、`userstyle-dir`、`data-dir`。

### 6.4 手工冒烟

构建后启动应用：

1. 设置页三款扩展可启用/禁用；禁用后命令、状态栏、行首菜单立即消失。
2. quick-edit 插入表格；AI 对话/生成/美化；git-sync 立即同步/定时同步。
3. 关闭再打开：聊天面板、窗口位置、配置、启用态恢复。
4. 从市场安装一个含代码扩展，确认框必须出现完整“以用户权限运行”警告；卸载后配置/密钥清理。
5. 打开扩展源码查看器，确认展示的是实际安装的 v2 包。
6. 设置页切换 isolated / shared、设置 affinity，确认宿主组成与 PID 变化，命令/状态栏/行首菜单仍正确路由。

## 7. 关键代码地图

### 扩展服务

- [src/main/extensions/service.ts](src/main/extensions/service.ts) — `initExtensions()` / `getExtensionService()` / `shutdownExtensions()`；公开方法：
  `getContributions()`、`listExtensions()`、`getExtensionView()`、`getExtensionViews()`、`getExtensionViewWithSecrets()`、`hostGroupsView()`、
  `installPackage()`、`uninstallExtension()`、`setEnabled()`、`setExtensionConfig()`、`setExtensionSecret()`、`executeCommand()`、
  `reloadExtension()`、`reloadHost()`、`setHostSettings()`、`getLogPath()`、`isActivated()`、`startup()`、`shutdown()`。
- [src/main/extensions/installer.ts](src/main/extensions/installer.ts) — `verifyExtensionPackage()`、`installExtensionPackage()`、`InstallExtensionOptions`。
- [src/main/extensions/installedStore.ts](src/main/extensions/installedStore.ts) — v2 `installed.json`（`{version:2, extensions:{...}}`）。
- [src/main/extensions/paths.ts](src/main/extensions/paths.ts) — `plugins/<publisher.name>/`、`extensions-data/<id>/`、`logs/extensions/<id>.log`。
- [src/main/extensions/legacy.ts](src/main/extensions/legacy.ts) — 阶段 5 的 v1 一次性清理；`legacyDataCleared: 2`。
- [src/main/extensions/hostPlanner.ts](src/main/extensions/hostPlanner.ts) — isolated / shared / affinity 分组。
- [src/main/extensions/hostProcess.ts](src/main/extensions/hostProcess.ts) — `utilityProcess.fork`、崩溃重启。

### 数据形状

- v2 清单/信封：[src/shared/extensionPackage.ts](src/shared/extensionPackage.ts)、[src/shared/extensionFormat.json](src/shared/extensionFormat.json)。
- 扩展视图 DTO：[src/shared/extensions.ts](src/shared/extensions.ts)。
- 扩展作者 API：[src/shared/extensionApi.ts](src/shared/extensionApi.ts)。
- 宿主协议：[src/shared/extensionProtocol.ts](src/shared/extensionProtocol.ts)。

### 设置与密钥

`settings.extensions[<id>] = { enabled, config }`；配置键是完整键（`imark.git-sync.targets`）。
`settings.extensionHost = { mode: 'isolated' | 'shared', affinity: Record<id, number> }`。
`settings.plugins` 是 v1 遗留，清理后为空，阶段 7 可从类型里删掉。
密钥文件：`<dataRoot>/secrets.json`；扩展密钥主进程侧 key = `<extensionId>:<key>`。
`@market:` / `@market-user:` 是市场命名空间，清理时**必须保留**。

### 三款官方扩展

- `plugins-src/quick-edit/` → `imark.quick-edit`
- `plugins-src/git-sync/` → `imark.git-sync`
- `plugins-src/ai-for-edit/` → `imark.ai-for-edit`
- 构建：`npm run plugins:build`，产出 `src/main/market/builtin/imark.*.imkpkg.json`。

## 8. 已知坑 / 已修过的问题（不要踩回去）

1. **扩展宿主的网络环境变量在 fork 时确定**。`HTTP_PROXY` 等必须在 `service.startup()` 之前设置到主进程环境；宿主之后改 env 不会生效。
2. **状态终报不能抹掉 `targetResults`**。[service.ts](src/main/extensions/service.ts) 的 `handleHostStatus` 已在消息不带 `targetResults` 时沿用上一次结果。改动时别退回“没有就清空”。
3. **`verify/run.mjs` 不重建 renderer/preload**。改 UI 后先 `npx electron-vite build`。
4. **`ELECTRON_RUN_AS_NODE`**：本机 shell 默认设置着它；跑 Electron 前 `env -u ELECTRON_RUN_AS_NODE`。
5. **v1 清理是一次性的**：`legacyDataCleared >= 2` 后不再扫描。清理逻辑只在 `ExtensionService.init()` 里调用一次。市场令牌 `@market:` 不在清理范围。
6. **官方内置包补装不要默认塞进 `initExtensions()`**：会污染合成扩展 harness。
7. **旧 `installed.json`（v1）** 被 `installedStore` 当作空表；清理会直接删除整个 v1 `plugins/` 根目录。
8. **不要提交 `.verify-ud/`、`out/`、`.imark/`**。
9. **不要在扩展侧或渲染层引入 `safeStorage`/明文密钥**。密钥只在主进程与宿主进程内。
10. **webview 的 token / 资源根校验**在 [src/main/extensions/webviewProtocol.ts](src/main/extensions/webviewProtocol.ts)，改市场/设置页时别绕过它。

## 9. 完成定义（DoD）

- [x] `npm run typecheck` 全绿。
- [x] `npx electron-vite build` 成功。
- [x] 三款官方扩展都能从全新 userData 自动补装；quick-edit 默认启用，git-sync/AI 默认关闭。
- [x] 市场能打包、预览、安装、更新、卸载 v2 扩展；v1 信封被明确拒绝。
- [x] 安装含代码扩展时必须勾选“以当前用户权限运行”的确认项。
- [x] 设置页、命令面板、状态栏、行首菜单、快捷键都从 `contributes` 驱动。
- [x] 13 套新验收 + 编辑器既有 harness 全绿（后台跑）；`table-render` 的既有失败/卡死见 §11。
- [x] `src/main/plugins/**`、旧 `pluginPackage`/`pluginApi`/`pluginFormat`、旧内置包、旧 harness 全部删除。
- [x] `note-embed` / `todo-marks` 在代码、内置包、文档里都没有残留（历史计划/交接文档与 legacy-cleanup harness 中的旧 ID 除外）。
- [x] README 已改成 v2 作者文档，并写明完整信任警告。

## 10. 下一条动作

阶段 6/7 已完成。后续只剩两件事：

1. **处理 `table-render` 的既有问题**（与插件系统无关）：
   - harness 里 2px 内边距 / <30px 行高的期望已与当前 CSS（8px / 34.9px）脱节；
   - 「两张表的文档 + 页面 reload」会让渲染进程 100% CPU。先用 `verify/twotable` 式的
     最小 harness 复现（启动直接打开两张表是正常的），再定位是 reload 时的表格 widget
     自动聚焦/测量循环，还是 harness 的等待时序。
2. 需要时把工作树提交（当前改动未提交）。

## 11. 阶段 6/7 完成记录（2026-10-21 续作）

### 阶段 6

- `src/shared/market.ts` 全部换成 v2 形状：`hasMain` / `main` / `activationEvents` /
  `capabilities` / `contributesSummary`；删除 `mainMode`、`hasRender`、`capability`、
  `permissions`、`newPermissions`、`renderSha256`。
- 主进程市场：`verify.ts` 委托 `verifyExtensionPackage`；`installer.ts` 调
  `service.installPackage()`；`pack.ts` 读 `package.json`；`publish.ts` / `updates.ts` /
  `registry.ts` / `source.ts` / `ipc.ts` 全部切 v2。`http.ts` 的上限改用 `EXTENSION_LIMITS`。
- `bundled.ts` 重写：三份 `imark.*` 包、并发复用 Promise、只升级 `source === 'bundled'`、
  quick-edit 默认启用 / 另两个默认关闭；`src/main/index.ts` 在 `buildAppMenu()` 前调用。
- 渲染层：marketService 改用 `ExtensionView` + `extensionStore`；已安装/详情/安装确认/
  发布/浏览/页面全部重写；含代码扩展必须勾选风险确认；筛选「全部 / 含代码 / 纯声明」。
  新增 `services/settingsNav.ts` 承担原 `pluginService.ts` 的导航职责。
- 服务端：`validate.mjs` 独立实现 v2 校验（stable stringify、package.json 清单、
  contributes/activationEvents/limits），`packages.mjs` 输出 v2 字段、搜索参数 `hasMain`。
- README 四/五/六节重写为 v2 作者文档；插件构建脚本已在本机跑通。

### 阶段 7

- 删除 `src/main/plugins/**`、`src/preload/plugin.ts`、`src/main/git.ts`、
  `src/shared/pluginApi.ts|pluginPackage.ts|pluginFormat.json|pluginRpc.ts`、
  渲染层 `pluginService.ts|pluginUi.ts|renderLayer.ts|pluginHostOps.ts`、
  `editor/pluginExtensions.ts|pluginSdk.ts`、旧内置包五份、旧 harness 十份。
- 清理旧 IPC 通道/类型/菜单栏（v1 Plugin* 全部移除）；`Settings.plugins` 从类型与
  默认值删除，`legacy.ts` 用 `dropLegacySettingsKeys(['plugins'])` 从磁盘删键。
- 编辑器和 UI harness 的初始化统一改为 `initExtensions({ appVersion: '0.1.0' })`；
  需要内置扩展的再调 `ensureBundledProvisioned(service)`。
- 顺手修了几个与本机平台/既有 UI 文案相关的 harness 期望：Windows `file://` 路径、
  标题字号阈值（1.125em）、设置页说明文案、data-dir 迁移项（`css/` 取代 v1 `plugin-ui.json`）。
- 新增 `verify/market-ui-harness.ts`：市场已安装列表、离线浏览、发布区块、扩展设置页、
  卸载两段式确认。
- **运行时启用扩展的补激活**：`service.onSettingsChanged` 现在会对「启动后才从关闭变成启用」
  且带 `*` / `onStartupFinished`（或当前有 Markdown 文档时的 `onLanguage:markdown`）
  的扩展立即 `activateExtension()`。没有这一步，AI for Edit 这类在 `activate()` 里创建
  状态栏与浮动 webview 的扩展，在设置页启用后要等下一次重启或命令触发才出现。
  `extensions-model` 的 `[5]` 已加回归断言。

### 已知遗留

- `table-render` 见 §10；其余 harness 均绿。
- `src/shared/plugins.ts` 仍保留少量 v1 时代命名（`PluginField` 等），但只包含 v2
  仍在使用的字段/目标/状态/日志类型，不是 v1 运行时。
- `plugins-src/dist/` 与 `.verify-ud/` 是本机产物，未提交。
