# iMark

基于 **CodeMirror 6 + Electron + Vue 3** 的所见即所得(Obsidian Live Preview 风格)Markdown 编辑器。

作者:**Chuxiao Xiang** <13439022108@163.com>

## 功能

- **所见即所得编辑**:语法树驱动的装饰层——光标不在节点上时自动隐藏 `**`、`` ` ``、`#`、`](url)` 等标记,内容按样式渲染;光标进入即显形为原始语法。表格、图片、公式、Mermaid 图表这类「有形态的内容」直接渲染成真元素(表格连列对齐都按分隔行里的 `:` 还原)
- 标题(H1–H6)、粗体、斜体、删除线、行内代码、引用、无序/有序列表、分隔线
- 任务列表(可点击 checkbox,直接改写源码,可撤销)
- 代码块嵌套语言高亮(`@codemirror/language-data` 按需加载)
- **LaTeX 公式**(KaTeX 渲染):行内 `$E = mc^2$` / `\(E = mc^2\)`、块级 `$$...$$` / `\[...\]`(支持跨行,居中显示);光标移入公式即翻回源码编辑,移出即恢复渲染;代码块内的定界符不受影响;导出 HTML 与扩展预览同样带公式
- **Mermaid 图表**(Mermaid 12 渲染):```` ```mermaid ```` 围栏在光标外整块渲染成 SVG,支持流程图、时序图、类图、状态图、ER 图、甘特图、饼图、思维导图、架构图等全部图种与 `%%{init}%%` 指令;本地注册 Lucide 图标包,可直接使用 `A@{ icon: "lucide:user" }` 这类 icon shape(无网络依赖)。光标移入或点击图表即翻回源码编辑,移出恢复;切换亮/深色主题会自动重渲染;导出 HTML 内联同一张 SVG,单块语法错误降级成错误块而不影响整份导出
- 链接 Ctrl+点击在系统浏览器打开;图片(本地相对路径走 `imark://` 自定义协议)光标外直接渲染;粘贴截图/剪贴板图片时自动存到文档旁的 `assets/` 并插入相对路径;从正文删掉引用并保存后,对应的 `assets/` 文件会移入系统回收站(同目录其他笔记仍在引用它时保留)
- 文件:新建 / 打开 / 保存 / 另存为 / 拖拽 `.md` 入窗打开,窗口标题未保存圆点,关闭前脏检查
- **多标签页(仿 Obsidian)**:编辑器上方是标签栏 —— 点文件在新标签中打开(已打开则激活,不会重复开),`+` 新建未命名页;标题右侧圆点表示未保存(激活页同样显示),悬停时圆点让位给 ×,中键也能关闭;自动保存或手动保存成功后圆点消失;标签可拖动排序,`Ctrl+W` 关闭当前页、`Ctrl+Tab` / `Ctrl+Shift+Tab` 循环切换。每个标签各自保留撤销历史、选区和滚动位置,切换时互不串扰;关闭窗口会逐个处理所有脏标签(提示里列出全名),重启后恢复上次的标签顺序与当前页(未命名页不跨启动恢复)
- **仓库(Vault)工作流**(仿 Obsidian):启动先进入 **仓库选择界面** —— 最近仓库列表(可移除记录)+「打开文件夹作为仓库」+「创建新仓库」;选定后进入编辑器
  - 文件浏览器侧栏(Ctrl+Shift+L):树形目录、新建文件/文件夹、重命名、删除(移到系统回收站)、刷新
  - 快速切换文件(Ctrl+P):全仓库模糊搜索,↑↓ 选择、Enter 打开
  - 状态栏左侧显示当前仓库名,点击回到仓库选择界面切换(有未保存内容时先询问)
  - 仓库选择界面底部可勾选「启动时直接打开上次使用的仓库」以跳过选择步骤
- **表格编辑**:渲染态表格支持单元格就地输入(回车 / Tab 换格,最后一格自动加行)、鼠标靠近行列边界时增删行列、整表选择 / 对齐 / 删除、拖动矩形选区后按 Backspace / Delete 清空;隐藏的源码行不可输入,方向键可越过整张表。表格上下紧邻的结构空行保留在源码里(GFM / markdown-it / Obsidian 的要求),渲染态下折成零高度,间距由 `--md-table-gap-top` / `--md-table-gap-bottom`(或 `--md-table-gap`)控制。
- **扩展系统**:VS Code 式扩展模型 —— 清单是扩展目录根部的 `package.json`,代码跑在独立的 `utilityProcess` 扩展宿主里,通过 `require('imark')` 使用 `commands` / `window` / `workspace` / `webview` 等 API;`contributes` 驱动命令面板、快捷键、状态栏、行首菜单与设置页。默认所有扩展共用一个宿主(`shared`),也可切换 `isolated` 或按 `extensionHost.affinity` 分组。**扩展代码以当前用户权限运行,不做权限沙箱**;含代码扩展安装时必须勾选风险确认。设置面板「扩展」分类统一管理启用/停用、自动渲染配置表单、动作按钮与运行日志,「设置 → 扩展分配」集中管理宿主分组;密钥经 Electron safeStorage 加密后单独存于数据目录的 `secrets.json`(默认 `<应用目录>/.imark/secrets.json`),**渲染层与 webview 永远拿不到明文**
  - **定时上传(Git)**:随应用预置、默认关闭的官方扩展——按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意 Git 远端,可配置**多个远端**(一次提交推全部);另有「立即上传」「测试连接」动作,以及状态栏同步图标(成功/失败/进行中/未启用四态)。同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交
  - **快速编辑(Quick Edit)**:随应用预置、默认启用的官方扩展。光标所在行左侧的「+」→「表格」→ 填行数与列数,表格插入到当前行下方并停在渲染态。按钮、菜单、对话框与插入位置全部由宿主实现,扩展只声明 `lineMenu` 条目并返回要插入的文本(见 §四);所有扩展的 `lineMenu` 合进同一个「+」菜单
  - **Agent Core / Claude Code**:随应用预装、默认关闭的两个官方扩展。**Agent Core** 是通用 Agent 面板:对话、会话、附件与产物都由它管,本身**不解析任何附件**,只把文件字节落盘,把绝对路径与会话目录交给后端,怎么读取/解析由后端自己决定。具体后端由 provider 扩展提供;**Claude Code** 是内置的第一个 provider,通过本机 CLI 接入,启动参数包含流式协议、会话续接与授权询问通道,哪些工具需要授权仍由 Claude Code 自己的设置决定,需要时由面板弹出「允许 / 拒绝」;支持流式文本、工具时间线、`prepared/` 产物预览、结果插入/替换、`--resume` 会话恢复与取消;当前文档需要时可用「＋ 本文档」作为一条普通附件加入会话,写回走编辑器,不直接改 vault。Claude Code 依赖 Agent Core,两者都要启用;启用前在 Claude Code 的设置里选择「自动检测」或手动指定可执行文件,也可以先安装 CLI;模型、端点与令牌的唯一事实是 `~/.claude/settings.json`,设置页的对应字段直接读写它;「检查 Claude Code」会探测 CLI 并把结果显示在本扩展的状态卡里。详见 `plugins-src/agent/README.md` 与 `plugins-src/claude-code/README.md`
