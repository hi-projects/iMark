# iMark

基于 **CodeMirror 6 + Electron + Vue 3** 的所见即所得(Obsidian Live Preview 风格)Markdown 编辑器。

作者:**Chuxiao Xiang** <13439022108@163.com>

## 功能

- **所见即所得编辑**:语法树驱动的装饰层——光标不在节点上时自动隐藏 `**`、`` ` ``、`#`、`](url)` 等标记,内容按样式渲染;光标进入即显形为原始语法。表格、图片、公式这类「有形态的内容」直接渲染成真元素(表格连列对齐都按分隔行里的 `:` 还原)
- 标题(H1–H6)、粗体、斜体、删除线、行内代码、引用、无序/有序列表、分隔线
- 任务列表(可点击 checkbox,直接改写源码,可撤销)
- 代码块嵌套语言高亮(`@codemirror/language-data` 按需加载)
- **LaTeX 公式**(KaTeX 渲染):行内 `$E = mc^2$`、块级 `$$...$$`(支持跨行,居中显示);光标移入公式即翻回源码编辑,移出即恢复渲染;代码块内的 `$` 不受影响;导出 HTML 同样带公式
- 链接 Ctrl+点击在系统浏览器打开;图片(本地相对路径走 `imark://` 自定义协议)光标外直接渲染
- 文件:新建 / 打开 / 保存 / 另存为 / 拖拽 `.md` 入窗打开,窗口标题未保存圆点,关闭前脏检查
- **仓库(Vault)工作流**(仿 Obsidian):启动先进入 **仓库选择界面** —— 最近仓库列表(可移除记录)+「打开文件夹作为仓库」+「创建新仓库」;选定后进入编辑器
  - 文件浏览器侧栏(Ctrl+Shift+L):树形目录、新建文件/文件夹、重命名、删除(移到系统回收站)、刷新
  - 快速切换文件(Ctrl+P):全仓库模糊搜索,↑↓ 选择、Enter 打开
  - 状态栏左侧显示当前仓库名,点击回到仓库选择界面切换(有未保存内容时先询问)
  - 仓库选择界面底部可勾选「启动时直接打开上次使用的仓库」以跳过选择步骤
- **插件系统**:插件是**可装可卸可升级的包** —— 两种形态:**脚本插件**(包内 `main.js`,主进程执行)与**声明式插件**(不含代码,只绑定内置能力,如 Webhook 推送)。设置面板「插件」分类统一管理:启用/停用、按字段表自动渲染配置表单、动作按钮、运行状态与错误详情;密钥类字段经 Electron safeStorage 加密后单独存于 `userData/secrets.json`,**渲染层永远拿不到明文**
  - **定时上传(Git)**:市场里的官方插件(应用内置同一份包作离线兜底)——按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意 Git 远端,可配置**多个远端**(一次提交推全部);另有「立即上传」「测试连接」动作,以及状态栏同步图标(成功/失败/进行中/未启用四态)。同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交
  - **快速编辑(Quick Edit)**:同样是随应用预装、且**默认启用**的官方插件。光标所在行的左侧有一个「+」,点开 →「表格」→ 填行数与列数 → 确定,表格就插在这一行下面,光标落在第一个表头单元格里。它也是「插件怎么往界面里加东西」的样板:按钮、菜单、对话框与插入全部由宿主实现,插件只声明菜单条目并返回要插入的文本(见 §四)
- **插件市场**:仓库内自带零依赖自托管服务端(`npm run market`),应用里填地址即可**浏览 / 搜索 / 安装 / 查更新 / 发布**;安装前有安全基线确认框(逐条中文权限解释、体积、可跨渠道核对的 sha256、来源与发布者,脚本插件须勾选「我已了解风险」),并可**先查看源码**。详见下文「五、插件市场」
- 无菜单栏界面(仿 Obsidian):原生菜单只是隐藏(`setMenuBarVisibility(false)`),Ctrl+N/O/S、Ctrl+P、Ctrl+J、F12 等加速键照常生效,按 Alt 也不会弹出;切勿改成 `Menu.setApplicationMenu(null)`,那会让加速键一起失效
- 主题:亮色 / 暗色 / 纯黑三档,状态栏一键循环切换,或在 **设置面板**(状态栏齿轮 / `Ctrl+,`)的「外观」中挑选;持久化到 `userData/settings.json`
- 状态栏字数统计(中文按字、拉丁按词)、导出 HTML(markdown-it + highlight.js 内联样式)

## 开发

```bash
npm install
npm run dev        # 启动开发模式(HMR)
```

```bash
npm run typecheck  # tsc(node 侧)+ vue-tsc(渲染层)
npm run build      # 构建三端产物到 out/
npm run dist       # 构建 + electron-builder 打 NSIS 安装包
```

## 环境要求

- **Node ≥ 22.12**(本机使用 `D:\software\nodejs\v24.21.0`)。Electron 40 起的安装链(`@electron/get` 5 / `@electron-internal/extract-zip`)与 electron-builder 26 的部分依赖均为 ESM-only,Node < 22.12 时需降级 electron ≤ 39 / electron-builder 25。
- `.npmrc` 已配置国内镜像(registry / electron / electron-builder-binaries)。
- 在 `ELECTRON_RUN_AS_NODE=1` 的 shell 中运行 `npm run dev` 会以纯 Node 模式拉起应用而报错,需 `env -u ELECTRON_RUN_AS_NODE npm run dev`。
- shell 的 `TEMP` 指向 `C:\WINDOWS\TEMP` 时,NSIS 打包会报 `!include: could not find ...nstXXX.tmp`,构建前把 `TMP`/`TEMP` 覆盖为用户临时目录(`%LOCALAPPDATA%\Temp`)。
- `electron-builder.yml` 中 `signAndEditExecutable: false` 是为绕过 winCodeSign 解压需要符号链接权限的问题;启用 Windows 开发者模式(或管理员终端)后可移除该项,以获得自定义图标与 exe 元数据。

## 跨平台(Windows / Linux / arm64)

代码本身跨平台,路径判断统一走 `src/renderer/src/utils/paths.ts`(`isInside` / `relativeTo`),不写死分隔符。

