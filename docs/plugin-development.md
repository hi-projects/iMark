# 插件（扩展）开发文档

本文面向扩展作者，说明如何写一个 iMark 扩展：清单、入口、API、配置、webview、行首菜单、
Agent provider、构建与发布。系统内部实现见 [插件系统架构](plugin-system.md)。

> 术语：插件 = 扩展。代码里的类型、目录与 API 都叫 `Extension` / `extension`。

## 1. 快速开始

### 1.1 目录结构

```text
my-extension/
├── package.json     清单（唯一真身）
├── main.ts          可选入口 → 构建成 main.js（CommonJS）
├── webview/         可选：webview 的 ts / html / css
│   ├── chat.ts      → 构建成 webview/chat.js（IIFE）
│   └── shared.ts    共享模块，不作为入口
├── icon.svg         可选图标（PNG/SVG，≤128 KiB）
└── README.md        市场与详情页展示
```

纯声明式扩展（只贡献命令、配置、行首菜单，不需要执行代码）可以不写 `main`。

### 1.2 最小清单

```json
{
  "publisher": "your-name",
  "name": "my-extension",
  "version": "1.0.0",
  "displayName": "我的扩展",
  "description": "一句话说明",
  "engines": { "imark": "^1.0.0" },
  "main": "./main.js",
  "activationEvents": ["onCommand:your-name.my-extension.hello"],
  "capabilities": {},
  "contributes": {
    "commands": [
      {
        "command": "your-name.my-extension.hello",
        "title": "打招呼",
        "category": "示例"
      }
    ]
  }
}
```

### 1.3 入口

```ts
import * as imark from 'imark'

export function activate(context: imark.ExtensionContext): void {
  context.subscriptions.push(
    imark.commands.registerCommand('your-name.my-extension.hello', () => {
      imark.window.showInformationMessage('你好')
    })
  )
}

export function deactivate(): void {
  // context.subscriptions 上的东西会被自动 dispose；这里只做额外收尾
}
```

`require('imark')` 由宿主注入；扩展入口必须是 CommonJS（`.js` / `.cjs`），Node 内置模块可直接
使用。扩展代码跑在 `utilityProcess` 宿主里，**永远不在主进程**，也**没有权限沙箱**。

### 1.4 构建官方扩展

```bash
npm run plugins:build     # plugins-src/* → src/main/market/builtin/<id>.imkpkg.json
npm run typecheck:plugins
```

构建管线（[scripts/build-plugins.mjs](../scripts/build-plugins.mjs)）：

- `main.ts` → esbuild → CommonJS，`imark` 外置，Node 内置模块自动外置；
- `webview/*.ts` → esbuild → IIFE（依赖全部内联），`webview/shared.ts` 不作为入口；
- 静态资源原样复制；`package.json` 只进 `envelope.manifest`，不作为包内文件；
- 文本文件以 LF 进包，保证 Windows/Linux 构建逐字节一致；
- 官方扩展用一份 `plugins-src/tsconfig.json` 编译；第三方扩展可以自带构建，直接提供
  `main.js` 后用“从文件夹安装”或发布页打包；
- 打包前用与应用相同的 `validateManifest()` 校验，打包后用 `validateEnvelope()` 自检。

## 2. 清单参考

### 2.1 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `publisher` / `name` | ✔ | 各自 `^[a-z0-9][a-z0-9-]{1,63}$`；ID = `<publisher>.<name>` |
| `version` | ✔ | 语义化版本（可带预发布后缀） |
| `engines.imark` | ✔ | 宿主版本范围：`^1.0.0` / `>=1.0.0` / `>1.0.0` |
| `main` | | 包内 `.js` / `.cjs`；不填 = 纯声明式 |
| `displayName` / `description` / `author` / `license` | | 展示与署名 |
| `homepage` | | 必须是 https |
| `repository` / `bugs` | | 字符串或 `{ url }` 对象 |
| `icon` | | 包内相对路径；PNG/SVG，≤128 KiB |
| `activationEvents` | | 见 §2.2 |
| `extensionDependencies` | | 依赖的扩展 ID；强制同宿主并先激活 |
| `extensionAffinity` | | 希望与哪些扩展同宿主（参与 affinity 分组） |
| `capabilities` | | 安装披露，不是门禁 |
| `contributes` | | 贡献点，见 §2.3 |
| `categories` / `keywords` | | 市场展示 |