- **扩展市场**:仓库内自带零依赖自托管服务端(`npm run market`),应用里填地址即可**浏览 / 搜索 / 安装 / 查更新 / 发布**;按「含代码 / 纯声明」筛选。安装前有安全基线确认框(形态、来源与发布者、体积、可跨渠道核对的整包 sha256、入口 sha256、激活事件、能力声明与贡献摘要);含代码扩展必须勾选「以我的用户权限运行」才能安装,并可**先查看源码**。详见下文「五、扩展市场」
- 无菜单栏界面(仿 Obsidian):原生菜单只是隐藏(`setMenuBarVisibility(false)`),Ctrl+N/O/S、Ctrl+P、Ctrl+J、F12 等加速键照常生效,按 Alt 也不会弹出;切勿改成 `Menu.setApplicationMenu(null)`,那会让加速键一起失效
- 主题:亮色 / 深色两档,状态栏一键切换(主题与设置按钮在状态栏最左边),或在 **设置面板**(状态栏左侧齿轮 / `Ctrl+,`)的「外观」中挑选;深色的底色与边框对齐 Obsidian 的 Minimal 主题深色档(`#262626` 编辑区 / `#212121` 侧栏),文字仍用 iMark 默认配色(`#dadada` 正文 / `#8a5cf5` 强调色)。偏好持久化到数据目录的 `settings.json`
- **自定义样式**:把 `.css` 文件放进数据目录的 `css/`(默认 `<应用目录>/.imark/css/`)(首次启动自动创建,并附一份带注释的示例)就能改编辑器里的显示 —— 比如整张表格居中 `.cm-md-table { text-align: center }`。改完保存**即刻生效、不用重启**;设置面板「外观」里是**单选**:一份 .css,或一个**目录**(目录里所有 .css 一起生效),点一行选中、再点一次取消,可导入单个文件或整个文件夹、删除、一键打开样式目录。样式作用于整个界面,**只影响编辑器内显示,不影响导出的 HTML**;详见下文「三、样式模块」
- 状态栏字数统计(中文按字、拉丁按词)、导出 HTML(markdown-it + highlight.js 内联样式)
- **通知中心**:状态栏右下角的铃铛收集扩展通知(扩展调用 `showInformationMessage` 等)、应用自身的提示,以及渲染进程里 `new Notification(...)` 的浏览器通知;未读时铃铛带角标,点开在右下角弹出历史小框(可一键清空)。右下角气泡仍然负责即时提醒,但不再需要"盯着它看"——错过了随时能从铃铛里翻回来

## 开发

```bash
npm install
npm run dev        # 启动开发模式(HMR)
```

```bash
npm run typecheck  # tsc(node 侧)+ vue-tsc(渲染层)
npm run build      # 构建三端产物到 out/
npm run dist       # 先重建内置扩展包,再构建 + electron-builder 打安装包(predist)
```

设计文档：

- [docs/architecture.md](docs/architecture.md) —— 项目整体架构、进程边界、启动流程与关键子系统；
- [docs/plugin-system.md](docs/plugin-system.md) —— 插件（扩展）系统的包格式、宿主拓扑、协议与市场；
- [docs/plugin-development.md](docs/plugin-development.md) —— 插件开发指南（清单、API、webview、发布）。

## 环境要求

- **Node ≥ 22.12**。Electron 40 起的安装链(`@electron/get` 5 / `@electron-internal/extract-zip`)与 electron-builder 26 的部分依赖均为 ESM-only,Node < 22.12 时需降级 electron ≤ 39 / electron-builder 25。
- **国内镜像分两处**:npm registry 在 `.npmrc` 里;electron 与 electron-builder 的二进制镜像用**裸环境变量** `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`(Windows 下 `setx` 设为用户级)。别把它们写回 `.npmrc`——npm 11 会按「Unknown project config」告警,且下个大版本不再支持;也不要指望 `package.json` 的 `config` 字段,它传不到依赖的 install 脚本(实测依赖的 `install` 脚本里 `npm_package_config_*` 是空的),electron 的 postinstall 拿不到。两个变量是 `@electron/get` 与 `app-builder-lib` 直接读 `process.env` 的兜底项,不经过 npm,因此不会产生任何告警。
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
  - 没有桌面密钥环(gnome-keyring / kwallet)时 `safeStorage` 不可用,扩展里的访问令牌会**降级为明文**存进 `secrets.json`(界面上暂无提示)—— 在意的话别在无密钥环的机器上保存令牌。
  - 「删除到回收站」依赖 XDG trash 实现,极简系统上可能失败。

## 技术架构

### 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面容器 | **Electron 44** | 主进程 / 预加载 / 渲染进程三段式;`sandbox: true` + `contextIsolation`,系统能力经 `contextBridge` 暴露的一次性取用函数交给渲染层 |
| 构建 | **electron-vite 3 + Vite 6** | 三端统一构建;主进程/预加载外部化依赖,渲染层 HMR |
| UI | **Vue 3.5**(`<script setup>`)+ **TypeScript 5.9** | 状态用普通 `reactive` 轻量 store,不引 Pinia |
| 编辑器内核 | **CodeMirror 6**(`@codemirror/state` / `view` / `commands` / `language`) | 增量解析 + 装饰系统 |
| Markdown 语法 | **@codemirror/lang-markdown** + **@lezer/markdown**(GFM) | 提供 Lezer 语法树,是整个所见即所得的地基。注意 `markdown()` 的 base 必须显式传 `markdownLanguage`——它的默认值是 `commonmarkLanguage`,那样任务列表/删除线/表格等 GFM 节点根本不会出现在语法树里 |
| 代码高亮 | **@codemirror/language-data** + **@lezer/highlight** | 代码块内按语言动态加载高亮 |
| 数学公式 | **KaTeX 0.19** | 同步渲染、无网络依赖(字体随构建产物打包) |
| 图表 | **Mermaid 12** + **@iconify-json/lucide** | 编辑期与导出共用的异步渲染服务;动态 import、串行队列、结果缓存,Lucide 图标包本地注册 |
| 导出 | **markdown-it 14** + **highlight.js 11** | 仅用于导出 HTML,与编辑器内核解耦 |
| 图标 / 打包 | **lucide-vue-next** / **electron-builder 26** | |