- **换平台要重装依赖**:`node_modules` 里的 Electron 是平台 + 架构相关的,在目标机上 `npm ci` 会拉对应的包(含 Linux arm64)。
- **打包**:`npm run dist` 按当前系统出包;也可显式 `npm run dist:win`(NSIS)与 `npm run dist:linux`(AppImage + deb)。
- **Linux / Jetson Orin 注意**:
  - 需要桌面会话(X11 / Wayland),纯 SSH 无头环境起不来。
  - 部分主板(含部分 Jetson)Chromium 沙箱受限,起不来时用 `ELECTRON_DISABLE_SANDBOX=1`(开发与打包后都适用)。
  - 没有桌面密钥环(gnome-keyring / kwallet)时 `safeStorage` 不可用,插件里的访问令牌会**降级为明文**存进 `secrets.json`(界面上暂无提示)—— 在意的话别在无密钥环的机器上保存令牌。
  - 「删除到回收站」依赖 XDG trash 实现,极简系统上可能失败。

## 技术架构

### 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面容器 | **Electron 44** | 主进程 / 预加载 / 渲染进程三段式;`sandbox: true` + `contextIsolation`,渲染层只能通过 `contextBridge` 暴露的 `window.api` 访问系统能力 |
| 构建 | **electron-vite 3 + Vite 6** | 三端统一构建;主进程/预加载外部化依赖,渲染层 HMR |
| UI | **Vue 3.5**(`<script setup>`)+ **TypeScript 5.9** | 状态用普通 `reactive` 轻量 store,不引 Pinia |
| 编辑器内核 | **CodeMirror 6**(`@codemirror/state` / `view` / `commands` / `language`) | 增量解析 + 装饰系统 |
| Markdown 语法 | **@codemirror/lang-markdown** + **@lezer/markdown**(GFM) | 提供 Lezer 语法树,是整个所见即所得的地基。注意 `markdown()` 的 base 必须显式传 `markdownLanguage`——它的默认值是 `commonmarkLanguage`,那样任务列表/删除线/表格等 GFM 节点根本不会出现在语法树里 |
| 代码高亮 | **@codemirror/language-data** + **@lezer/highlight** | 代码块内按语言动态加载高亮 |
| 数学公式 | **KaTeX 0.19** | 同步渲染、无网络依赖(字体随构建产物打包) |
| 导出 | **markdown-it 14** + **highlight.js 11** | 仅用于导出 HTML,与编辑器内核解耦 |
| 图标 / 打包 | **lucide-vue-next** / **electron-builder 26** | |

```
src/
├── shared/     # 主/渲染共用:IPC 通道常量、类型、window.api 接口
├── main/       # 主进程:窗口、IPC、原生菜单、文件原子写、settings、imark:// 协议
├── preload/    # contextBridge 暴露 window.api(sandbox 模式)
└── renderer/
    └── src/
        ├── styles/           # ★ 样式模块:统一装配入口 + 插件样式注册表(见下)
        ├── editor/wysiwyg/   # ★ 核心:语法树 → 装饰(build/rules/widgets/selection)
        ├── editor/           # 编辑器组装、格式命令、键位、大纲、LaTeX 语法扩展
        ├── components/       # SettingsDialog / FileExplorer / OutlineSidebar / EditorPane / StatusBar
        ├── services/         # 文件流程编排、仓库流程、导出 HTML
        └── stores/           # reactive 轻量状态
```

### 一、Markdown 编辑器:语法树驱动的所见即所得

**核心思路**:文档始终是纯 Markdown 源码(不建富文本模型),「所见即所得」由一层**装饰(Decoration)**实现——当光标不在某个语法节点上时,把 `**`、`` ` ``、`#`、`](url)` 这类标记字符用 `Decoration.replace` 隐藏、把内容用 `Decoration.mark` 上样式,需要真实交互的元素(复选框、图片、公式)用 `Decoration.replace({widget})` 换成 DOM。光标移入节点,标记立刻复原为源码。这与 Obsidian 的 Live Preview 是同一机制,也是 CodeMirror 作者推荐的实现路径。

**数据流**(`src/renderer/src/editor/wysiwyg/`):

```
Lezer 语法树(增量解析,行内节点按视口惰性解析)
   ↓  仅在 docChanged / viewportChanged / selectionSet 时重建
单个 ViewPlugin 遍历 view.visibleRanges
   ↓  按节点名分发
Decoration.mark / Decoration.replace / Decoration.replace({widget})
   ↓
RangeSet(Decoration.set)  +  EditorView.atomicRanges
```

**关键设计决策**:

- **用 ViewPlugin 全量重算,而不是 StateField 做增量映射**:所有隐藏类装饰都依赖「光标在哪」,拆层没有收益;每轮从事务后的状态重建,天然规避 undo/redo 与复杂变更下的 RangeSet 位置映射问题(视口级重算约百行,单次击键 < 1ms)。
- **选区相交用闭区间判定**(`r.from <= to && r.to >= from`):光标恰好贴在标记边界时也算「相交」、标记保持可见——否则光标贴边会造成标记忽隐忽现。
- **`atomicRanges`**:所有 replace 区间同时注册为原子区间,方向键与鼠标点击整体跳过,光标不会卡进不可见的标记字符里。
- **中文输入保护**:`view.composing === true` 期间跳过重建,避免输入法组合过程中装饰重排打断候选窗。
- **行内解析惰性**:语法树的行内节点按视口惰性解析;未就绪时先 `ensureSyntaxTree` 有界强解析,仍不可用则跳帧重试。
- **跨行块(块级公式、表格)的渲染手法**:CM6 **不允许插件提供跨行的 `replace` 装饰**(`remap()` 里还会在中文输入期间主动丢掉跨行的那些),而这类语法天生多行。做法是只替换**首行**成一个承载整块内容的 widget,其余行清空内容并加 `cm-md-*-void` 折算成零高度(`line-height: 0` + `font-size: 0` + `min-height: 0`,高 0 是被 DOM 实测确认过的)。配套的**视口守卫**不能省:首行不完整落在视口内时整块退回源码态——否则首行的 widget 根本没被渲染,而后面几行照样被清空,屏幕上就是一块空白。