未知顶层字段会被拒绝。`scripts`、`devDependencies`、`dependencies`、`private`、`type`、
`files`、`publishConfig` 是构建字段，打包时剥掉，允许出现在源码 `package.json` 里。

### 2.2 激活事件

| 事件 | 何时激活 |
|---|---|
| `*` | 启动后（页面加载完成） |
| `onStartupFinished` | 同上，在 `*` 之后 |
| `onLanguage:markdown` | 打开 Markdown 文档时（当前编辑器只有一个语言，等价于启动后） |
| `onCommand:<命令>` | 命令被菜单/快捷键/命令面板触发时 |
| `onWebviewPanel:<viewType>` | 恢复该 viewType 的 webview 面板时 |

未知事件只产生警告，不阻止安装。没有命中的扩展保持未激活，不会 fork 宿主。

### 2.3 `contributes`

```json
{
  "commands": [],
  "keybindings": [],
  "menus": { "commandPalette": [] },
  "configuration": { "properties": {} },
  "imark.lineMenu": [],
  "imark.actions": [],
  "imark.agentProviders": []
}
```

- `commands[].command` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，同一清单内不能重复。
  建议使用 `<publisher>.<name>.<动作>`。
- `keybindings[].key` 形如 `ctrl+alt+s`，修饰键支持 `ctrl` / `cmd` / `alt` / `shift` / `super` /
  `meta`，也可写 `CmdOrCtrl`。与内置快捷键或更早的扩展冲突时，该条会被标为 `dropped`，
  命令仍可从命令面板执行。
- `menus.commandPalette[].when` 控制命令面板可见性；`when` 语法见 §6.4。
- `configuration` 见 §5。
- `imark.lineMenu` 见 §7。
- `imark.actions` 见 §8。
- `imark.agentProviders` 见 §10。

### 2.4 `capabilities`

```json
{
  "capabilities": {
    "filesystem": "workspace",
    "network": true,
    "secrets": true,
    "git": true,
    "process": true,
    "shell": true
  }
}
```

`filesystem` 取 `workspace`（只读写当前仓库）或 `user`（用户目录其它位置）。其余为布尔值。
这些值**只用于安装确认框的披露**，运行时不做拦截 —— 扩展代码始终拥有当前用户的完整权限。

## 3. 入口与生命周期

- `activate(context)`：第一次需要该扩展时调用。可以返回一个值，同一宿主内的依赖方可以通过
  `imark.extensions.getExtension(id).exports` 读取。
- `deactivate()`：宿主关闭、扩展被禁用/卸载/重载时调用；返回 Promise 时宿主会等待。
- `context.subscriptions`：把 `Disposable` 放进去，停用时自动清理；裸写的 `setTimeout` /
  `setInterval` 也会被宿主按扩展归属清理。
- 每次激活都会新建 API 对象与事件发射器，停用时会清掉该扩展注册的命令、状态栏、webview 等。
- 模块缓存只在“卸载”时清除；如果宿主进程没有退出，停用后再次启用可能复用同一份模块。
  因此模块顶层状态不可靠，跨激活要保留的东西放 `globalState` / `workspaceState`。

`ExtensionContext` 字段：