```
src/
├── shared/     # 主/渲染共用:IPC 通道常量、类型、桥接口
├── main/       # 主进程:窗口、IPC、原生菜单、文件原子写、settings、imark:// 协议
├── preload/    # contextBridge 暴露一次性取用函数(sandbox 模式)
└── renderer/
    └── src/
        ├── styles/           # ★ 样式模块:统一装配入口 + 扩展样式注册表(见下)
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
- **跨行块(块级公式、表格、Mermaid 图表)的渲染手法**:CM6 **不允许扩展提供跨行的 `replace` 装饰**(`remap()` 里还会在中文输入期间主动丢掉跨行的那些),而这类语法天生多行。做法是只替换**首行**成一个承载整块内容的 widget,其余行清空内容并加 `cm-md-*-void` 折算成零高度(`line-height: 0` + `font-size: 0` + `min-height: 0`,高 0 是被 DOM 实测确认过的)。配套的**视口守卫**不能省:首行不完整落在视口内时整块退回源码态——否则首行的 widget 根本没被渲染,而后面几行照样被清空,屏幕上就是一块空白。

**实现文件**:

| 文件 | 职责 |
|---|---|
| `editor/wysiwyg/build.ts` | ViewPlugin 主体:视口遍历、语法树可用性检查、装饰集构建、Ctrl+点击链接 |
| `editor/wysiwyg/rules.ts` | **节点名 → 装饰策略**的唯一分发表(标题/强调/代码/链接/图片/公式/任务列表…) |
| `editor/wysiwyg/widgets.ts` | `WidgetType` 实现:复选框、图片、水平线、公式、表格、Mermaid 图表 |
| `services/mermaid.ts` | Mermaid 异步渲染服务:动态 import、串行队列、按「主题 + 源码」缓存、Lucide 图标包注册 |
| `editor/wysiwyg/inline.ts` | 行内片段渲染(表格单元格用);**刻意不复用 `services/exportHtml.ts`** —— 那个模块顺带牵连 katex 与 highlight.js,编辑器不该依赖导出服务,但两者的 markdown-it 配置必须保持一致 |
| `editor/wysiwyg/selection.ts` | 闭区间相交判定(行内粒度 / 行粒度) |
| `editor/imagePaste.ts` | 剪贴板图片粘贴:先于 CM 只认文本的 paste handler 拦下图片、存到文档旁 `assets/`、按异步保存期间的光标变化定位插入 |
| `editor/setup.ts` | 扩展组装(换行、历史、markdown、WYSIWYG、键位、主题) |

### 二、LaTeX 与 Mermaid 渲染

**解析层——自定义 Lezer 扩展**(`editor/math.ts`)

没有用正则扫描文本,而是给 `@lezer/markdown` 写了解析器扩展,产出 `InlineMath` / `DisplayMath` / `MathBlock` 节点及 `MathMark` / `MathContent` 子节点。行内公式用 `parseInline`,免费获得正确的上下文:代码块与行内代码里的 `$` 天然不会被误判,`\$` 转义由 Escape 解析器处理,公式内容也不会被 `*`/`_` 的强调解析拆开(解析器注册在 `Emphasis` 之前)。

块级公式另外需要一个 `parseBlock`(注册在 `FencedCode` 之前)。Lezer **先做块解析、再做行内解析**,`+ ` / `- ` / `>` / `#` 这些行首标记会在行内解析开始前就截断段落——多行推导式里一行以 `+` 开头极常见,后半段会被读成列表,`$$` 再也配不上对。`MathBlock` 从行首 `$$` 一直吞到收尾的 `$$`;每行单独产出一个 `MathContent`(行首的引用标记/列表缩进不进入 TeX),`endLeaf` 让 `$$` 紧贴上一段时也能正确开始。

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

CodeMirror 明确禁止扩展提供跨行的 replace 装饰(`Decorations that replace line breaks may not be specified via plugins`),而 `$$...$$` 通常写成多行。这里采用**逐行处理**绕过该限制:

```
$$                    ← 首行:整行内容替换为 MathWidget(display 模式,居中)
\int_0^1 x^2\,dx      ← 内容行:清空内容 + Decoration.line 折叠高度(line-height: 0)
$$                    ← 尾行:同内容行
```

既不影响文档行数(光标可正常上下移动),又让公式在编辑区内独占一行居中显示;只有单行写法 `$$E=mc^2$$` 才做整体替换。

**导出层**:`services/exportHtml.ts` 给 markdown-it 补了 `imath_inline`(行内规则)与 `imath_block`(块级规则)两条最小实现,渲染时同样调用 KaTeX;KaTeX 的 CSS 以 Vite 的 `?raw` 方式内联进导出文件(字体 URL 重写到 CDN),使导出的 HTML 双击即可在浏览器中看到公式排版。

#### Mermaid 图表

```` ```mermaid ```` 围栏块沿用与表格/块级公式相同的跨行手法:光标在块外时,首行替换成 `MermaidWidget`,其余行清空并折叠;光标进入围栏或点击图表即退回等宽源码。渲染服务在 `services/mermaid.ts`,编辑器 widget 与导出 HTML 共用同一条路径。

- **异步渲染**:`mermaid.render` 返回 Promise,而 `WidgetType.toDOM()` 必须同步。`toDOM` 先给出占位框,结果回来再写入;写入前用 `isConnected` 确认 DOM 没被 CodeMirror 回收。
- **异步撑高后的重新测量**(踩过的坑):只调 `view.requestMeasure()` 不够。CodeMirror 仅在 `.cm-content` 总高度变化时才重读各行高度,而短文档的高度被视口/内边距托住 —— 图表从 48px 占位框长到几百 px 时总高度可能不变,行高缓存就一直停在旧值(实测 113px vs 实际 284px),鼠标点击按旧高度映射,点图表中心会把光标送到文末。所以 widget 用 `ResizeObserver` 监听自身尺寸,并在回调里显式置位 `viewState.mustMeasureContent`(CodeMirror 自己 DOM 重绘时用的同一个开关)后再 `requestMeasure()`。
- **动态 import + 串行队列 + 缓存**:Mermaid 体积大,第一次遇到图表才加载;`mermaid.render` 会在 `document.body` 里挂临时容器,并发渲染会互相踩,因此服务层用一条 Promise 队列串行化;结果按「主题 + 源码」缓存(滚动/击键都会让装饰层整体重建,同一段源码会被反复索取)。
- **主题**:配色是渲染时烘进 SVG 的,不是 CSS 变量。WYSIWYG 扩展用 `MutationObserver` 盯 `<html data-theme>`,主题一变就借 `pendingRetry` 触发一次完整重建;`MermaidWidget.eq()` 比较 `theme`,旧图会被新配色的 widget 替换。
- **图标**:启动时本地注册 `@iconify-json/lucide`(与应用自身图标同源),支持 `A@{ icon: "lucide:user", form: "square" }` 这类 icon shape;图标包按需加载,不走网络。
- **导出**:markdown-it 的 fence renderer 把 mermaid 块替换成带序号的占位 div,全文渲染完再异步填入内联 SVG;单块语法错误降级成带源码的错误块,不影响整份导出。导出固定用亮色主题(模板本身是亮色)。

### 三、样式模块

所有样式收敛到 `src/renderer/src/styles/` 一个模块,核心侧只写一行 `import './styles'`:

```
styles/
├── index.ts        # 模块入口:聚合导入(顺序即层叠顺序)+ 导出运行时注入的注册表
├── registry.ts     # 样式注册表(运行时注入/卸载/排序)
├── base.css        # 全局 reset 与基础排版
├── shell.css       # 应用外壳:三栏布局、侧栏(文件列表/大纲)、状态栏
├── editor.css      # CodeMirror 外观与所见即所得样式(标题/强调/代码/公式/widget)
└── components/     # 独立组件:快速切换器、仓库选择界面、设置面板、自定义样式列表