**实现文件**:

| 文件 | 职责 |
|---|---|
| `editor/wysiwyg/build.ts` | ViewPlugin 主体:视口遍历、语法树可用性检查、装饰集构建、Ctrl+点击链接 |
| `editor/wysiwyg/rules.ts` | **节点名 → 装饰策略**的唯一分发表(标题/强调/代码/链接/图片/公式/任务列表…) |
| `editor/wysiwyg/widgets.ts` | `WidgetType` 实现:复选框、图片、水平线、公式、表格 |
| `editor/wysiwyg/inline.ts` | 行内片段渲染(表格单元格用);**刻意不复用 `services/exportHtml.ts`** —— 那个模块顺带牵连 katex 与 highlight.js,编辑器不该依赖导出服务,但两者的 markdown-it 配置必须保持一致 |
| `editor/wysiwyg/selection.ts` | 闭区间相交判定(行内粒度 / 行粒度) |
| `editor/setup.ts` | 扩展组装(换行、历史、markdown、WYSIWYG、键位、主题) |

### 二、LaTeX 渲染

**解析层——自定义 Lezer 行内解析器**(`editor/math.ts`)

没有用正则扫描文本,而是给 `@lezer/markdown` 写了一个行内解析器扩展(`parseInline`),产出 `InlineMath` / `DisplayMath` 节点及 `MathMark` / `MathContent` 子节点。这样免费获得正确的上下文:代码块与行内代码里的 `$` 天然不会被误判,`\$` 转义由 Escape 解析器处理,公式内容也不会被 `*`/`_` 的强调解析拆开(解析器注册在 `Emphasis` 之前)。

```ts
markdown({ codeLanguages: languages, extensions: mathExtension })
```

**渲染层——KaTeX widget**

光标在公式之外时,整个 `$...$` / `$$...$$` 区间被替换成 `MathWidget`,`toDOM` 内调用

```ts
katex.render(tex, el, { displayMode, throwOnError: false, output: 'html', trust: false })
```

`throwOnError: false` 让错误公式显示为红色提示而不是抛异常;`trust: false` 禁止 `\href` 之类的命令。widget 的 `eq()` 比较 tex 与 displayMode,内容没变就不重渲染。KaTeX 的 CSS 与字体随构建产物打包(渲染进程直接 `import 'katex/dist/katex.min.css'`),编辑期不依赖网络。

**块级公式的跨行难题**

CodeMirror 明确禁止插件提供跨行的 replace 装饰(`Decorations that replace line breaks may not be specified via plugins`),而 `$$...$$` 通常写成多行。这里采用**逐行处理**绕过该限制:

```
$$                    ← 首行:整行内容替换为 MathWidget(display 模式,居中)
\int_0^1 x^2\,dx      ← 内容行:清空内容 + Decoration.line 折叠高度(line-height: 0)
$$                    ← 尾行:同内容行
```

既不影响文档行数(光标可正常上下移动),又让公式在编辑区内独占一行居中显示;只有单行写法 `$$E=mc^2$$` 才做整体替换。

**导出层**:`services/exportHtml.ts` 给 markdown-it 补了 `imath_inline`(行内规则)与 `imath_block`(块级规则)两条最小实现,渲染时同样调用 KaTeX;KaTeX 的 CSS 以 Vite 的 `?raw` 方式内联进导出文件(字体 URL 重写到 CDN),使导出的 HTML 双击即可在浏览器中看到公式排版。

### 三、样式模块

所有样式收敛到 `src/renderer/src/styles/` 一个模块,核心侧只写一行 `import './styles'`:

```
styles/
├── index.ts        # 模块入口:聚合导入(顺序即层叠顺序)+ 导出插件注册表
├── registry.ts     # 插件样式注册表(运行时注入/卸载)
├── tokens.css      # 设计令牌:CSS 变量,三档主题(亮/暗/纯黑)都在这
├── base.css        # 全局 reset 与基础排版
├── shell.css       # 应用外壳:三栏布局、侧栏(文件列表/大纲)、状态栏
├── editor.css      # CodeMirror 外观与所见即所得样式(标题/强调/代码/公式/widget)
└── components/     # 独立组件:快速切换器、仓库选择界面、设置面板
```

- **手动导入(核心)**:`main.ts` → `import './styles'`;组件与服务不再各自引用 CSS 文件,层叠顺序集中维护。
- **运行时注入(注册表,预留)**:`styles/registry.ts` 提供 `registerStyle(name, css)` / `unregisterStyle(name)`,把一段 CSS 作为 `<style>` 注入与卸载,不需要任何文件路径约定:

  ```ts
  import css from './my-plugin.css?inline'            // Vite ?inline:读成字符串,不自动注入
  import { registerStyle, unregisterStyle } from '@renderer/styles'

  export function activate() { registerStyle('my-plugin', css) }
  export function deactivate() { unregisterStyle('my-plugin') }
  ```

- **这个注册表目前没有调用方**。插件如今确实能往界面里加东西了,但走的是**声明式贡献点**(见 §四 的 `lineMenu`):插件只声明「菜单里有什么」,按钮、菜单、对话框全部由宿主渲染 —— 插件代码仍然进不了渲染层,也就无从调用这个注册表。留在原处是因为它自身的实现与主题无关、成本为零;等真有「插件自带 CSS」的需求时,要补的是「插件 → 渲染层」这条通道,而不是这个注册表。
- **样式约定**:插件若要注入 CSS,类名加 `imk-` 前缀(内置样式用语义化类名,不加前缀);颜色/边框一律用 `tokens.css` 的变量(亮/暗/纯黑三档主题自动适配);需要覆盖 CodeMirror base theme 已有属性时须走 `EditorView.theme`(外部 CSS 会因特异度不足被静默忽略)。

### 四、插件系统