| 字段 | 说明 |
|---|---|
| `subscriptions` | 自动 dispose 列表 |
| `extensionPath` / `extensionUri` | 扩展目录 |
| `extensionMode` | 固定 `Production` |
| `extension` | `{ id, packageJSON, exports, isActive, activate(), deactivate() }` |
| `globalState` / `workspaceState` | 跨启动保留的键值状态 |
| `secrets` | 加密密钥存储（`get` / `store` / `delete` / `onDidChange`） |
| `globalStorageUri` / `storageUri` | 扩展私有目录 |
| `logUri` / `logPath` | 日志文件 |
| `asAbsolutePath(rel)` | 拼扩展目录内的绝对路径 |

## 4. API 参考

模块名是 `imark`，不是 `vscode`。完整类型见
[src/shared/extensionApi.ts](../src/shared/extensionApi.ts)。

### 4.1 `imark.commands`

```ts
registerCommand(command: string, callback: (...args: any[]) => unknown, thisArg?: unknown): Disposable
executeCommand<T = unknown>(command: string, ...args: unknown[]): Thenable<T>
getCommands(filterInternal?: boolean): Thenable<string[]>
```

`executeCommand` 的返回值必须可结构化克隆；不可克隆会报错，不会悄悄变成 `{}`。

### 4.2 `imark.window`

| API | 说明 |
|---|---|
| `showInformationMessage` / `showWarningMessage` / `showErrorMessage` | 带按钮时是模态队列；不带按钮时是右下角气泡。返回用户点中的按钮文本或 `undefined` |
| `showInputBox` | 文本 / 密码输入；返回字符串或 `undefined` |
| `showQuickPick` | 字符串数组或 `QuickPickItem[]`；支持 `canPickMany` |
| `createStatusBarItem(alignment?, priority?)` | 状态栏条目；每个扩展最多 5 条，全应用最多 12 条；文本上限 80 字 |
| `createOutputChannel(name)` | 写入扩展日志，支持 `append/appendLine/replace/clear/info/warn/error/debug/trace` |
| `createTextEditorDecorationType(options)` | 装饰类型；允许的 CSS 属性见 `DecorationRenderOptions` |
| `createWebviewPanel(...)` | 见 §9 |
| `registerWebviewPanelSerializer(viewType, serializer)` | 重启后恢复面板 |
| `showTextDocument(document, column?, preserveFocus?)` | 在编辑器中打开文档 |
| `activeTextEditor` / `visibleTextEditors` | 当前活跃 / 可见编辑器 |
| `activeColorTheme` / `onDidChangeActiveColorTheme` | 主题 |

状态栏 `text` 支持 `$(icon-name)` 形式的内置图标（白名单），颜色只能使用 `ThemeColor` 令牌。

### 4.3 `imark.workspace`

| API | 说明 |
|---|---|
| `workspaceFolders` / `name` | 当前仓库（单根；没有打开仓库时为 `undefined`） |
| `getConfiguration(section?)` | 读扩展配置；`get` / `has` / `inspect` / `update` |
| `onDidChangeConfiguration` | 配置变化；`affectsConfiguration(section)` 判断是否相关 |
| `onDidChangeWorkspaceFolders` | 切换仓库 |
| `onDidOpenTextDocument` / `onDidCloseTextDocument` / `onDidSaveTextDocument` / `onDidChangeTextDocument` | 文档事件 |
| `openTextDocument(uri?)` | 打开文件或创建内存文档（`{ language, content }`） |
| `saveAll(includeUntitled?)` | 保存所有脏文档 |
| `fs` | `file:` URI 的读写、stat、readDirectory、createDirectory、delete、rename |

`workspace.fs.delete` 的 `useTrash` 参数当前不会移到回收站，始终直接删除；需要回收站语义请用
应用自己的文件操作或提示用户。

### 4.4 `imark.extensions`

```ts
getExtension<T>(id: string): Extension<T> | undefined
all: readonly Extension<unknown>[]
```

`extension.exports` 是**进程内对象**，只有在同一个宿主里才能读到。要让两个扩展同宿主：
在清单里声明 `extensionDependencies`（依赖方）或 `extensionAffinity`。