src/shared/theme/
└── tokens.css      # 设计令牌:CSS 变量,两档主题(亮/深色)都在这
```

令牌文件放在 `shared/theme/` 是因为它现在有**三个**消费方:渲染层正常 import、主进程用 `?raw` 内联(给扩展窗口下发 CSP 下可用的样式)、扩展 preload 用 `webFrame.insertCSS` 注入。同一份文件三处消费,扩展窗口的配色才可能与应用逐字一致 —— 各存一份迟早漂移。

- **手动导入(核心)**:`main.ts` → `import './styles'`;组件与服务不再各自引用 CSS 文件,层叠顺序集中维护。
- **运行时注入(注册表)**:`styles/registry.ts` 提供 `registerStyle(id, css)` / `unregisterStyle(id)`,
  把一段 CSS 作为 `<style>` 注入与卸载,不需要任何文件路径约定。
  注入落在 head 末尾,所以**同特异性下必然赢过内置样式**:

  ```ts
  import css from './my-plugin.css?inline'            // Vite ?inline:读成字符串,不自动注入
  import { registerStyle, unregisterStyle } from '@renderer/styles'

  export function activate() { registerStyle('my-plugin', css) }
  export function deactivate() { unregisterStyle('my-plugin') }
  ```

- **第一个调用方是用户自定义样式**,不是扩展:数据目录的 `css/` 由主进程读出来
  (`main/userStyles.ts`),渲染层把**选中的那一项**注入成 `user:<名字>`
  (见 `services/userStyleService.ts`)。同时只有一项生效,所以没有「谁盖过谁」这回事 ——
  注册表的插入顺序在这里不影响任何东西。目录项送过来的是一份**拼好的**文本(主进程按
  相对路径顺序收齐),所以注入侧不必知道候选是文件还是目录。
- **扩展宿主与 webview 都拿不到这个内部注册表**。扩展代码没有应用内部的模块解析,`registerStyle` 也不对外暴露;webview 跑在 `imark-webview://` 的独立 origin 里,与宿主隔离。扩展要在 webview 里用样式,自己写 `<style>` 或用 `asWebviewUri` 引用包内 CSS(建议带自己的类名前缀),并自行负责清理;宿主会把当前主题的颜色令牌注入成 CSS 变量。
- **样式约定**:扩展若要注入 CSS,类名加 `imk-` 前缀(内置样式用语义化类名,不加前缀);颜色/边框一律用 `tokens.css` 的变量(亮/深色两档主题自动适配);需要覆盖 CodeMirror base theme 已有属性时须走 `EditorView.theme`(外部 CSS 会因特异度不足被静默忽略)。

#### 用户自定义样式(`<数据目录>/css`)

- 目录在**数据目录**下(`css/`,默认 `<应用目录>/.imark/css`,见 §八):整个 iMark 的数据都在那一个目录里,用户也用得上自己熟悉的编辑器与备份工具;应用目录不可写时回退到家目录。首次启动创建,并播种一份**全文注释**的 `example.css`(有一条真规则生效就等于替用户改了默认外观);用户删掉它不会再被塞回来,删掉整个目录才重建 + 重播种。
- **同时只有一项生效**,候选是顶层每一项:`.css` 文件(单独生效)或**子目录**(递归收它下面所有层级的 `.css`,按相对路径顺序拼成一份)。「选中哪个」是设置项(`settings.userStyle`,只存名字不存内容),在设置面板「外观」里点一行选中、**再点一次取消**;默认不选(什么都没选 = 不使用自定义样式)。多项同时生效意味着「谁赢」要靠文件名顺序去推,用户看到的是一份说不清的叠加结果。
- **选中的那一项不在了就什么都不生效**,不自动改选别人(那会莫名其妙地换掉你的外观);把同名的东西放回来它立刻又生效。界面上会直说「「x」已经不在了」,否则「没有任何一行被选中」看着像坏了。
- **导入**:「导入 CSS 文件」收单个文件,「导入 CSS 文件夹」把一个文件夹**整棵**复制成样式目录(只带 `.css`,保留子目录结构,跳过点文件/点目录 —— 一个 `.git` 跟着进来会成为永久噪音)。两者都是**复制**进目录,不引用原路径。**内容相同的直接不导,并列出与哪几份相同** —— 同一个文件点两次「导入」是最容易发生的事,让它悄悄什么都不发生只会让人以为按钮坏了(目录比的是「相对路径 + 归一化正文」这份指纹)。重名但内容不同则改叫 `foo-2.css`,绝不覆盖(目录里那份可能已经被你改过)。
- 主进程负责全部文件系统访问:只收 `.css`、跳过点文件与点目录、单个文件 ≤512 KiB、剥掉 BOM(记事本存的 UTF-8 带 BOM 会让第一个选择器静默失效)。**读清单永不抛** —— 一个坏文件只让它自己标红,其余照常生效;目录里读不动的那几个跳过、在行上标出「N 个读不动」,不影响目录里其余文件。
- 变更靠 `fs.watch`(`recursive`) + 250 ms 防抖,改完保存即刻生效(子目录里存一次盘也算)。**Windows 上删掉正在监听的目录是静默事件**(既不派发事件也不派发 `'error'`),所以另有一个每 4 秒一次的存在性检查兜底 —— 目录没了就重建、重挂、把「样式已全部撤下」播出去。
- CSS 里的 `var(--accent)` 这类变量在计算值阶段解析,所以**切主题时不需要重新注入**,自定义样式自动跟随两档主题。
- 边界(如实写在设置面板与示例文件里):样式作用于**整个界面**;语法错误被浏览器静默丢弃;`.cm-cursor` / `.cm-scroller` / `.cm-content` 这类 base theme 写死的属性要加 `!important`;图片只能用 `data:` / `https:` / `imark://`(`@import` 远程样式表与 `file://` 图片会被 CSP 拦掉,相对路径也不工作)。**不影响导出的 HTML** —— 导出是另一套模板。

### 四、扩展系统

iMark 的扩展模型与 **VS Code 扩展**一致:扩展清单是一份普通的 `package.json`,代码跑在独立的 `utilityProcess` 扩展宿主里,通过 `require('imark')` 拿到 API。扩展代码以当前用户权限运行,不做权限沙箱。

> **信任模型(请先读这一段)**
>
> **扩展代码以当前用户的权限运行,不做权限沙箱。** 含代码的扩展可以读写你的任意文件(笔记、SSH 密钥、`secrets.json`)、发起网络请求、启动其他程序。清单里的 `capabilities` 是**安装披露**,不是运行时门禁。安装确认框会要求你对含代码扩展主动勾选「我知道扩展代码将以我的用户权限运行」;详情页可以查看将要执行的源码。**只安装你信任来源的扩展。**

#### 包与安装

- 扩展目录根部是一份 `package.json`(唯一清单),可选 `main` 入口(CommonJS)与 `webview/**` 资源;
- 打包成单文件信封 `.imkpkg.json`:`files` 记路径/size/sha256,`data` 存 base64;`integrity = sha256(stableStringify({ manifest, files }))`(递归键排序,打包器、服务端、客户端三处同构);
- 安装后落在数据目录的 `plugins/<publisher>.<name>/`,启用态与配置在 `settings.json` 的 `extensions.<id>`,密钥经 `safeStorage` 加密后存 `secrets.json` 且**明文不出主进程与扩展宿主**;
- 配置项默认全局一份;清单里给字段加 `"imark": { "scope": "workspace" }` 后,设置页的修改会写进**当前仓库的覆盖层**(同一条配置在 `settings.json` 里按仓库根目录分开保存),扩展侧 `getConfiguration()` 读到的仍是合并后的值。未覆盖时回落到全局值,再回落到默认值。密钥始终全局;
- 安装是原子的:先解到 `.staging/`,全部校验通过后 rename 就位;失败回滚,不留半份目录;
- 卸载会删除程序文件、配置、密钥、`globalState` 与日志。