插件是**可以装、可以卸、可以升级的包**,而不再是仓库里的 TS 模块。一个插件 = 一份清单(`manifest.json`)+ 若干文件,打包成一个 `.imkpkg.json` 信封(单文件 JSON,包内每个文件 base64 编码并带逐文件 sha256)。安装后落在 `userData/plugins/<id>/`,启用态与配置在 `settings.json` 的 `plugins.<id>`,密钥在 `userData/secrets.json` 且**明文不出主进程**。

| 文件 | 职责 |
|---|---|
| `shared/pluginPackage.ts` | 包格式、清单校验、版本比较、路径/体积/图标规则 —— 主进程、服务端、渲染层共用同一份 |
| `shared/pluginApi.ts` | 插件拿到的 `ImkApi` 接口:主进程的实现与插件源码 import 的是同一份,接口漂移 = 类型报错 |
| `main/plugins/host.ts` | 宿主:登记、加载、生命周期、动作调度、安装/升级/回滚/卸载、失败熔断、状态广播 |
| `main/plugins/script.ts` | 脚本插件加载:`createRequire` + 清 `require.cache` |
| `main/plugins/capabilities.ts` | 内置能力注册表 —— 声明式插件绑定的实现都在这里 |
| `main/plugins/api.ts` | `ImkApi` 实现:按权限注入命名空间,密钥作用域校验 |
| `main/plugins/installed.ts` | 安装登记表 `userData/plugins/installed.json`(只存来源信息,磁盘目录才是权威) |
| `main/market/*` | 市场客户端(见 §五) |
| `main/git.ts` | git 子进程封装:超时/中止、防交互挂起、URL 脱敏、一次性凭据 helper |
| `main/secrets.ts` | safeStorage 加解密 + `userData/secrets.json` 读写 |
| `renderer/components/plugins/` | 插件设置页 / 通用字段控件 / 远端列表(插件列表本身在设置面板的导航分组里) |

**内置核心插件清单现在是空的** —— `main/plugins/registry.ts` 的 `builtinPlugins` 数组里一个都没有:「定时上传(Git)」原本在那儿,现在它是市场里的普通插件。数组留着,是因为「必须随应用启动、不该由用户卸载」的能力将来仍可能出现;但走那条路的插件**不过包校验、没有安装确认环节**,加之前要清楚这一点。

**两种形态**

- **脚本插件**(`kind: "script"`):包里带 `main.js`,在主进程里以 CommonJS 加载,**拿到与 iMark 相同的 Node 权限**。入口必须是工厂函数 `module.exports = (imk) => ({ onEnable, onDisable, onConfigChange, runAction })` —— 工厂式只有一个绑定点、不污染全局,宿主也才能在跑任何生命周期之前先拒绝非法导出。
- **声明式插件**(`kind: "declarative"`):包里**没有代码**,只声明绑定的内置能力(`capability`,目前实现了 `webhook`)。它把「配置一下就能用」的需求(推送到某个地址、导出到某处)从「必须信任一段任意代码」里摘出来 —— 这类插件的行为完全由 iMark 自己实现,安全性等同内置功能。

**加载为什么用 `createRequire`** 而不是 `vm` 或动态 `import()`:`vm` 在「已经授予完整 Node 权限」的信任模型下给不了任何隔离,却要自己重写一遍 CJS 解析;ESM 的模块缓存是永久的,插件升级后没法热重载。加载前先清掉该插件目录下所有 `require.cache` 条目,于是升级可以是**原子的**:新目录先就位并加载,**成功了**才删旧目录;加载失败就把旧目录 rename 回来并恢复旧运行时 —— 用户手上那个插件不会因为一次失败的升级而消失。代价是入口必须是 CJS(用 TS 写的插件由 `plugins-src/tsconfig.json` 编译成 CJS,作者无感;给了 ESM 入口会得到一句中文错误)。

**每次调用都有护栏** 宿主对插件的每一次调用(`onEnable` / `onConfigChange` / `runAction` / …)都过 `safeCall`:try/catch + 10 秒超时,失败写进状态(红色徽标 + 截断的堆栈)并累加计数;连续 3 次失败自动停用,**绝不自动恢复** —— 要用户在设置里显式重新启用。没有它,一个坏 `main.js` 的 `onEnable` 抛异常会让 `app.whenReady()` 整个 reject,应用直接起不来。

**配置与密钥** 配置项用 `PluginField[]` 描述(kind = text / password / number / boolean / select / targets),设置面板据此**通用渲染表单** —— 新增插件不必写任何 Vue 组件,也不需要为它改设置面板。`password` 字段与 `targets.targetSecret` 的值不写进 `settings.json`,而是 `safeStorage.encryptString()` 后存 `secrets.json`;渲染层只拿到「是否已配置」与主进程算好的掩码(`ab****23`)。插件读密钥只能走 `imk.secrets.get(fieldKey, targetId)`:宿主会校验「这个 fieldKey 确实是它清单里声明的密钥字段、这个 targetId 确实在当前配置的目标列表里」,并且密钥 key 由宿主用**插件自己的 id** 拼出 —— 插件永远拿不到、也传不了自己的 id。`secretKey()` 用 `:` 拼接,所以**插件 id 的字符集里禁止出现 `:`**:否则 `a:b` + 字段 `c` 会和 `a` + 字段 `b:c` 撞成同一个密钥。这是安全规则,不是格式洁癖。

> 说明白:**密钥作用域防的是误用与 API 卫生,它不是安全边界。** 脚本插件拥有完整 Node 能力,本来就能直接读 `userData/secrets.json`。真正的边界是安装时那一次知情确认(见 §五)。

**内置兜底包** 「定时上传(Git)」现在是市场里的一个普通插件,但应用仍然内置同一份包(以 `?raw` 字符串内联进主进程产物,绕开 asar 与 `files` 打包限制):启动时若它没装过,就走**完全相同的校验与安装代码路径**补装一次。于是全新用户不联网也能用上它,卸载后想装回来也不必连市场。**「内置」不是绕过校验的通道** —— 内置包坏了,表现与下载到的包坏掉完全一样。