### 4.5 `imark.env`

`appName`、`appVersion`、`language`、`uriScheme`、`machineId`、`sessionId`。

### 4.6 `imark.imark`（iMark 私有）

```ts
reportStatus(update: {
  status: 'idle' | 'running' | 'ok' | 'partial' | 'error'
  message?: string
  detail?: string
  targetResults?: Record<string, 'ok' | 'error'>
  lastRunAt?: number
}): void
renderMarkdown(markdown: string): Thenable<string>
flushActiveDocument(): Thenable<boolean>
onDidChangeTheme: Event<ColorTheme>
```

- `reportStatus` 把结果写进设置页的状态卡；`targetResults` 按目标 ID 合并，不会清空其它目标。
  动作结果只写状态卡，不要再弹通知。
- `renderMarkdown` 复用应用正文的 markdown-it（含 KaTeX / Mermaid / 链接校验）。
- `flushActiveDocument` 请渲染层把当前文档写盘，适合在读取文件前调用。

### 4.7 工具类

`Uri`（含 `parse` / `file` / `joinPath`）、`Position`、`Range`、`Selection`、`EventEmitter`、
`Disposable`、`ThemeColor`、`CancellationTokenSource`，以及
`StatusBarAlignment`、`ViewColumn`、`TextEditorRevealType`、`ConfigurationTarget`、`FileType`、
`ExtensionMode`、`ColorThemeKind` 等枚举。

与 VS Code 的差异：

- 模块名是 `imark`；
- 没有 TreeView / 终端 / 任务 / 调试 / LSP / notebook / 多根工作区；
- `imark` 命名空间是本应用私有入口；
- `workspace.fs` 只支持 `file:` URI；
- `TextEditor.hide()` 不会隐藏用户的标签（由渲染层决定）。

## 5. 配置、密钥与状态

### 5.1 `contributes.configuration`

```json
{
  "contributes": {
    "configuration": {
      "title": "我的扩展",
      "properties": {
        "your-name.my-extension.greeting": {
          "type": "string",
          "default": "你好",
          "title": "问候语",
          "description": "显示在打招呼消息里",
          "imark": { "kind": "text", "section": "常规" }
        }
      }
    }
  }
}
```

规则：

- 键必须以 `<扩展 ID>.` 开头（卸载时按前缀清理配置，否则会误删别人的设置）。
- 每个属性必须有 `default`（设置页拿它当初始值）。
- 支持 `type`：`string` / `number` / `integer` / `boolean` / `array` / `object`；
  `enum` + `enumDescriptions`、`minimum` / `maximum`。
- `configuration` 可以是单个对象，也可以是多个 section 的数组。

`imark` 元数据（均可选）：

| 字段 | 说明 |
|---|---|
| `kind` | 字段形态：`text` / `textarea` / `password` / `number` / `boolean` / `select` / `list` / `targets` / `endpoints` / `external` |
| `label` | 字段标题；缺省用 `title` 或短键名 |
| `description` | 字段说明 |
| `section` | 分组标题；相邻同名字段归到一组 |
| `showWhen` | `{ key, value }`，另一个字段等于该值时显示 |
| `rows` | textarea 显示行数 |
| `resettable` | 显示“恢复默认”图标 |
| `required` | 文本失焦为空时自动恢复默认 |
| `placeholder` | 输入框占位文本 |
| `options` | select 的 `{ value, label }[]`；优先于 `enum` 的标签 |
| `endpointModel` | `endpoints` 每行的模型输入说明 |
| `targetSecret` | `targets` / `endpoints` 每行独立密钥的标签与占位 |
| `scope` | `global`（默认）或 `workspace` |
| `file` / `dirEnv` / `pointer` / `secret` | 仅 `kind: "external"`，见 §5.3 |

### 5.2 读取与保存范围