#### 宿主拓扑

扩展代码**永远不 require 在主进程里**。宿主有两种拓扑:

| 模式 | 行为 | 崩溃半径 |
|---|---|---|
| `shared`(默认) | 所有扩展共用一个 `utilityProcess` 宿主 | 同宿主内的**所有扩展**一起重启 |
| `isolated` | 每个扩展一个宿主 | 只影响该扩展;按 1s/2s/4s 退避重启,60 秒三次后停止 |

`settings.extensionHost = { mode: 'shared' | 'isolated', affinity: Record<id, number> }`。`affinity` 里相同正整数(未列出或 0 = 按模式自动分组)的扩展分到同一宿主;清单里的 `extensionAffinity` 也参与分组。「设置 → 扩展分配」页可以切换模式、设置分组编号,并查看每个宿主的 PID/内存/状态。

启用态驱动全部界面:扩展被禁用后,它贡献的命令、快捷键、状态栏、行首菜单会立即消失;没有激活过的扩展不会 fork 宿主。

#### 关键代码

| 文件 | 职责 |
|---|---|
| `shared/extensionPackage.ts` | 清单/信封、校验、stable integrity、`configuration → 设置字段` 翻译;主进程、构建脚本、服务端共用同一套规则 |
| `shared/extensionApi.ts` | 扩展作者看到的 `imark` 模块(类型 + `Uri` / `Position` / `Range` / `EventEmitter` / `Disposable` 等纯工具类) |
| `shared/extensionProtocol.ts` | 宿主 ↔ 主进程的协议 DTO |
| `main/extensions/service.ts` | `ExtensionService`:安装/启用/配置/密钥/激活事件/宿主规划/命令路由/崩溃重启 |
| `main/extensions/installer.ts` | 包校验与安装(`validateEnvelope` + 逐文件 sha256 + integrity) |
| `main/extensions/hostPlanner.ts` / `hostProcess.ts` | `isolated` / `shared` / affinity 分组与 `utilityProcess.fork` |
| `main/extensions/hostRuntime.ts` | 宿主内运行时:`require('imark')` 注入、命令/配置/密钥/文档/装饰/webview |
| `main/extensions/installedStore.ts` / `paths.ts` | `installed.json` 登记、磁盘布局 |
| `main/market/*` | 市场客户端(见 §五) |

**激活事件**:`*`、`onStartupFinished`、`onLanguage:markdown`、`onCommand:<命令>`、`onWebviewPanel:<viewType>`。没有命中的扩展保持未激活;命令执行、面板恢复、依赖激活都会按需拉起宿主。

**内置扩展**:`quick-edit`、`git-sync`、`agent`(Agent Core)、`claude-code`(Claude Code)随应用带一份包,启动时由 `ensureBundledProvisioned()` 补装(走**完全相同**的校验与安装路径)。官方扩展只认内置包:开发阶段四款版本统一固定为 `1.0.0`,补装按整包 integrity 对齐,内容有变化就整包覆盖;同 ID 的本地/市场安装也会被内置包替换。默认启用策略写在 `main/market/bundled.ts`:quick-edit 开箱启用,其余三款默认关闭;Claude Code 依赖 Agent Core,内置包按依赖顺序补装。

### 五、扩展市场

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
| GET | `/api/v1/search?q=&page=&sort=&hasMain=` | – | 搜索 / 排序 / 按「含代码 / 纯声明」过滤 |
| GET | `/api/v1/packages/:id` \| `/latest` \| `/versions/:v` | – | 详情(含 README、版本列表、下架标记) |
| GET | `/api/v1/packages/:id/versions/:v/download` | – | 信封字节 + `X-Imk-Integrity` 响应头,下载计数 +1 |
| GET | `/api/v1/packages/:id/icon` | – | 图标字节(≤128 KiB) |
| POST | `/api/v1/packages` | Bearer | 发布:信封 JSON |
| POST | `/api/v1/packages/:id/versions/:v/yank` \| `/unyank` | Bearer(owner) | 下架 / 恢复 |

列表/详情返回扩展字段:`displayName`、`main`、`hasMain`、`activationEvents`、`capabilities`、`contributesSummary`(命令/快捷键/设置项/行首菜单/动作计数)。另有 `GET /api/v1/users/:username/packages`(某作者的全部扩展)与 `/api/v1/admin/*`(统计、把被抢注的 id 转移给真正的作者,需 `ADMIN_TOKEN`)。

**发布**:注册账号(scrypt 加盐哈希,密码 ≥8 位)→ 在「发布扩展」页选目录 → 打包预览(文件清单、形态、体积、整包 sha256、入口 sha256、激活事件与贡献摘要)→ 发布。服务端会**重算**逐文件 sha256 与整包 integrity,不符就 400;`formatVersion` 必须是 1。`<publisher>.<name>` 首次发布即被该账号认领,别人再发同 id → 403;同一个 `(id, 版本)` 不能重发(409)—— 已发布的版本不可变,要改就升版本号。版本可以**下架**(yanked):下架后从搜索、`latest` 与版本列表里消失,但按精确版本号仍能下载;下架当前最新版时,次高的非下架版本会自动成为 latest。**没有硬删除。**

**安装**:下载 → 把响应头声明的 integrity 与自算的比对 → `validateEnvelope()`(结构、路径、扩展名、体积、逐文件 sha256、integrity)→ 检查 `engines.imark` 是否满足 → 解到 `.staging/` → 原子就位 → 写 `installed.json` → 重新扫描并热加载。任何一步失败都不落盘。更新检查在启动后、打开市场页时、手动刷新时各跑一次,结果缓存 10 分钟;**绝不循环重试** —— 离线是正常状态,界面安静降级。

**安装确认框是安全基线**。按下按钮之前,它必须摆出:扩展名 / 版本 / 发布者 / 来源地址、含代码还是纯声明、文件数与总体积、可跨渠道核对的整包 sha256、入口 sha256、激活事件、能力声明与贡献摘要。**含代码扩展必须主动勾选**「我知道扩展代码将以我的用户权限运行,可以读写我的文件、访问网络」,否则安装按钮不可用;纯声明式扩展不需要勾选。详情页另配「**查看源码**」:显示的内容与将要安装的那份**来自同一次下载、过了同一套校验**,不是另取的一份「参考源码」。

**要如实说明的边界**

- **含代码扩展 = 当前用户权限下的任意代码执行。** 它能读写你电脑上的任意文件、发起网络请求、启动其他程序。sha256、发布者、能力声明、确认框、崩溃重启降低的是**误装**的概率、让**决策知情**,它们**不做沙箱**。
- 默认市场地址 `http://127.0.0.1:8787` 是**明文**的(且只监听回环)。填非回环的 `http://` 地址时界面会给一次性警告;正式部署必须自己前置 TLS 终止。
- 发布是「**已认证但不审计**」:任何能注册的人都能认领一个还没被占用的 id。共享的注册表上,官方 id 应当先占掉。
- 服务端按 IP 的内存限流(10 次失败 / 5 分钟)只够自托管;公开部署需要真正的限流组件与审计。

**官方扩展:定时上传(Git)**