「补装后要不要顺手启用」是**宿主自己的策略**(写在 `main/market/bundled.ts` 的清单里),不写进包 —— 否则一个包换个说法就能给自己开权限。目前「定时上传(Git)」装上但**默认关着**(要先填仓库地址与令牌才有意义),而「快速编辑(Quick Edit)」**默认开着**(它不配置也能用,开箱就该有那个「+」);两者都能在插件页随时关掉,一旦关掉就不再自动打开。已经在里面的插件(从市场装的、用户手放的、上一轮补装的)**一律不碰** —— 补装只补缺的那几个。

**卸载**的顺序是:停用 → 移出运行时 → 删目录 → **删这个 id 名下的全部密钥** → 删登记 →(可选)删配置。密钥一律删、不受「是否保留配置」影响,这是有意的:配置是偏好(留着,重装省得重填),密钥是凭据。凭据的危险在于 id 是可以被别人重新认领的 —— 今天卸载的 `git-sync`,明天可能是另一个人发布的同名插件,它会直接读出残留的访问令牌。

### 五、插件市场

市场服务端**在仓库里**(`server/`,零依赖、纯 `.mjs`,Node ≥18 直接跑),应用里填一个地址即可:

```bash
npm run market                      # → http://127.0.0.1:8787
IMK_MARKET_PORT=8787 HOST=127.0.0.1 DATA=./server/data ADMIN_TOKEN=… node server/index.mjs
```

存储就是 `server/data/` 下的几个 JSON 与按 sha256 去重的 blob 文件(临时文件 + rename 原子写);备份 = 拷目录。

**为什么自托管**:市场分发的是一段将在用户机器上执行的代码,「谁来发布」这件事交给一个你自己能看见、能备份、能关掉的服务端,比交给任何第三方都合理。

**接口一览**(`server/src/routes/`):

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | – | `{ok,version,time}`(应用里的「测试连接」打的就是它) |
| POST | `/api/v1/auth/register` \| `/login` | – | → `{user, token}` |
| GET | `/api/v1/auth/me` | Bearer | 当前账号与发布令牌列表 |
| POST · DELETE | `/api/v1/auth/tokens[/:id]` | Bearer | 长期发布令牌(明文只在创建时返回一次,服务端只留 sha256) |
| GET | `/api/v1/search?q=&page=&sort=&kind=` | – | 搜索 / 排序 / 按形态过滤 |
| GET | `/api/v1/packages/:id` \| `/latest` \| `/versions/:v` | – | 详情(含 README、版本列表、下架标记) |
| GET | `/api/v1/packages/:id/versions/:v/download` | – | 信封字节 + `X-Imk-Integrity` 响应头,下载计数 +1 |
| GET | `/api/v1/packages/:id/icon` | – | 图标字节(≤64 KiB) |
| POST | `/api/v1/packages` | Bearer | 发布:信封 JSON |
| POST | `/api/v1/packages/:id/versions/:v/yank` \| `/unyank` | Bearer(owner) | 下架 / 恢复 |

另有 `GET /api/v1/users/:username/packages`(某作者的全部插件)与 `/api/v1/admin/*`(统计、把被抢注的 id 转移给真正的作者,需 `ADMIN_TOKEN`)。

**发布**:注册账号(scrypt 加盐哈希,密码 ≥8 位)→ 在「发布插件」页选目录 → 打包预览(文件清单、权限、体积、整包 sha256)→ 发布。服务端会**重算**逐文件 sha256 与整包 integrity,不符就 400。`manifest.id` 首次发布即被该账号认领,别人再发同 id → 403;同一个 `(id, 版本)` 不能重发(409)—— 已发布的版本不可变,要改就升版本号。版本可以**下架**(yanked):下架后从搜索、`latest` 与版本列表里消失,但按精确版本号仍能下载 —— 已经锁定了这个版本的安装不会被破坏;下架当前最新版时,次高的非下架版本会自动成为 latest。**没有硬删除。**

**安装**:下载 → 把响应头声明的 integrity 与自算的比对 → `verifyEnvelope()`(结构、路径、扩展名、体积、逐文件 sha256)→ 检查「这个包在这台机器上装不装得上」(绑定的能力是否存在、声明的 `engines.imark` 是否满足)→ 解到 `.staging/` → 交给宿主原子就位。任何一步失败都不落盘。更新检查在启动后、打开市场页时、手动刷新时各跑一次,结果缓存 10 分钟;**绝不循环重试** —— 离线是正常状态,界面安静降级。

**安装确认框是安全基线**。按下按钮之前,它必须摆出:插件名 / 版本 / 发布者 / 来源地址、**逐条中文解释的权限清单**、文件数与总体积、可跨渠道核对的整包 sha256(脚本插件另给入口文件的 sha256);脚本插件还有一条红字警告,并且**不勾选「我已了解风险」就不给点安装**。声明式插件没有这段警告,但会点名它借的是哪个内置能力(「不含代码」本身说明不了任何事 —— 一个号称笔记统计的插件完全可以绑 webhook)。详情页另配「**查看源码**」:显示的内容与将要安装的那份**来自同一次下载、过了同一套校验**,不是另取的一份「参考源码」—— README 是作者写的散文,只有源码是他真正要跑的字节。

**要如实说明的边界**

- **脚本插件 = 主进程里的任意代码执行。** 它能读写你电脑上的任意文件(笔记、SSH 密钥、`secrets.json`)、发起网络请求、启动其他程序。上面那一整套(sha256、发布者、权限清单、确认框、失败熔断、失败回滚)降低的是**误装**的概率、让**决策知情**,它们**不做沙箱**。
- 默认市场地址 `http://127.0.0.1:8787` 是**明文**的(且只监听回环)。填非回环的 `http://` 地址时界面会给一次性警告;正式部署必须自己前置 TLS 终止 —— 否则「下载的包没被篡改」这件事就只靠一次明文 HTTP 撑着。
- 发布是「**已认证但不审计**」:任何能注册的人都能认领一个还没被占用的 id。共享的注册表上,官方 id 应当先占掉。
- 服务端按 IP 的内存限流(10 次失败 / 5 分钟)只够自托管;公开部署需要真正的限流组件与审计。
- 插件跑在主进程,**在界面上的存在感只有一处**:清单里的 `lineMenu` 会让宿主在光标所在行的左边画一个「+」,点开是插件声明的菜单条目。按钮、菜单、对话框、以及**改动文档**全部由宿主执行,插件只交出「菜单里有什么」和「确认后要插入什么文本」—— 它依然碰不到 CodeMirror。除此之外没有别的 UI 扩展点:加面板、加侧栏、改主题都还做不到。