```ts
const config = imark.workspace.getConfiguration('your-name.my-extension')
const greeting = config.get<string>('greeting', '你好')
await config.update('greeting', 'hi')
```

- 宿主拿到的是**已合并**的生效值：清单默认值 ← 全局值 ← 当前仓库覆盖值。
- `scope: "workspace"` 的字段：设置页修改写进当前仓库的覆盖层；未覆盖时回落到全局值。
  密钥始终全局。
- `config.inspect('greeting')` 可以分别看到 `defaultValue` / `globalValue` / `workspaceValue`。
- 保存按钮只提交单个字段，不会把继承值固化进覆盖层。

### 5.3 `kind: "external"`：直接读写包外 JSON

用于编辑其他工具自己的配置文件（例如 `~/.claude/settings.json`）。唯一事实是那个文件：

```json
{
  "type": "string",
  "default": "",
  "imark": {
    "kind": "external",
    "file": "~/.claude/settings.json",
    "dirEnv": "CLAUDE_CONFIG_DIR",
    "pointer": "/env/ANTHROPIC_BASE_URL",
    "secret": true
  }
}
```

- `file`：支持 `~`，且必须在用户目录内（或由 `dirEnv` 指定）；
- `dirEnv`：环境变量存在时，用它替换文件的父目录；
- `pointer`：JSON 指针，如 `/env/ANTHROPIC_BASE_URL`；
- `secret`：输入框按密码显示。

渲染层只提交扩展 ID 与字段短键；路径解析、指针写入与“其它字段原样保留”都在主进程完成。

### 5.4 密钥

```ts
await context.secrets.store('apiToken', token)
const token = await context.secrets.get('apiToken')
await context.secrets.delete('apiToken')
```

- 值经 Electron `safeStorage` 加密后存 `secrets.json`，主进程与宿主内存之外没有明文。
- 设置页只显示掩码；扩展自己可以读明文。
- `password` 字段与 `targets` / `endpoints` 的目标级密钥都由宿主按槽位管理：
  `<id>:<field>` 或 `<id>:<field>:<targetId>`；账号密码认证另开 `<targetId>#password` 槽，
  切换认证方式不会互相覆盖。

### 5.5 状态、存储与日志

```ts
context.globalState.update('lastRun', Date.now())
context.workspaceState.update('cursor', position)
await imark.workspace.fs.writeFile(
  imark.Uri.joinPath(context.globalStorageUri, 'cache.json'),
  new TextEncoder().encode('{}')
)
```

- `globalState` / `workspaceState` 由主进程防抖写盘，退出前 flush。
- `globalStorageUri` / `storageUri` 目录在激活前创建。
- `window.createOutputChannel(name)` 的写入进扩展日志；设置页可直接打开日志文件。

## 6. 文档、编辑器与装饰

### 6.1 打开与编辑

```ts
const doc = await imark.workspace.openTextDocument(
  imark.Uri.joinPath(imark.workspace.workspaceFolders![0].uri, 'note.md')
)
const editor = await imark.window.showTextDocument(doc)
const ok = await editor.edit(edit => {
  edit.insert(new imark.Position(0, 0), '# 标题\n')
})
```

- `edit()` 在宿主内收集修改，排序后拒绝重叠区间；渲染层按 `expectedVersion` 校验，
  版本不连续时返回 `false`，扩展应重新读取文档再试。
- 同一个文档的 `TextDocument` 是镜像；只有渲染层发出变更后它才更新。
- 需要确保磁盘是最新内容时，先 `await imark.imark.flushActiveDocument()`。

### 6.2 选区与显示

```ts
editor.setSelection(new imark.Position(3, 0))
editor.revealRange(new imark.Range(3, 0, 3, 10), imark.TextEditorRevealType.InCenter)
```

`setDecorations` 的样式只允许白名单属性（背景色、边框、文字颜色/装饰、字重/斜体、整行）。