按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意远端,可配置**多个远端**(一次提交推全部);动作有「立即上传」「测试连接」「检测代理」,状态栏有同步图标(成功 / 失败 / 进行中 / 未启用四态)。同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交。

- **凭据既不落盘也不进命令行**:推送时 URL 保持干净(不带 `user:token`),而是临时挂一个一次性 credential helper(`-c credential.helper=` + `-c credential.helper=!f(){…}`),用户名与 token 从子进程**环境变量**读取(`GIT_IMK_USER` / `GIT_IMK_TOKEN`)。这样既不会把 token 写进 `.git/config`,也不出现在进程命令行里;同时固定 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never`,缺凭据时快速失败。
- **全链路脱敏**:任何要展示、写状态或落盘的 git 输出都先过 `redactUrl()`,把 `://user:token@host` 洗成 `://user:***@host`;失败按类型翻成可操作的中文提示(远端有新提交被拒 / 认证失败 / 连不上 / 仓库不存在)。
- **远端配置项**(每个远端一行):**远程仓库**(必填,HTTPS 或 SSH 地址)+ **本地分支**(必填)/ **远程分支**(留空则与本地分支同名)+ **认证方式**(访问令牌 / 账号密码 / SSH)。密钥经 safeStorage 加密保存,界面上只显示**掩码**;点「更换」才展开输入框。
- **首次同步会做的事**(都可在扩展设置里关闭):不是 git 仓库时 `git init -b <分支>`;写入推荐 `.gitignore`(`.obsidian/`、`node_modules/`、`.imark-tmp` 等,**已存在则不覆盖**)。**扩展不改动仓库的 remote 配置**。
- **它只做上传**:不替你处理仓库层面的疑难(远端已有无关历史、两边都改过同一文件、需要合并或变基等)。遇到这类情况会**如实报错**,请你在仓库目录自己用 git 处理完再点「立即上传」。
- **配置改完会自动试跑一次**(3 秒后),避免「先启用(还没填远端)→ 启动同步当场失败并被消耗 → 干等一个间隔」。
- **边界**:定时器跑在扩展宿主进程里,而应用是「窗口全关即退出」(无托盘),所以**关掉应用期间不会上传** —— 用「启动后同步一次」弥补。

### 六、扩展开发

#### 目录与构建

```text
my-extension/
├── package.json     # 清单:ID、版本、engines、main、activationEvents、contributes
├── main.ts          # 可选入口 → 构建成 main.js(CommonJS)
├── webview/         # 可选:webview 的 ts/html/css(ts 打成 IIFE)
└── README.md
```

官方扩展用 `plugins-src/tsconfig.json` 一份工程编译,作者也可以直接写普通 `.js`:

```bash
npm run plugins:build   # esbuild 打包 → src/main/market/builtin/<publisher>.<name>.imkpkg.json
npm run typecheck:plugins
```

- `main.ts` 用 esbuild 打成 CommonJS,`imark` 外置(由宿主注入),Node 内置模块自动外置;
- `webview/*.ts` 打成 IIFE(依赖全部内联),`webview/shared.ts` 不作为入口;
- 静态资源原样复制;`package.json` 只进 `envelope.manifest`,不作为包内文件;
- 文本文件以 LF 进包,保证 Windows/Linux 构建逐字节一致。