**官方插件:定时上传(Git)**

按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意远端,可配置**多个远端**(一次提交推全部);动作有「立即上传」「测试连接」,状态栏有同步图标(成功 / 失败 / 进行中 / 未启用四态)。同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交。

- **凭据既不落盘也不进命令行**:推送时 URL 保持干净(不带 `user:token`),而是临时挂一个一次性 credential helper(`-c credential.helper=` + `-c credential.helper=!f(){…}`),用户名与 token 从子进程**环境变量**读取(`GIT_IMK_USER` / `GIT_IMK_TOKEN`)。这样既不会把 token 写进 `.git/config`,也不出现在进程命令行里;同时固定 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never`,缺凭据时快速失败,而不是弹一个凭据窗口把同步卡死。**用户名可留空**:留空按 `oauth2` 认证(GitLab / GitHub 通用),Gitee 建议填真实用户名;未填 token 时完全不注入凭据(公开仓库或无凭据场景)。
- **全链路脱敏**:任何要展示、写状态或落盘的 git 输出都先过 `redactUrl()`,把 `://user:token@host` 洗成 `://user:***@host`;失败按类型翻成可操作的中文提示(远端有新提交被拒 / 认证失败 / 连不上 / 仓库不存在)。
- **远端配置项**(每个远端一行):**远程仓库**(必填,HTTPS 或 SSH 地址)+ **本地分支**(必填)/ **远程分支**(留空则与本地分支同名)+ **认证方式**:

  | 认证方式 | 说明 |
  |---|---|
  | 访问令牌 | 默认。GitHub / GitLab 的 personal access token,按 `oauth2:<令牌>` 认证;私有仓库必填(界面提示会写明) |
  | 账号密码 | 填账号 + 密码(如 Gitee 用账号名 + 私人令牌) |
  | SSH | 用本机 SSH 密钥,不需要填写密钥;地址写成 `git@host:用户名/仓库.git` |

  密钥经 safeStorage 加密保存,界面上只显示**掩码**(`ab****23`,由主进程算好下发),旁边是「更换 / 清除」;点「更换」才展开输入框。地址是 `file://` 这类本地路径时不需要凭据。
- **首次同步会做的事**(都可在插件设置里关闭):不是 git 仓库时 `git init -b <分支>`;写入推荐 `.gitignore`(`.obsidian/`、`node_modules/`、`.imark-tmp` 等,**已存在则不覆盖**)。**插件不改动仓库的 remote 配置** —— 推送直接推给配置里的地址,你的 `origin` 是谁、命令行 `git pull` 认哪一套,由你自己决定。作者身份仅在仓库与全局都没配 `user.name/user.email` 时用插件配置兜底,否则尊重你的 git 配置。
- **它只做上传**:不替你处理仓库层面的疑难(远端已有无关历史、两边都改过同一文件、需要合并或变基等)。遇到这类情况插件会**如实报错**(状态变红、详情里给出 git 的原始信息),请你在仓库目录自己用 git 处理完再点「立即上传」—— 插件保持简单,行为可预期。
- **配置改完会自动试跑一次**(3 秒后):否则容易出现「先启用插件(还没填远端)→「启动后同步一次」当场失败并被消耗 → 要干等一个完整间隔才再试」的错觉。
- **边界**:定时器跑在主进程,而应用是「窗口全关即退出」(无托盘),所以**关掉应用期间不会上传** —— 用「启动后同步一次」弥补;仓库切换后始终同步 `settings.vaultPath` 指向的当前仓库。

### 六、插件开发

#### 写一个脚本插件

官方插件就是可以照抄的样板,两个都好用,按需要挑一个:`plugins-src/git-sync/` 是重型的那个(多目标、动作、密钥、状态广播),`plugins-src/quick-edit/` 是轻型的那个(一份清单 + 一个 `runAction`,三十行代码)。哪个插件目录长这样,就以哪个为骨架:

```
my-plugin/
├── manifest.json     # 清单:id、名称、版本、权限、字段表、动作
├── main.ts           # 源码(TypeScript,也可以直接写 main.js)
└── README.md         # 会显示在详情页(纯文本渲染)
```

```ts
// main.ts —— 入口必须是**工厂函数**,导出对象不行
import type { ImkApi, PluginRuntime } from '@shared/pluginApi'

class MyPlugin implements PluginRuntime {
  constructor(private imk: ImkApi) {}
  onEnable(): void { /* 启动定时器、建立连接… */ }
  onDisable(): void { /* 收尾 */ }
  onConfigChange(): void { /* 配置变了 */ }
  // 后两个参数用不上时可以整个省掉(它们是给「行首菜单」与「目标列表」用的,见下)
  async runAction(actionId: string): Promise<{ ok: boolean; message: string }> {
    if (actionId !== 'ping') return { ok: false, message: `未知动作:${actionId}` }
    return { ok: true, message: 'pong' }
  }
}

export = (imk: ImkApi) => new MyPlugin(imk)
```

- 编译:插件源码是独立 TS 工程(`plugins-src/tsconfig.json`),`module: CommonJS`。`npm run plugins:build` 会编译官方插件并把清单 + 产物 + README + 图标打成内置兜底包;你自己的插件用 `tsc`(或任意工具)编译出 `main.js`,再在界面「发布插件」页选目录打包即可 —— **打包器不编译 TypeScript**,它只收 `main.js`。
- **只 import 类型,不要 import 应用的运行时代码**:`@shared/*` 里能给你的是类型(如 `ImkApi`、`PluginField`),它们全是 `import type`,编译后会被完全擦除。写成一个值导入(不带 `type`)时,编译器会原样留下 `require('@shared/…')` —— 那个模块名在用户机器上不存在,插件会在加载时报 `MODULE_NOT_FOUND`。需要的能力从下面的 API 表里找;表里没有的,是这套插件模型目前确实做不到的事。
- 清单里的 `main` 必须是包内真实存在的 `.js`;忘了编译会得到一句明确的中文报错,而不是装上一堆没用的文件。