### 6.3 文档事件

`onDidChangeTextDocument` 携带 `contentChanges`（`range`、`rangeOffset`、`rangeLength`、`text`）。
版本不连续且没有全量文本时，宿主会向主进程请求整篇文档并重发一次全量变化。

### 6.4 `when` 子句

支持：

```text
expr      := or
or        := and ( '||' and )*
and       := unary ( '&&' unary )*
unary     := '!' unary | primary
primary   := '(' expr ')' | comparison | value
comparison:= value ( '==' | '!=' ) value
value     := key | string | number | true | false
```

上下文键由宿主提供：`hasEditor`、`hasVault`、`isDirty`、`editorFocus`、`editorTextFocus`、
`resourceLangId`、`workspaceFolderCount`。未定义的键为假。不支持 `=~`、`in` 与数组。

## 7. 行首“+”菜单

```json
{
  "imark.lineMenu": [
    {
      "id": "table",
      "label": "表格",
      "command": "your-name.my-extension.insert-table",
      "dialog": {
        "title": "插入表格",
        "confirmLabel": "插入",
        "fields": [
          { "key": "rows", "kind": "number", "label": "行数", "default": 3, "min": 1, "max": 50 },
          { "key": "cols", "kind": "number", "label": "列数", "default": 3, "min": 1, "max": 20 }
        ]
      }
    }
  ]
}
```

- 菜单条目由宿主绘制；`command` 必须先在 `contributes.commands` 里声明。
- `dialog.fields` 只允许 `text` / `number` / `boolean` / `select`，必须有 `default`。
- 对话框确认后，命令回调收到 `{ values, line, source: 'lineMenu' }`，`line` 是 1 基行号。
- 所有扩展的条目合进同一个“+”菜单；`label` 最长 40 字，单条 dialog ≤4 KiB，合计 ≤16 KiB。

## 8. 设置页动作

```json
{
  "imark.actions": [
    { "command": "your-name.my-extension.sync", "label": "立即同步", "scope": "global", "primary": true },
    {
      "command": "your-name.my-extension.testTarget",
      "label": "测试连接",
      "scope": "target",
      "targetSetting": "your-name.my-extension.targets"
    }
  ]
}
```

- `scope: "global"`：设置页上的全局按钮；
- `scope: "target"`：`targetSetting` 指向一个 `targets` / `endpoints` 配置键，按行执行；
- `primary: true` 让按钮用强调色；
- 动作结果用 `imark.reportStatus()` 写进状态卡，可带 `targetResults` 逐行着色。

## 9. webview

```ts
const panel = imark.window.createWebviewPanel(
  'your-name.my-extension.chat',
  '我的面板',
  { viewColumn: imark.ViewColumn.One },
  {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
    imark: { presentation: 'sidebar', width: 420 }
  }
)

const scriptUri = panel.webview.asWebviewUri(
  imark.Uri.joinPath(context.extensionUri, 'webview', 'chat.js')
)

panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;">
</head>
<body><div id="root"></div><script src="${scriptUri}"></script></body>
</html>`

panel.webview.onDidReceiveMessage(message => { /* … */ })
panel.webview.postMessage({ type: 'hello' })
```

要点：

- webview 跑在 `imark-webview://<extensionId>` 的独立 origin 与独立 session 里，与宿主隔离；
  只能通过 `postMessage` 通信。
- `localResourceRoots` 之外的路径会被协议层拒绝；包内资源用 `asWebviewUri()` 转成可加载 URL。
- CSS / 字体 / 图片也要在 CSP 里放行 `panel.webview.cspSource`。
- 渲染层在页面 `postMessage({ type: 'imark:ready' })` 后才投递消息；之前的消息会排队。
- 应用会发送 `imark:bootstrap`（含 `panelId`、`extensionId`、`theme`）与 `imark:theme`
  （主题变量）；主题变量的 `colors` 是一组 `--*` CSS 自定义属性，页面可自行注入到
  `document.documentElement`。