#### 清单(`package.json`)

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
  "capabilities": { "filesystem": "workspace", "network": true, "secrets": true },
  "contributes": {
    "commands": [
      { "command": "your-name.my-extension.hello", "title": "打招呼", "category": "示例" }
    ],
    "keybindings": [
      { "command": "your-name.my-extension.hello", "key": "ctrl+alt+h" }
    ],
    "menus": {
      "commandPalette": [{ "command": "your-name.my-extension.hello", "when": "editorTextFocus" }]
    },
    "configuration": {
      "title": "我的扩展",
      "properties": {
        "your-name.my-extension.greeting": {
          "type": "string",
          "default": "你好",
          "title": "问候语",
          "imark": { "kind": "text", "section": "常规" }
        }
      }
    },
    "imark.lineMenu": [
      { "id": "hello", "label": "打招呼", "command": "your-name.my-extension.hello" }
    ],
    "imark.actions": [
      { "command": "your-name.my-extension.hello", "label": "打招呼" }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `publisher` / `name` | ✔ | 各自 `^[a-z0-9][a-z0-9-]{1,63}$`;扩展 ID 是 `<publisher>.<name>` |
| `version` | ✔ | 语义化版本(可带预发布后缀) |
| `engines.imark` | ✔ | 依赖的 iMark 版本范围,如 `^1.0.0` / `>=1.0.0` |
| `main` | | 包内 `.js` / `.cjs` 入口。不填 = 纯声明式 |
| `displayName` / `description` / `author` / `license` / `homepage` / `icon` | | 展示与署名;`homepage` 必须是 https |
| `activationEvents` | | `*`、`onStartupFinished`、`onLanguage:markdown`、`onCommand:<命令>`、`onWebviewPanel:<viewType>` |
| `extensionDependencies` | | 依赖的扩展 ID;强制分到同一宿主并先激活依赖,同宿主内可读依赖的 `exports` |
| `extensionAffinity` | | 希望与哪些扩展分到同一宿主(参与 affinity 分组) |
| `capabilities` | | 安装披露:`filesystem: workspace\|user`、`network`、`secrets`、`git`、`process`、`shell` |
| `contributes` | | 命令 / 快捷键 / 命令面板菜单 / 设置 / 行首菜单 / 动作 |
| `categories` / `keywords` | | 市场展示用 |

`icon` 是包内相对路径,支持 PNG / SVG(≤128 KiB);设置左栏、扩展设置页头与「已安装」页会显示它,未声明时这些位置不占位。

`configuration.properties` 的键**必须以扩展 ID 开头**(`your-name.my-extension.xxx`),卸载时宿主按这个前缀清理配置;每个属性必须有 `default`(设置页需要它作为初始值)。`imark` 元数据支持 `kind`(text/textarea/password/number/boolean/select/targets/endpoints/external)、`label`、`description`、`section`、`showWhen`、`rows`、`resettable`、`required`、`placeholder`、`endpointModel`、`targetSecret`、`options`。

`kind: "external"` 的字段直接读写扩展包外的 JSON 配置文件,值的唯一事实是那个文件(例如 Claude Code 的 `~/.claude/settings.json`)。元数据用 `file`(支持 `~`)、`dirEnv`(用该环境变量替换父目录)、`pointer`(JSON 指针,如 `/env/ANTHROPIC_BASE_URL`)与 `secret`(按密码框显示)声明位置;渲染层只提交扩展 ID 与字段键,路径解析和目标校验都在主进程完成,其它字段原样保留。

包内文件规则:相对 POSIX 路径、无 `..`、深度 ≤4、扩展名白名单(`js/mjs/cjs/json/md/txt/css/html/htm/svg/png/jpg/jpeg/gif/webp/ico/woff/woff2/ttf/otf/wasm/bcmap`)、单文件 ≤8 MiB、入口 ≤8 MiB、README ≤512 KiB、图标 ≤128 KiB、整包 ≤16 MiB、文件数 ≤96。路径里任何一段都不能是 `__imark`。

#### 入口与 API

```ts
// main.ts
import * as imark from 'imark'

export function activate(context: imark.ExtensionContext): void {
  context.subscriptions.push(
    imark.commands.registerCommand('your-name.my-extension.hello', () => {
      imark.window.showInformationMessage('你好')
    })
  )

  const channel = imark.window.createOutputChannel('我的扩展')
  channel.appendLine('已激活')
  context.subscriptions.push(channel)
}

export function deactivate(): void {
  // 所有挂在 context.subscriptions 上的东西会被自动 dispose;这里只收尾
}
```

`require('imark')` 提供的命名空间:

| 命名空间 | 内容 |
|---|---|
| `commands` | `registerCommand` / `executeCommand` / `getCommands` |
| `window` | 消息框、输入框、QuickPick、状态栏、输出通道、装饰类型、文本编辑器、`createWebviewPanel` / `registerWebviewPanelSerializer` |
| `workspace` | `workspaceFolders`、`getConfiguration`、文档打开/保存/变更事件、`openTextDocument`、`saveAll`、`workspace.fs` |
| `extensions` | `getExtension(id)` / `extensions.all`;同宿主内的依赖方可以读 `extension.exports` |
| `env` | `appName` / `appVersion` / `language` / `uriScheme` / `machineId` / `sessionId` |
| `imark` | iMark 私有入口:`reportStatus()`、`renderMarkdown()`、`flushActiveDocument()`、`onDidChangeTheme` |
| 工具类 | `Uri`、`Position`、`Range`、`Selection`、`EventEmitter`、`Disposable`、`ThemeColor`、`StatusBarAlignment`、`ViewColumn`、`TextEditorRevealType`、`ConfigurationTarget` 等 |

与 VS Code 的差异:模块名是 `imark`;没有 TreeView / 终端 / 任务 / 调试 / LSP / notebook / 多根工作区;`imark.imark` 是私有命名空间。

#### Agent 后端扩展(provider)

Agent Core 不带具体后端;后端是独立扩展,通过贡献点登记,由 Core 在需要时激活:

```json
{
  "name": "my-agent-backend",
  "main": "./main.js",
  "extensionDependencies": ["imark.agent"],
  "contributes": {
    "imark.agentProviders": ["my-backend"]
  }
}
```

```ts
// main.ts —— 返回值就是 imark.extensions.getExtension(id).exports
// 类型对照 src/shared/agentProvider.ts;这里只写运行时结构
export function activate() {
  return {
    apiVersion: 2,
    providers: [
      {
        info: {
          id: 'my-backend',
          label: '我的后端',
          capabilities: {
            roles: ['assistant'],
            inputs: { image: 'none', pdf: 'none', file: 'path' },
            tools: { read: true, bash: false, write: false },
            streaming: true,
            thinking: false,
            resume: false,
            systemPrompt: true
          }
        },
        detect: async () => ({ available: true }),
        createSession: async options => ({
          providerSessionId: undefined,
          send: async function* () { /* yield AgentEvent */ },
          respondPermission: (requestId, decision) => {},
          cancel: () => {},
          dispose: async () => {}
        })
      }
    ]
  }
}
```

- 贡献点必须是非空数组(最多 8 个),id 形如 `my-backend`;同时**必须**通过 `extensionDependencies` 依赖 `imark.agent`,否则清单校验与安装都会被拒绝。
- `extensionDependencies` 同时保证 provider 与 Core 在同一宿主;`exports` 是进程内对象,**跨宿主读不到**。
- provider 不需要 `activationEvents`;Core 的 `ProviderRegistry` 在首次列后端时才 `activate()` 它,避免与 Core 自己的激活互相等待。
- provider 自己读自己的 `contributes.configuration` 与 `context.secrets`;Core 不读取、不转发后端专属设置。CLI 不存在或启动失败时,`detect()` / `createSession()` 返回 `provider-unavailable` 错误。
- 模型由 provider 自己的配置文件决定,Core 不传也不保存;`detect()` 可以返回 `defaultModel`,对话面板只把它当只读名字显示。
- 完整契约见 `src/shared/agentProvider.ts`,内置示例见 `plugins-src/claude-code/`。

#### 配置、密钥与状态

- **配置**:`workspace.getConfiguration('your-name.my-extension')` 读;`update(key, value)` 写回 `settings.extensions.<id>.config`。设置页由 `contributes.configuration` 自动渲染,不需要写界面。`password` 字段与 `targets` / `endpoints` 的目标级密钥走 `secrets`。
- **密钥**:`context.secrets.get/store/delete(key)`。值只在主进程 `safeStorage` 与扩展宿主内存里;渲染层与 webview 永远拿不到明文。界面只显示掩码。
- **状态**:`context.globalState` / `context.workspaceState`(跨启动保留)、`context.globalStorageUri` / `context.storageUri`(扩展私有文件目录)、`context.logUri` / `context.logPath`(日志)。`globalState` 在退出前异步刷盘。
- **输出与日志**:`window.createOutputChannel(name)` 写入扩展日志;`context.logPath` 是原始日志文件。设置页可直接打开日志。

#### webview

```ts
const panel = imark.window.createWebviewPanel(
  'your-name.my-extension.chat',
  '我的面板',
  imark.ViewColumn.Beside,
  {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
    imark: { presentation: 'sidebar', width: 420 }
  }
)
panel.webview.html = `<!doctype html><html><body>…</body></html>`
panel.webview.onDidReceiveMessage(message => { /* … */ })
panel.webview.postMessage({ type: 'hello' })
```

- webview 跑在独立的 `imark-webview://<扩展 id>/…` origin 与独立 session 里,**与宿主隔离**;脚本只能通过 `postMessage` 与扩展通信。
- `webview.asWebviewUri(uri)` 把包内资源变成可加载的 URL;`webview.cspSource` 用于拼 CSP。`localResourceRoots` 之外的路径会被协议层拒绝。
- `presentation` 支持 `sidebar` / `overlay` / `floating`;`panel.imark.setPresentation/setSize/setPosition` 可在运行时调整。
- `panel.imark.setStatus('idle' | 'busy')` 控制标题栏左侧的状态点:绿点表示空闲,强调色脉冲表示忙碌。
- 用 `window.registerWebviewPanelSerializer(viewType, serializer)` 让面板在重启后恢复(`deserializeWebviewPanel` 重新生成 HTML)。

#### 行首「+」菜单与动作

清单里声明 `imark.lineMenu` 后,宿主会在光标行左边画「+」;条目指向一个必须在 `contributes.commands` 里声明过的命令,可选 `dialog` 参数表单(字段 kind 限 text/number/boolean/select):

```json
{
  "id": "table",
  "label": "表格",
  "command": "your-name.my-extension.insert-table",
  "dialog": {
    "title": "插入表格",
    "confirmLabel": "插入",
    "fields": [
      { "key": "rows", "kind": "number", "label": "行数", "default": 3 },
      { "key": "cols", "kind": "number", "label": "列数", "default": 3 }
    ]
  }
}
```

命令回调收到 `(args)`;需要改文档时用 `workspace.openTextDocument` + `window.showTextDocument` + `TextEditor.edit`,或 `imark.imark.flushActiveDocument()` 先落盘。`imark.actions` 让设置页出现动作按钮;`scope: "target"` + `targetSetting` 指向一个 `targets` / `endpoints` 配置键,可按目标逐个执行。

动作结果**只写进设置页的状态卡**:用 `imark.imark.reportStatus()` 上报状态(可带 `targetResults` 让每个目标单独着色),不要再调用 `showInformationMessage` / `showWarningMessage` 弹右下角通知。右下角通知只留给面板之外的运行时事件(例如没有打开文档、宿主启动失败、后台任务报错);同一条结果不要同时出现在状态卡和通知里。

#### 发布

在「发布扩展」页选目录 → 预览(文件清单、形态、体积、整包 sha256、入口 sha256、激活事件、贡献摘要)→ 发布。服务端重算逐文件 sha256 与整包 integrity,不符就 400。`<publisher>.<name>` 首次发布即被账号认领;同一 `(id, 版本)` 不可重发。版本可以下架,没有硬删除。

**再次提醒**:扩展代码以当前用户权限运行,市场上架与安装确认只保证「知情」,不提供沙箱。请只发布、安装可信来源的扩展。

### 七、其他子系统

- **仓库(Vault)工作流**:主进程 `vault.ts` 用 `fs.promises.readdir` 递归列目录(跳过隐藏目录与 `node_modules`/`.obsidian` 等),渲染层 `vaultService.ts` 负责状态与流程编排;删除走 `shell.trashItem`(系统回收站),新建/重命名走专用 IPC——渲染层不直接触碰文件系统。
- **多开与仓库占用**:`main/vaultHandoff.ts` 用数据根下的占用文件(`instances/<仓库哈希>.json`,原子 `wx` 创建)+ 本机 IPC(Windows 命名管道 / 其他平台 Unix socket)协调:同一个仓库只保留一个窗口。打开前由渲染层经 `vault:claim` 认领;已有窗口时把请求转过去、聚焦那个窗口并递上文件。联系不上主人时返回 `busy`,宁可提示也不开第二个窗口写同一批文件。
- **进程边界与安全**:系统能力经 `contextBridge` 暴露的**一次性取用函数**交给 `services/api.ts`(类型定义在 `shared/api.ts`),扩展脚本拿不到 IPC 桥;渲染层开启 `sandbox`、无 Node 集成;外链在打开前于主进程校验 `^https?://`,本地图片走自定义 `imark://` 特权协议(编码绝对路径,由主进程读取后返回,规避 `file://` 的编码与安全限制)。
- **主题**:两档主题(亮/深色)全部由 CSS 变量驱动(变量定义在 `shared/theme/tokens.css`,见 §三),CodeMirror 侧通过 `EditorView.theme` 引用 `var(--…)`。注意:base theme 已定义过的 `.cm-*` 属性必须写在主题扩展里,外部 CSS 会因特异度不足被静默忽略。
- **导出 HTML**:markdown-it(代码高亮用 highlight.js)+ 内联样式模板,输出单文件。

### 八、数据放在哪(备份与重置)

iMark 的所有数据都在**应用自己所在的目录**里:安装版是 `<安装目录>\.imark`(你把 iMark 装在 `D:\imark`,数据就在 `D:\imark\.imark`),开发版是 `<仓库>\.imark`(已加入 `.gitignore`)。

> **为什么不在家目录**:把应用目录整体拷到另一台机器/另一个盘,数据和程序一起走,不用去 `%APPDATA%` 里翻;也不会因为 C 盘空间紧张而把笔记应用的数据留在系统盘上。
> **例外**:应用目录**不可写**时(装进 `Program Files`、Linux AppImage 的只读挂载、macOS 的 `.app` 包)会自动回退到家目录 `~/.imark`,启动日志里会写明实际用的是哪个。

```
<应用目录>/.imark/
├── css/               自定义样式(§三)
├── plugins/           扩展包 + installed.json + .staging/ + <id>.old/
├── instances/         多开协调:哪个实例正开着哪个仓库(临时文件,退出即清)
├── settings.json      仓库列表、上次打开的文件、界面偏好、扩展启用态与配置
├── secrets.json       扩展访问令牌、市场登录令牌(**safeStorage 加密**,不是明文)
├── profile/           Chromium 自己的 profile:缓存、Cookie、webview 的分区存储……
│                      ↑ 解密密钥(Local State)也在里面,别单独删它
└── profile-2/ …       第二个及以后的同时运行实例各用一份(见下方「多开」)
```

- **备份**:拷 `<应用目录>/.imark` 即可。最少要含 `plugins/` + `secrets.json`(只拷配置不拷密钥,扩展会认为你没填过令牌);`profile/` 是缓存与登录态,可以不拷。
- **升级/卸载前请先备份**:数据放在安装目录里,而安装器/卸载器可能会覆盖或删除安装目录中的文件。移动整个应用文件夹时,数据会跟着走(这正是这个布局的好处);但**用安装器升级/卸载**时建议先把 `.imark` 拷出来。
- **彻底重置**:退出应用 → 删掉 `<应用目录>/.imark` → 重启。设置、扩展、令牌、缓存一起清空。
- **换机器**:数据拷过去后 `settings.json` / `plugins/` 直接可用,但 `secrets.json` 里的令牌要重填 —— 加密密钥绑当前 Windows 用户(DPAPI),换用户或换机器都解不开,扩展那边表现为"还没填令牌"。
- **`--imark-data-dir=<目录>`**(高级):把数据根指到别处(别的盘、U 盘)。单独使用时 profile 在 `<目录>/profile`;再配 `--user-data-dir=<目录>` 时,数据根是前者、profile 是后者。验收里就是用它把数据跑在沙箱内的(`verify/data-dir-harness.ts`)。
- **多开**:现在可以同时运行多个实例。设置、扩展包、`secrets.json` 这些数据根里的东西共用;Chromium 的 profile 则是**一个实例一份** —— 第一个用 `profile/`,之后依次用 `profile-2/`、`profile-3/`……。这样两个窗口不会互抢缓存与 Local Storage(同一份 profile 被两个 Chromium 同时写,实测会丢 localStorage),而扩展令牌仍然各窗口通用(Windows 上把主 profile 的 safeStorage 密钥抄给新槽位)。用 `--user-data-dir` 显式指定 profile 时仍是一个目录一个实例(验收靠它保证环境干净)。
- **同一个仓库只开一个窗口**:打开仓库时会在 `instances/` 里登记「这个仓库由哪个实例开着」;另一个实例再打开同一个仓库时,不会开新窗口,而是把已有窗口叫到前面。**双击 .md** 按目录归属决定:已有窗口的仓库目录包含这个文件 → 在那个窗口里打开并聚焦;否则新开窗口(文件属于某个最近仓库就载入那个仓库,不属于任何仓库则单独打开)。可用 `--imark-data-dir` 避开协调(两个数据根互不可见);切回仓库选择界面或退出时自动释放登记,崩溃留下的记录由下一个实例按 PID 回收。
- **Windows 任务栏「新开一个」**:中键或 Shift+点击任务栏图标,会在新进程里打开一个停在仓库选择页的窗口(设置里勾了「直接打开上次仓库」也不恢复)。实现方式是给窗口登记 AppUserModelID 与 `RelaunchCommand`(`iMark.exe --new-window`,见 `main/window.ts`),因为 Windows 不会给应用发「中键」事件,只会按这条命令再启动一份。普通再启动仍遵守上面的仓库占用规则;新窗口里再选一个已开着的仓库,同样会聚焦到那个窗口。