#### 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✔ | `^[a-z0-9][a-z0-9._-]{1,63}$`,**禁止 `:`**(见 §四 的密钥命名空间);保留字 `imk`/`market`/`system`/`core`/`node`/`electron` |
| `name` / `description` | ✔ | 界面上的名字与一句话说明 |
| `version` | ✔ | `1.2.3`,可带 `-beta.1` 这类预发布后缀;已发布的版本不可覆盖,只能升号 |
| `kind` | ✔ | `script` 或 `declarative` |
| `main` | script ✔ | 入口文件,必须是包内的 `.js` |
| `capability` | declarative ✔ | 绑定的内置能力 id(目前只有 `webhook`) |
| `permissions` | | 权限数组,见下表 |
| `author` / `homepage` | | 署名与主页(https) |
| `icon` | | 包内图标文件名(建议 svg/png,≤64 KiB);**渲染层不直接发网络请求**,图标由主进程下载后以 `data:` URL 下发 |
| `engines.imark` | | 需要的 iMark 版本,如 `">=0.1.0"`(支持 `>=` / `>` / `^`)。不满足时**在确认框之前就拒绝**并说清要哪个版本;解析不了的范围一律视为满足 —— 宁可让你自己判断,也不要因为解析不了就把插件全判为不兼容 |
| `fields` | ✔ | 配置字段表(`PluginField[]`),设置面板据此通用渲染表单 |
| `actions` | | 插件级动作:设置页里的按钮(不写就是没有按钮) |
| `targetActions` / `targetFieldKey` | | 目标级动作(对「目标列表」的某一行执行)。声明了它就必须有一个 `kind: "targets"` 的字段 |
| `lineMenu` | | 光标行左侧「+」菜单里的条目(`PluginLineMenuItem[]`,≤12 条)。每条要么给 `template`(固定文本,宿主直接插入,不惊动插件),要么给 `action`(+ 可选 `dialog` 参数表单)。**行首菜单的动作只声明在这里** —— 再写进 `actions` 会让设置页多出一个「插入表格」按钮,而它是个行内动作,放那儿说不通 |

权限(`permissions`)里,**只有 `git` 与 `secrets` 是注入强制的**:没声明就拿不到 `imk.git` / `imk.secrets`。其余(`vault:read`、`vault:write`、`network`、`shell`、`settings`)是**声明性说明** —— 脚本插件本来就有完整 Node 能力,fs / net / shell 挡不住它们,列出来是为了让安装的人知道自己正在同意什么。所以**别把权限列表当成限制来设计自己的插件**,它是一份对用户的告知。

包内文件规则:相对 POSIX 路径、无 `..`、深度 ≤3、扩展名白名单(`js/mjs/cjs/json/md/txt/svg/png/css`)、单文件 ≤2 MiB、`main.js` ≤1 MiB、README ≤256 KiB、整包 ≤8 MiB、文件数 ≤64。

#### 插件能拿到的 API

`imk` 就是生命周期回调里的 `ctx`,一个对象、没有别名(所以 `ctx.setState()` 这类写法一个字都不用改):

| 命名空间 | 内容 |
|---|---|
| `imk.plugin` | `id` / `name` / `version` / `dir`(安装目录,读自带静态资源用) |
| `imk.vault` | `path()` 当前仓库根目录(未打开仓库时为 `null`)、`exists(p?)` 路径是否存在 —— **两个都是 async** |
| `imk.git` | **需 `git` 权限**。`available()` / `run(args, opts)` / `credentialArgs(token)` / `credentialEnv(user, token)` / `redact(text)` / `summarize(text)` —— 凭据 helper 与环境变量注入的封装,不要自己拼命令行 |
| `imk.secrets` | **需 `secrets` 权限**。`get(fieldKey, targetId?)` / `has(...)`,只读,只能读自己名下的密钥 |
| `imk.getConfig<T>()` / `imk.setState(patch)` | 读配置(已归一化)、更新状态并广播到界面 |
| `imk.flushDocument()` | 让渲染层先把脏文档落盘(带超时兜底) |
| `imk.isEnabled()` / `imk.isDisabledByHost()` | 是否在运行 / 是否已被熔断 |
| `imk.log(level, ...args)` | 进主进程控制台,同时留在该插件的日志缓冲里供设置界面查看 |

**接口只有这些**:插件跑在主进程,除了清单里的 `lineMenu` 之外不能往界面里加东西,也不能调用应用的内部模块(只能 import `@shared/*` 的类型)。要读仓库文件直接用 `node:fs` + `imk.vault.path()` —— 这正是 `vault:read/write` 是声明性权限的原因。

**错误处理**:动作返回 `{ ok, message, detail? }`,失败就如实返回,不要吞掉;宿主会把它显示在插件详情里。抛异常也行 —— 宿主会捕获、记进状态并累加失败计数(**连续 3 次自动停用**,用户得手动重新启用)。有任何耗时操作都要自己设超时:宿主给每次调用的上限是 10 秒。

#### 往光标行加一个「+」条目

清单里声明 `lineMenu`,宿主就会在**光标所在行**的左边画一个「+」;插件没声明(或没被启用)时连按钮都不画。点开是插件声明的条目,两条路可选:

- **`template`:固定文本。** 宿主直接把它插到那一行下面,插件代码一行都不跑。适合 `> ` 这类「插进去就完了」的内容:

```json
"lineMenu": [{ "id": "quote", "label": "引用", "template": "> " }]
```

- **`action` + `dialog`:先问用户,再让插件算。** 条目带 `dialog` 时,宿主照 `fields`(`PluginField[]`,与设置页同一套声明式字段)渲染一个只含这几个字段的对话框;用户点确定后,才把值交给插件:

```json
"lineMenu": [{
  "id": "table", "label": "表格", "action": "insert-table",
  "dialog": { "title": "插入表格", "confirmLabel": "确定", "fields": [
    { "key": "rows", "kind": "number", "label": "行数", "default": 3, "min": 1, "max": 50 },
    { "key": "cols", "kind": "number", "label": "列数", "default": 3, "min": 1, "max": 20 }
  ] }
}]
```

插件收到的 `payload` 是两份东西:`values`(用户填的值)与 `editor`(这一行的快照:`{ line, lineText, filePath }`)—— 想按上下文变化(比如「这一行已经是列表,就换个插法」)看后者。返回时多给一个 `editor` 字段,就是让宿主去改文档:

```ts
async runAction(actionId, _ctx, _targetId, payload?: PluginActionPayload) {
  if (actionId !== 'insert-table') return { ok: false, message: `未知动作:${actionId}` }
  const rows = payload?.values?.rows ?? 3
  return {
    ok: true,
    message: '已插入表格',
    editor: { text: '|  |\n| --- |', cursorOffset: 2 }   // cursorOffset:光标落在 text 里的哪个字符上
  }
}
```

**文档始终由宿主来改**,这是有意的:插件从头到尾拿不到 `EditorView`,也没有「把文档交给我」的通道。于是最坏情况不过是插进来一段难看的文本 —— 它不可能弄坏光标、选区、撤销栈或别的什么。同理:

- **失败就不插入。** `ok: false`(含插件被熔断、未启用、加载失败)时宿主拿不到 `editor`,文档一个字符都不会变,只在界面上说一句为什么。
- **`template` 与 `action` 恰好二选一。** 两个都给、或都不给,包在校验时就会被拒(报错点名第几条)。
- **对话框字段是受限的**:`kind` 只能是 `text` / `number` / `boolean` / `select`(对话框是一次性的,`password` 与 `targets` 这种要长期维护的东西不该出现在里面),且**每项都必须有 `default`**(对话框要有个初值)。
- **`template` 有体积上限**(单条 4 KiB、合计 16 KiB)。不是磁盘不够,而是 descriptor 每次状态广播都要整体过一遍 IPC —— 大段文本该放进包里的静态资源,由插件读出来返回。

`lineMenu` 的改动要**重启应用**才生效:descriptor 是安装时定下来的,宿主不会因为磁盘上的 `manifest.json` 变了就重新加载插件(升级请走市场或重装,那是原子的)。

#### 写一个声明式插件

不用写一行代码:一份清单 + 一句说明就能发布。绑 `webhook` 能力的最小例子:

```json
{
  "id": "notify-my-service",
  "name": "推送通知",
  "description": "把「上传成功/失败」推送到我自己的服务。",
  "version": "1.0.0",
  "kind": "declarative",
  "capability": "webhook",
  "permissions": ["network", "secrets"],
  "fields": [
    { "key": "targets", "kind": "targets", "label": "推送地址", "default": [],
      "targetSecret": { "label": "签名令牌（可选）" } },
    { "key": "method", "kind": "select", "label": "请求方法", "default": "POST",
      "options": [{ "value": "POST", "label": "POST" }, { "value": "GET", "label": "GET" }] },
    { "key": "timeoutMs", "kind": "number", "label": "超时（毫秒）", "default": 10000 }
  ],
  "actions": [{ "id": "test", "label": "发送测试请求" }],
  "targetActions": [{ "id": "test-target", "label": "测试这一条" }],
  "targetFieldKey": "targets"
}
```

**令牌注入看的是你的清单,不是能力**:能力声明的是它「需要哪些字段与动作」,而 `imk.secrets` 注不注入只看清单里的 `permissions`。少写了 `secrets`,用户照样能在「推送地址」那一行填签名令牌(那是能力要求的字段),但插件读不到它 —— 请求不会带上 `Authorization`。要用就自己写进去。

清单必须配齐能力要求的字段与动作,缺什么会在安装时被**逐条点名**(「缺少能力「Webhook 推送」需要的字段:targets」),而不是装上一个点不动的插件。**新增一种能力**就是实现 `Capability` 接口(声明需要哪些字段/动作/权限 + `create()` 出运行时)后 `registerCapability()`:`main/plugins/capabilities/webhook.ts` 是唯一的样板,拿它照抄。

#### 发布

1. 起一个市场:`npm run market`(或指向别人部署的地址);
2. 应用里 `设置 → 插件 → 浏览市场 → 发布插件`,填地址 → 注册/登录(密码 ≥8 位);
3. 「选择插件目录…」→ 看一遍打包预览(文件清单、权限、体积、整包 sha256)→ 发布;
4. 之后每次发新版只要升 `version` 再发;装了这个插件的人会看到「可更新」角标。

**同一个版本号不能覆盖重发**(服务端 409):已发布版本的哈希是被用户拿去核对过的,得改就升版本。要撤回一个版本用「下架」——它从搜索结果与 `latest` 里消失,但已经锁定了这个版本的人仍然装得上。

### 七、其他子系统

- **仓库(Vault)工作流**:主进程 `vault.ts` 用 `fs.promises.readdir` 递归列目录(跳过隐藏目录与 `node_modules`/`.obsidian` 等),渲染层 `vaultService.ts` 负责状态与流程编排;删除走 `shell.trashItem`(系统回收站),新建/重命名走专用 IPC——渲染层不直接触碰文件系统。
- **进程边界与安全**:系统能力全部经 `contextBridge` 暴露的 `window.api`(类型定义在 `shared/api.ts`);渲染层开启 `sandbox`、无 Node 集成;外链在打开前于主进程校验 `^https?://`,本地图片走自定义 `imark://` 特权协议(编码绝对路径,由主进程读取后返回,规避 `file://` 的编码与安全限制)。
- **主题**:三档主题(亮/暗/纯黑)全部由 CSS 变量驱动(变量定义在 `styles/tokens.css`,见 §三),CodeMirror 侧通过 `EditorView.theme` 引用 `var(--…)`。注意:base theme 已定义过的 `.cm-*` 属性必须写在主题扩展里,外部 CSS 会因特异度不足被静默忽略。
- **导出 HTML**:markdown-it(代码高亮用 highlight.js)+ 内联样式模板,输出单文件。