- `presentation` 支持 `sidebar` / `overlay` / `floating`，运行时可用
  `panel.imark.setPresentation/setSize/setPosition` 调整，`setStatus('idle' | 'busy')`
  控制标题栏状态点。
- 用 `registerWebviewPanelSerializer(viewType, serializer)` 在重启后恢复面板；
  `webview.getState()` / `setState()` 随面板元数据持久化。
- 卸载扩展时主进程会删除它的面板记录；HTML 不持久化，恢复时由序列化器重新生成。

## 10. Agent provider 扩展

Agent Core（`imark.agent`）不认识具体后端。后端扩展必须：

```json
{
  "main": "./main.js",
  "extensionDependencies": ["imark.agent"],
  "contributes": { "imark.agentProviders": ["my-backend"] },
  "activationEvents": ["onCommand:your-name.my-agent.check"]
}
```

```ts
import {
  AGENT_PROVIDER_API_VERSION,
  type AgentProvider,
  type AgentProviderModule
} from '@shared/agentProvider'

export function activate(): AgentProviderModule {
  const provider: AgentProvider = {
    info: {
      id: 'my-backend',
      label: '我的后端',
      capabilities: {
        inputs: { image: 'none', pdf: 'none', file: 'path' },
        tools: { read: true, bash: false, write: false },
        streaming: true,
        thinking: false,
        resume: false,
        systemPrompt: true
      }
    },
    async detect(options) {
      return { available: true, version: '1.0.0' }
    },
    async createSession(options) {
      return {
        providerSessionId: undefined,
        async *send(turn) {
          yield { type: 'text', delta: '你好' }
          yield {
            type: 'result',
            text: '你好',
            isError: false
          }
        },
        respondPermission(requestId, decision) {
          // 回应 `permission` 事件；回合结束后应静默忽略
        },
        cancel() {},
        async dispose() {}
      }
    }
  }
  return { apiVersion: AGENT_PROVIDER_API_VERSION, providers: [provider] }
}
```

约束：

- 贡献点必须是非空数组（≤8），ID 形如 `my-backend`；清单必须声明 `main` 并依赖
  `imark.agent`，否则校验/安装会被拒绝。
- `extensionDependencies` 同时保证同宿主与 Core 先激活；`exports` 不能跨宿主。
- provider 不需要 `activationEvents`，Core 在第一次列后端时惰性 `activate()`；
  如果自己提供设置页动作，再声明对应的 `onCommand:<命令>`。
- provider 自己读取配置与密钥；Core 只传 `hostSessionId`、`providerSessionId`、`cwd` 与
  `AbortSignal`。
- `AgentEvent`：`session`、`text`、`thinking`、`tool`（start/result）、`status`、`notice`、
  `permission`、`result`、`error`。`result` 必须给出最终文本与 `isError`。
- 需要用户授权时发 `permission`，等待 Core 调用 `respondPermission(requestId, 'allow' | 'deny')`；
  回合已结束时静默忽略。
- 附件只给路径，provider 自行读取；当前文档由用户主动“＋ 本文档”加入会话。

完整类型见 [src/shared/agentProvider.ts](../src/shared/agentProvider.ts)，参考实现见
[plugins-src/claude-code/provider.ts](../plugins-src/claude-code/provider.ts)。

## 11. 构建、打包与发布

### 11.1 官方扩展构建

```bash
npm run plugins:build
npm run typecheck:plugins
```

产物是 `src/main/market/builtin/<publisher>.<name>.imkpkg.json`，应用启动时补装。构建脚本会：

- 用与应用相同的校验器校验清单；
- 把 `main.ts` 打成 CommonJS，`webview/*.ts` 打成 IIFE；
- 复制静态资源、LF 归一、计算逐文件 sha256 与整包 integrity；
- 对 `imark.agent` 额外注入系统提示词默认值与 KaTeX 样式/字体；
- 最后用 `validateEnvelope()` 自检，失败则构建失败。

### 11.2 打包任意目录

设置 → 扩展 → “从文件夹安装”/发布预览会用 `packDirectory()` 打包：

- 只收 JS 与静态资源；**不编译 TypeScript** —— 用 TS 写的扩展先自行编译；
- 跳过 `node_modules`、`dist`、`.git`、`.github`、`.vscode`、`.cache`；
- 跳过 `package.json`、`*.ts`、`*.map`；
- 清单在目录根部的 `package.json`。

### 11.3 发布到市场

1. 在设置 → 扩展市场配置服务地址（默认 `http://127.0.0.1:8787`，可用 `npm run market` 启动）。
2. 注册/登录账号。
3. “发布扩展”页选目录 → 预览（文件清单、形态、体积、整包 sha256、入口 sha256、激活事件、
   贡献摘要）。
4. 发布。服务端重算逐文件 sha256 与 integrity，不符返回 400；`<publisher>.<name>` 首次发布
   即被账号认领；同一 `(id, version)` 不能重发（409）；已发布版本不可变，要改就升版本号。
5. 版本可以下架；下架后从搜索/最新版/版本列表消失，但按精确版本仍可下载。

## 12. 调试与验收

- **日志**：设置 → 扩展 → 选中扩展 → “打开日志”；日志在
  `<数据根>/logs/extensions/<id>.log`。
- **状态**：设置页显示宿主 PID、内存、激活状态、最近一次错误；可“重新加载扩展”或
  “重新加载宿主”。
- **配置**：设置页表单由清单自动渲染；改完立即推给宿主。
- **源码**：市场详情页“查看源码”展示的字节与安装的是同一份。
- **验收**：`verify/` 下有 `quick-edit`、`agent`、`market-package`、`install-confirm`、
  `bundled-upgrade`、`extensions-*` 等 harness：

  ```bash
  node verify/run.mjs quick-edit
  node verify/run.mjs agent
  node verify/run.mjs market-package
  ```

  改过 preload 或渲染层后先跑 `npx electron-vite build`，否则 harness 用的是旧产物。

### 常见错误

| 现象 | 原因 |
|---|---|
| 安装被拒：“不认识的清单字段” | `package.json` 有未知顶层键；构建字段之外一律不允许 |
| “扩展不兼容” | `engines.imark` 不满足当前应用版本 |
| “依赖的扩展未安装/已禁用” | `extensionDependencies` 未满足；启用/安装顺序不对 |
| 命令不出现 | 没有在 `contributes.commands` 声明；扩展未启用；激活事件没命中 |
| 快捷键不生效 | 与内置快捷键或更早的扩展冲突，被标为 `dropped`；命令面板仍可执行 |
| `edit()` 返回 false | 文档版本不连续（用户在扩展编辑期间继续输入），重读文档再试 |
| webview 白屏 | CSP 没放行 `cspSource`；资源不在 `localResourceRoots`；忘了 `asWebviewUri` |
| webview 收不到消息 | 页面没有先 `postMessage({ type: 'imark:ready' })` |
| provider 不出现 | `apiVersion` 不是 2；没依赖 `imark.agent`；没声明 `imark.agentProviders` |

## 13. 安全提醒

扩展代码以**当前用户权限**运行：可以读写任意文件、发起网络请求、启动其他程序。清单里的
`capabilities` 只是安装确认框的披露，不是沙箱。发布与安装前请确认：

- 只安装可信来源的扩展；
- 需要执行代码的扩展，安装时会被要求主动勾选风险确认；
- 市场安装会校验整包 integrity 与逐文件 sha256，但这只防篡改，不防作者本身；
- 扩展的 webview 与应用隔离，但扩展宿主本身没有 OS 级沙箱。
