# iMark

基于 **CodeMirror 6 + Electron + Vue 3** 的所见即所得(Obsidian Live Preview 风格)Markdown 编辑器。

作者:**Chuxiao Xiang** <13439022108@163.com>

## 功能

- **所见即所得编辑**:语法树驱动的装饰层——光标不在节点上时自动隐藏 `**`、`` ` ``、`#`、`](url)` 等标记,内容按样式渲染;光标进入即显形为原始语法。表格、图片、公式、Mermaid 图表这类「有形态的内容」直接渲染成真元素(表格连列对齐都按分隔行里的 `:` 还原)
- 标题(H1–H6)、粗体、斜体、删除线、行内代码、引用、无序/有序列表、分隔线
- 任务列表(可点击 checkbox,直接改写源码,可撤销)
- 代码块嵌套语言高亮(`@codemirror/language-data` 按需加载)
- **LaTeX 公式**(KaTeX 渲染):行内 `$E = mc^2$`、块级 `$$...$$`(支持跨行,居中显示);光标移入公式即翻回源码编辑,移出即恢复渲染;代码块内的 `$` 不受影响;导出 HTML 同样带公式
- **Mermaid 图表**(Mermaid 12 渲染):```` ```mermaid ```` 围栏在光标外整块渲染成 SVG,支持流程图、时序图、类图、状态图、ER 图、甘特图、饼图、思维导图、架构图等全部图种与 `%%{init}%%` 指令;本地注册 Lucide 图标包,可直接使用 `A@{ icon: "lucide:user" }` 这类 icon shape(无网络依赖)。光标移入或点击图表即翻回源码编辑,移出恢复;切换亮/深色主题会自动重渲染;导出 HTML 内联同一张 SVG,单块语法错误降级成错误块而不影响整份导出
- 链接 Ctrl+点击在系统浏览器打开;图片(本地相对路径走 `imark://` 自定义协议)光标外直接渲染;粘贴截图/剪贴板图片时自动存到文档旁的 `assets/` 并插入相对路径
- 文件:新建 / 打开 / 保存 / 另存为 / 拖拽 `.md` 入窗打开,窗口标题未保存圆点,关闭前脏检查
- **仓库(Vault)工作流**(仿 Obsidian):启动先进入 **仓库选择界面** —— 最近仓库列表(可移除记录)+「打开文件夹作为仓库」+「创建新仓库」;选定后进入编辑器
  - 文件浏览器侧栏(Ctrl+Shift+L):树形目录、新建文件/文件夹、重命名、删除(移到系统回收站)、刷新
  - 快速切换文件(Ctrl+P):全仓库模糊搜索,↑↓ 选择、Enter 打开
  - 状态栏左侧显示当前仓库名,点击回到仓库选择界面切换(有未保存内容时先询问)
  - 仓库选择界面底部可勾选「启动时直接打开上次使用的仓库」以跳过选择步骤
- **插件系统**:插件是**可装可卸可升级的包**,由两层组成 —— **main 层**(`mode: node` 主进程完整 Node,或 `mode: restricted` 隐藏沙箱页、能力逐次审批)与可选的 **render 层**(跑在主窗口渲染进程,直接拿 EditorView/CM6/DOM,但没有系统能力)。无代码插件仍可绑定宿主内置能力(如 Webhook)。设置面板「插件」分类统一管理:启用/停用、按字段表自动渲染配置表单、动作按钮、运行状态与错误详情;密钥类字段经 Electron safeStorage 加密后单独存于数据目录的 `secrets.json`(默认 `<应用目录>/.imark/secrets.json`),**渲染层永远拿不到明文**
  - **定时上传(Git)**:市场里的官方插件(应用内置同一份包作离线兜底)——按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意 Git 远端,可配置**多个远端**(一次提交推全部);另有「立即上传」「测试连接」动作,以及状态栏同步图标(成功/失败/进行中/未启用四态)。同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交
  - **高级表格(Advanced Table)**:同样是随应用预装、且**默认启用**的官方插件。光标所在行的左侧有一个「+」,点开 →「表格」→ 填行数与列数 → 确定,表格就插在这一行下面,并直接停在渲染出的表格里:点击任意单元格即可就地输入(Markdown 源码留在文档里,不再为了编辑把整张表翻回源码);回车换行、Tab 换格,在最后一格按 Tab 会自动加一行。表格四周有增删控件,但只在生效范围内浮现:鼠标放在哪一格,只出现该行/该列的删除「×」;靠近行/列边界线才出现插入「+」;整表选择 ▦、整表对齐 ≡ 与删除整表垃圾桶则**一直常驻**在表格右上角(纵向排成一列),点对齐按钮可选左对齐 / 居中 / 右对齐,同时作用于表头与正文。控件浮在表格周围且不占版式空间,表格本身不会因此移位;表格上下紧邻的结构空行保留在源码里(GFM / markdown-it / Obsidian 都把紧贴表格的非空行读成表格行,这两条空行是 Markdown 的要求),但渲染态下折成零高度、不接受光标;表格与上下正文的视觉距离由 `--md-table-gap-top` / `--md-table-gap-bottom`(或统一的 `--md-table-gap`)控制。方向键会越过整张表直接落到另一侧的正文行。表格的隐藏源码行同样不可输入:光标会被挪到表格外的正文行,输入法组合也写不进隐藏源码。按住左键上下拖动选中连续行、左右拖动选中连续列,或选中整表后,按 Backspace / Delete 删除;光标紧贴表格边上的第一行(上一行行尾 / 下一行行首)按 Delete/Backspace 时,第一次先选中整表,再按一次才删除,中间还隔着空行则只做普通的行合并、不碰表格;上一行行尾回车会在表格上方新增可编辑空行,光标不会跳进表格。它是「宿主代画 + 插件只出文本」的样板:按钮、菜单、对话框与插入全部由宿主实现,插件只声明 `lineMenu` 条目并返回要插入的文本(见 §四)。宿主画的是**共享槽位**,所有插件的 `lineMenu` 会合进同一个「+」菜单
- **插件市场**:仓库内自带零依赖自托管服务端(`npm run market`),应用里填地址即可**浏览 / 搜索 / 安装 / 查更新 / 发布**;安装前有安全基线确认框(逐条中文权限解释、体积、可跨渠道核对的 sha256、main/render 入口哈希、来源与发布者;node main 与 render 层分别要求勾选风险确认),并可**先查看源码**。详见下文「五、插件市场」
- 无菜单栏界面(仿 Obsidian):原生菜单只是隐藏(`setMenuBarVisibility(false)`),Ctrl+N/O/S、Ctrl+P、Ctrl+J、F12 等加速键照常生效,按 Alt 也不会弹出;切勿改成 `Menu.setApplicationMenu(null)`,那会让加速键一起失效
- 主题:亮色 / 深色两档,状态栏一键切换,或在 **设置面板**(状态栏齿轮 / `Ctrl+,`)的「外观」中挑选;深色的底色与边框对齐 Obsidian 的 Minimal 主题深色档(`#262626` 编辑区 / `#212121` 侧栏),文字仍用 iMark 默认配色(`#dadada` 正文 / `#8a5cf5` 强调色)。偏好持久化到数据目录的 `settings.json`
- **自定义样式**:把 `.css` 文件放进数据目录的 `css/`(默认 `<应用目录>/.imark/css/`)(首次启动自动创建,并附一份带注释的示例)就能改编辑器里的显示 —— 比如整张表格居中 `.cm-md-table { text-align: center }`。改完保存**即刻生效、不用重启**;设置面板「外观」里是**单选**:一份 .css,或一个**目录**(目录里所有 .css 一起生效),点一行选中、再点一次取消,可导入单个文件或整个文件夹、删除、一键打开样式目录。样式作用于整个界面,**只影响编辑器内显示,不影响导出的 HTML**;详见下文「三、样式模块」
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
| 图表 | **Mermaid 12** + **@iconify-json/lucide** | 编辑期与导出共用的异步渲染服务;动态 import、串行队列、结果缓存,Lucide 图标包本地注册 |
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
- **跨行块(块级公式、表格、Mermaid 图表)的渲染手法**:CM6 **不允许插件提供跨行的 `replace` 装饰**(`remap()` 里还会在中文输入期间主动丢掉跨行的那些),而这类语法天生多行。做法是只替换**首行**成一个承载整块内容的 widget,其余行清空内容并加 `cm-md-*-void` 折算成零高度(`line-height: 0` + `font-size: 0` + `min-height: 0`,高 0 是被 DOM 实测确认过的)。配套的**视口守卫**不能省:首行不完整落在视口内时整块退回源码态——否则首行的 widget 根本没被渲染,而后面几行照样被清空,屏幕上就是一块空白。

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

#### Mermaid 图表

```` ```mermaid ```` 围栏块沿用与表格/块级公式相同的跨行手法:光标在块外时,首行替换成 `MermaidWidget`,其余行清空并折叠;光标进入围栏或点击图表即退回等宽源码。渲染服务在 `services/mermaid.ts`,编辑器 widget 与导出 HTML 共用同一条路径。

- **异步渲染**:`mermaid.render` 返回 Promise,而 `WidgetType.toDOM()` 必须同步。`toDOM` 先给出占位框,结果回来再写入;写入前用 `isConnected` 确认 DOM 没被 CodeMirror 回收。
- **异步撑高后的重新测量**(踩过的坑):只调 `view.requestMeasure()` 不够。CodeMirror 仅在 `.cm-content` 总高度变化时才重读各行高度,而短文档的高度被视口/内边距托住 —— 图表从 48px 占位框长到几百 px 时总高度可能不变,行高缓存就一直停在旧值(实测 113px vs 实际 284px),鼠标点击按旧高度映射,点图表中心会把光标送到文末。所以 widget 用 `ResizeObserver` 监听自身尺寸,并在回调里显式置位 `viewState.mustMeasureContent`(CodeMirror 自己 DOM 重绘时用的同一个开关)后再 `requestMeasure()`。
- **动态 import + 串行队列 + 缓存**:Mermaid 体积大,第一次遇到图表才加载;`mermaid.render` 会在 `document.body` 里挂临时容器,并发渲染会互相踩,因此服务层用一条 Promise 队列串行化;结果按「主题 + 源码」缓存(滚动/击键都会让装饰层整体重建,同一段源码会被反复索取)。
- **主题**:配色是渲染时烘进 SVG 的,不是 CSS 变量。WYSIWYG 插件用 `MutationObserver` 盯 `<html data-theme>`,主题一变就借 `pendingRetry` 触发一次完整重建;`MermaidWidget.eq()` 比较 `theme`,旧图会被新配色的 widget 替换。
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

令牌文件放在 `shared/theme/` 是因为它现在有**三个**消费方:渲染层正常 import、主进程用 `?raw` 内联(给插件窗口下发 CSP 下可用的样式)、插件 preload 用 `webFrame.insertCSS` 注入。同一份文件三处消费,插件窗口的配色才可能与应用逐字一致 —— 各存一份迟早漂移。

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

- **第一个调用方是用户自定义样式**,不是插件:数据目录的 `css/` 由主进程读出来
  (`main/userStyles.ts`),渲染层把**选中的那一项**注入成 `user:<名字>`
  (见 `services/userStyleService.ts`)。同时只有一项生效,所以没有「谁盖过谁」这回事 ——
  注册表的插入顺序在这里不影响任何东西。目录项送过来的是一份**拼好的**文本(主进程按
  相对路径顺序收齐),所以注入侧不必知道候选是文件还是目录。
- **render 层与主界面同 realm,但它拿不到这个内部注册表**。render 入口是注入的普通脚本,没有模块解析,不能 `import` 应用内部模块,`registerStyle` 也不对外暴露。插件要用样式,直接创建自己的 `<style>`(建议带 `data-imk-plugin` 前缀与自己的类名前缀),停用时自己移除。
- **样式约定**:插件若要注入 CSS,类名加 `imk-` 前缀(内置样式用语义化类名,不加前缀);颜色/边框一律用 `tokens.css` 的变量(亮/深色两档主题自动适配);需要覆盖 CodeMirror base theme 已有属性时须走 `EditorView.theme`(外部 CSS 会因特异度不足被静默忽略)。

#### 用户自定义样式(`<数据目录>/css`)

- 目录在**数据目录**下(`css/`,默认 `<应用目录>/.imark/css`,见 §八):整个 iMark 的数据都在那一个目录里,用户也用得上自己熟悉的编辑器与备份工具;应用目录不可写时回退到家目录。首次启动创建,并播种一份**全文注释**的 `example.css`(有一条真规则生效就等于替用户改了默认外观);用户删掉它不会再被塞回来,删掉整个目录才重建 + 重播种。
- **同时只有一项生效**,候选是顶层每一项:`.css` 文件(单独生效)或**子目录**(递归收它下面所有层级的 `.css`,按相对路径顺序拼成一份)。「选中哪个」是设置项(`settings.userStyle`,只存名字不存内容),在设置面板「外观」里点一行选中、**再点一次取消**;默认不选(什么都没选 = 不使用自定义样式)。多项同时生效意味着「谁赢」要靠文件名顺序去推,用户看到的是一份说不清的叠加结果。
- **选中的那一项不在了就什么都不生效**,不自动改选别人(那会莫名其妙地换掉你的外观);把同名的东西放回来它立刻又生效。界面上会直说「「x」已经不在了」,否则「没有任何一行被选中」看着像坏了。
- **导入**:「导入 CSS 文件」收单个文件,「导入 CSS 文件夹」把一个文件夹**整棵**复制成样式目录(只带 `.css`,保留子目录结构,跳过点文件/点目录 —— 一个 `.git` 跟着进来会成为永久噪音)。两者都是**复制**进目录,不引用原路径。**内容相同的直接不导,并列出与哪几份相同** —— 同一个文件点两次「导入」是最容易发生的事,让它悄悄什么都不发生只会让人以为按钮坏了(目录比的是「相对路径 + 归一化正文」这份指纹)。重名但内容不同则改叫 `foo-2.css`,绝不覆盖(目录里那份可能已经被你改过)。
- 主进程负责全部文件系统访问:只收 `.css`、跳过点文件与点目录、单个文件 ≤512 KiB、剥掉 BOM(记事本存的 UTF-8 带 BOM 会让第一个选择器静默失效)。**读清单永不抛** —— 一个坏文件只让它自己标红,其余照常生效;目录里读不动的那几个跳过、在行上标出「N 个读不动」,不影响目录里其余文件。
- 变更靠 `fs.watch`(`recursive`) + 250 ms 防抖,改完保存即刻生效(子目录里存一次盘也算)。**Windows 上删掉正在监听的目录是静默事件**(既不派发事件也不派发 `'error'`),所以另有一个每 4 秒一次的存在性检查兜底 —— 目录没了就重建、重挂、把「样式已全部撤下」播出去。
- CSS 里的 `var(--accent)` 这类变量在计算值阶段解析,所以**切主题时不需要重新注入**,自定义样式自动跟随两档主题。
- 边界(如实写在设置面板与示例文件里):样式作用于**整个界面**;语法错误被浏览器静默丢弃;`.cm-cursor` / `.cm-scroller` / `.cm-content` 这类 base theme 写死的属性要加 `!important`;图片只能用 `data:` / `https:` / `imark://`(`@import` 远程样式表与 `file://` 图片会被 CSP 拦掉,相对路径也不工作)。**不影响导出的 HTML** —— 导出是另一套模板。

### 四、插件系统

插件是**可以装、可以卸、可以升级的包**:一份清单(`manifest.json`)+ 若干文件,打包成 `.imkpkg.json` 信封(单文件 JSON,包内每个文件 base64 编码并带逐文件 sha256)。安装后落在数据目录的 `plugins/<id>/`(默认 `<应用目录>/.imark/plugins/<id>/`),启用态与配置在 `settings.json` 的 `plugins.<id>`,密钥在 `secrets.json` 且**明文不出主进程**。

**清单格式**:没有 `kind` / `ui` / `backend`。插件由两层组成,均可不写,但至少要有一层:

- **main 层**——代码跑在宿主侧,`main.mode` 二选一:
  - `node`:主进程 CommonJS,**完整 Node 权限**(与应用同权);
  - `restricted`:隐藏沙箱页,无 Node/`fs`/`require`,能力逐次经宿主闸门。
- **render 层**——代码跑在主窗口渲染进程,与 Obsidian 插件一致:能直接拿真实 `EditorView`、共享 CM6 kit 与 DOM。它**没有系统能力**,需要文件/网络/git/密钥时只能给 main 层发消息。
- **无代码 `capability`**——不含第三方代码,绑定宿主内置能力(目前 `webhook`);它可以单独存在,不能与 main/render 并存。

| 层 | 信任 | 系统能力 |
|---|---|---|
| `main.mode: 'node'` | 全权(主进程任意代码) | 完整 Node |
| `main.mode: 'restricted'` | 不信任 | 真门禁:清单声明 ∩ 用户同意,每次调用审查 |
| `render` | 与主界面同 realm(可改 UI/读当前文档/看键盘) | 无;只能消息给 main |
| 无代码 + `capability` | 无第三方代码 | 宿主内置能力 |

**插件没有自有窗口/停靠页。** 界面只有两种:render 层自己创建的 DOM(它自己负责清理),以及清单声明的主机贡献点(`lineMenu` / `commands` / `statusBar` / `menus`)。清单里没有 `ui` 权限、`ui.entry`、`window.show()`、`ui.mount` 这些通道。

| 文件 | 职责 |
|---|---|
| `shared/pluginPackage.ts` | 包格式、清单校验、版本比较、路径/体积/图标规则 —— 主进程、服务端、渲染层共用同一份 |
| `shared/pluginApi.ts` | main(node/restricted)与 render 的 API 契约,主进程实现与插件源码 import 的是同一份 |
| `shared/pluginRpc.ts` | restricted 页面与宿主之间的线上契约(通道名、错误码、事件类型) |
| `main/plugins/host.ts` | 宿主:两层层装配、生命周期、动作路由、安装/升级/回滚/卸载、熔断、状态广播 |
| `main/plugins/script.ts` | node main 加载:`createRequire` + 清 `require.cache` |
| `main/plugins/restrictedRuntime.ts` | restricted main 的隐藏执行页通道:身份反查、能力调用、反向调用、调度器 |
| `main/plugins/restrictedPage.ts` | 隐藏执行页、独立 session、`imk-plugin://` 协议、CSP、路径三重校验 |
| `main/plugins/renderLayer.ts` | render 层:一次性 nonce 注入、就绪/重载后重新注入、两半消息中继 |
| `main/plugins/ops.ts` / `gate.ts` | **唯一权威的能力表**与闸门(两条 main 通道共用) |
| `main/plugins/api.ts` | node main 的 `imk` 实现:方法名 → 能力表 |
| `preload/plugin.ts` | restricted 页面的 preload —— 作者看到的 `window.imark` 就是它造出来的 |
| `main/plugins/installed.ts` | 安装登记表(只存来源与入口哈希,磁盘目录才是权威) |
| `main/market/*` | 市场客户端(见 §五) |
| `main/git.ts` / `secrets.ts` / `dataDir.ts` | git 子进程、safeStorage、数据目录权威 |

**权限语义取决于 main.mode**:restricted 的每一项都是真门禁(没声明的能力连命名空间都不存在,每次调用再审一次);node 的权限是**告知 + API 塑形**(它本来就有完整 Node);render 层没有权限概念,它与主界面同 realm,只能靠安装时的知情确认兜底。`settings` / `shell` 只在 node main 有意义,restricted 声明它们会直接报错。

**动作路由**:有 main 走 main;只有 render 走 render;两者都有但 main 没实现时返回"未实现",**不回退到 render**。需要 render 处理的动作,由 main 在自己的 `runAction` 里用 `imk.render.send(...)` 请求。这样每个动作只有一个权威执行者。

**每次调用都有护栏**:宿主对插件的每一次调用都过 `safeCall`(try/catch + 10 秒超时 + 失败计数);连续 3 次失败自动停用,**绝不自动恢复**。restricted 的隐藏页与 render 的注入会一起收掉。

**配置与密钥**仍由 `PluginField[]` 声明式描述,设置面板通用渲染表单。`password` 与 `targets.targetSecret` 经 `safeStorage` 加密后存 `secrets.json`;插件只能读自己名下的密钥,key 由宿主用插件自己的 id 拼出。**密钥作用域防的是误用与 API 卫生,不是安全边界** —— node main 本来就能直接读磁盘;真正的边界是安装时那一次知情确认。

**内置兜底包**:「定时上传(Git)」与「Advanced Table」以 `?raw` 内联进主进程,启动时若没装过就走**完全相同的校验与安装路径**补装一次。补装后是否默认启用是宿主策略(写在 `bundled.ts` 里),不写进包。git-sync 默认关,quick-edit 默认开。卸载顺序:停用 → 移出运行时 → 删目录 → **删这个 id 名下的全部密钥** → 删登记 →(可选)删配置。

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
| GET | `/api/v1/search?q=&page=&sort=&mainMode=&render=` | – | 搜索 / 排序 / 按 main 模式与是否有 render 层过滤 |
| GET | `/api/v1/packages/:id` \| `/latest` \| `/versions/:v` | – | 详情(含 README、版本列表、下架标记) |
| GET | `/api/v1/packages/:id/versions/:v/download` | – | 信封字节 + `X-Imk-Integrity` 响应头,下载计数 +1 |
| GET | `/api/v1/packages/:id/icon` | – | 图标字节(≤64 KiB) |
| POST | `/api/v1/packages` | Bearer | 发布:信封 JSON |
| POST | `/api/v1/packages/:id/versions/:v/yank` \| `/unyank` | Bearer(owner) | 下架 / 恢复 |

另有 `GET /api/v1/users/:username/packages`(某作者的全部插件)与 `/api/v1/admin/*`(统计、把被抢注的 id 转移给真正的作者,需 `ADMIN_TOKEN`)。

**发布**:注册账号(scrypt 加盐哈希,密码 ≥8 位)→ 在「发布插件」页选目录 → 打包预览(文件清单、权限、体积、整包 sha256)→ 发布。服务端会**重算**逐文件 sha256 与整包 integrity,不符就 400。`manifest.id` 首次发布即被该账号认领,别人再发同 id → 403;同一个 `(id, 版本)` 不能重发(409)—— 已发布的版本不可变,要改就升版本号。版本可以**下架**(yanked):下架后从搜索、`latest` 与版本列表里消失,但按精确版本号仍能下载 —— 已经锁定了这个版本的安装不会被破坏;下架当前最新版时,次高的非下架版本会自动成为 latest。**没有硬删除。**

**安装**:下载 → 把响应头声明的 integrity 与自算的比对 → `verifyEnvelope()`(结构、路径、扩展名、体积、逐文件 sha256)→ 检查「这个包在这台机器上装不装得上」(绑定的能力是否存在、声明的 `engines.imark` 是否满足)→ 解到 `.staging/` → 交给宿主原子就位。任何一步失败都不落盘。更新检查在启动后、打开市场页时、手动刷新时各跑一次,结果缓存 10 分钟;**绝不循环重试** —— 离线是正常状态,界面安静降级。

**安装确认框是安全基线**。按下按钮之前,它必须摆出:插件名 / 版本 / 发布者 / 来源地址、**逐条中文解释的权限清单**、文件数与总体积、可跨渠道核对的整包 sha256、main 与 render 入口各自的 sha256。风险确认按层给:**node main** 一条红字(主进程任意代码、完整 Node),**render 层**一条红字(与界面同 realm,可改界面/读文档/看键盘);两层都有时两条都要勾选。restricted main 不给红字,但逐条权限说明"没声明就不存在、每次调用审查"。无代码 capability 会点名它借的是哪个内置能力。详情页另配「**查看源码**」:显示的内容与将要安装的那份**来自同一次下载、过了同一套校验**,不是另取的一份「参考源码」。

**要如实说明的边界**

- **node main = 主进程里的任意代码执行。** 它能读写你电脑上的任意文件(笔记、SSH 密钥、`secrets.json`)、发起网络请求、启动其他程序。上面那一整套(sha256、发布者、权限清单、确认框、失败熔断、失败回滚)降低的是**误装**的概率、让**决策知情**,它们**不做沙箱**。
- 默认市场地址 `http://127.0.0.1:8787` 是**明文**的(且只监听回环)。填非回环的 `http://` 地址时界面会给一次性警告;正式部署必须自己前置 TLS 终止 —— 否则「下载的包没被篡改」这件事就只靠一次明文 HTTP 撑着。
- 发布是「**已认证但不审计**」:任何能注册的人都能认领一个还没被占用的 id。共享的注册表上,官方 id 应当先占掉。
- 服务端按 IP 的内存限流(10 次失败 / 5 分钟)只够自托管;公开部署需要真正的限流组件与审计。
- **插件能往界面里放什么,取决于层。** 只声明 main 的插件,界面全部由宿主来画:清单里的 `lineMenu` 让宿主在光标行左边画一个「+」,`commands` / `statusBar` / `menus` 分别进命令面板、状态栏、文件列表右键菜单 —— 按钮、菜单、对话框以及**改动文档**都由宿主执行。**render 层直接跑在主界面里**:它拿得到真正的 CM6 对象与 DOM,能深度定制编辑器与界面 —— 代价是安装确认框必须如实告知"它与应用界面同权",并且要求用户勾选。没有任何插件自有窗口/停靠页。

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

#### 目录与构建

```text
my-plugin/
├── manifest.json     # 清单(id、版本、main/render、权限、字段、动作)
├── main.ts           # node main 或 restricted main(二选一)
├── render.ts         # 可选:render 层
└── README.md
```

官方插件用三份独立 TS 工程编译,作者也可以直接写普通 `.js`:

- `plugins-src/tsconfig.node.json` → CommonJS,输出 `dist/node`(git-sync);
- `plugins-src/tsconfig.restricted.json` → ES module,输出 `dist/restricted`(quick-edit、note-embed main);
- `plugins-src/tsconfig.render.json` → ES2022,输出 `dist/render`(todo-marks、note-embed 的 render 入口)。

`npm run plugins:build` 会依次跑三份 tsc、把入口与静态资源打进内置包。render 入口会被宿主包进 `(function (imk) { … })`,**不能有 import/export/require/eval**;构建脚本会把 tsc 补的 `export {}` 剥掉,其余模块语法直接报错。

#### 清单字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✔ | `^[a-z0-9][a-z0-9._-]{1,63}$`,**禁止 `:`**;保留字 `imk`/`market`/`system`/`core`/`node`/`electron` |
| `name` / `description` / `version` | ✔ | 界面名、一句话说明、语义化版本 |
| `main` | 与 `render`/`capability` 至少一个 | `{ "mode": "node" \| "restricted", "entry": "main.js" }`。node 入口 `.js/.cjs`;restricted 入口 `.js/.mjs` |
| `render` | 同上 | `{ "entry": "render.js" }`,包内 `.js` 普通脚本 |
| `capability` | 同上 | 无代码形态绑定的内置能力 id(如 `webhook`);**只能单独出现** |
| `permissions` | | 只与 `main` 或 `capability` 一起出现;render-only 声明权限会被拒 |
| `author` / `homepage` / `icon` / `engines` | | 署名、主页(https)、包内图标、依赖的 iMark 版本 |
| `fields` | ✔ | 配置字段表;设置面板据此通用渲染 |
| `actions` / `targetActions` / `targetFieldKey` | | 插件级/目标级动作 |
| `lineMenu` / `commands` / `statusBar` / `menus` | | 主机贡献点,任何形态都可以声明;动作按 §四 的规则路由 |

权限词表:`git`、`secrets`、`vault:read`、`vault:write`、`network`、`settings`、`shell`。**restricted main 只能声明前五个**,`settings`/`shell` 会报错。旧的 `ui`、`editor:read`、`editor:write` 已删除。

包内文件规则:相对 POSIX 路径、无 `..`、深度 ≤3、扩展名白名单(`js/mjs/cjs/json/md/txt/css/svg/png/jpg/jpeg/gif/webp/woff/woff2`)、单文件 ≤2 MiB、入口 ≤1 MiB、README ≤256 KiB、整包 ≤8 MiB、文件数 ≤64。路径里任何一段都不能是 `__imark`。

#### node main

```ts
// main.ts —— CommonJS 工厂
import type { ImkApi, PluginRuntime } from '@shared/pluginApi'

class MyPlugin implements PluginRuntime {
  constructor(private imk: ImkApi) {}
  onEnable(): void { /* 定时器、连接… */ }
  onDisable(): void { /* 收尾 */ }
  async runAction(actionId: string): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'pong' }
  }
}

export = (imk: ImkApi) => new MyPlugin(imk)
```

清单:`"main": { "mode": "node", "entry": "main.js" }`。

`imk` 上的能力:

| 命名空间 | 内容 |
|---|---|
| `imk.plugin` | `id` / `name` / `version` / `dir` |
| `imk.getConfig` / `setState` / `flushDocument` / `isEnabled` / `isDisabledByHost` / `log` | 配置、状态、落盘、日志 |
| `imk.vault` | 需 `vault:read`。`path()` / `exists(p?)`(完整 Node 下这只是便利) |
| `imk.git` | 需 `git`。`available` / `run(args, opts)` / `credentialArgs` / `credentialEnv` / `redact` / `summarize`;`opts.env` 只对 node main 开放 |
| `imk.secrets` | 需 `secrets`。`get` / `has` |
| `imk.ui` | `notify` / `statusItem`(宿主画的界面,不要权限) |
| `imk.commands` / `imk.menus` | 命令面板 / 右键菜单(带本地回调) |
| `imk.on(event, handler)` | 宿主事件;停用/重载时整体清掉 |
| `imk.render` | 有 render 层时:`send(channel, data)` / `onMessage(fn)` |

#### restricted main

```ts
// main.ts —— 页面顶层同步登记;没有 ctx,能力都从 window.imark 取
const imk = window.imark

imk.plugin.handle({
  onEnable() { imk.setState({ status: 'ok', lastMessage: 'ready' }) },
  runAction(actionId, targetId, payload) {
    if (actionId !== 'ping') return { ok: false, message: `未知动作:${actionId}` }
    return { ok: true, message: 'pong' }
  }
})
```

清单:`"main": { "mode": "restricted", "entry": "main.js" }`。

`window.imark` 的能力:插件身份与 `handle`、`log`/`getConfig`/`setState`/`on`、`ui.notify/statusItem`、`commands`/`menus`、`document.flush`、`schedule.every/clear`、按权限塑形的 `vault`/`secrets`/`net`/`git`、有 render 时的 `render`。**没有 `editor`、没有 `window`、没有 `halves`。** 页面里没有 `require`/`process`,CSP 掐死裸 `fetch`;联网只能走 `imark.net.fetch`,git 只能用受限子命令白名单且不能传 `env`。

#### render 层

```ts
// render.js —— 普通脚本,不能有 import/export/require/eval
const view = imk.editor.getView()
imk.plugin.handle({
  onEnable() {
    imk.editor.registerExtension(imk.editor.kit.view.EditorView.updateListener.of(...))
    imk.editor.onDocChanged(() => { /* … */ })
    imk.plugin.setState({ status: 'ok', lastMessage: 'render-ready' })
  },
  onDisable() { /* 移除自己挂的 DOM/定时器 */ }
})
```

清单:`"render": { "entry": "render.js" }`。

`imk` 的形状:

| 命名空间 | 内容 |
|---|---|
| `imk.plugin` | `id` / `name` / `version` / `getConfig` / `setState` / `handle` / `log` |
| `imk.editor` | `getView(): EditorView \| null`(宿主同一个实例)、`onDocChanged(fn)`、`registerExtension(ext)`、`kit { state, view, language, commands }` |
| `imk.main` | `send(channel, data)` / `onMessage(fn)`;没有 main 层时 `send` 明确失败 |

- **必须用 `kit` 里的构造器构建 CM6 扩展**,不要自己 bundle `@codemirror/*` —— facet 靠模块实例身份匹配,两份实例会让扩展静默失效。
- 每次用时重新 `getView()`;打开文件会 `view.setState` 重建 state,不要缓存跨文件的 `EditorView` 引用。
- render 层直接操作 DOM、自己的 `<style>`、自己的事件;停用时自己清理。它没有 `vault`/`net`/`git`/`secrets`,需要时 `imk.main.send(...)`。
- 官方样板:`plugins-src/todo-marks/`(render-only,自己画 CM6 装饰与面板)、`plugins-src/note-embed/`(restricted main + render,两层消息 + 分块传输长笔记)。

#### 两层消息

- render → main:`imk.main.send(channel, data)`;宿主按 `main.mode` 投递给 restricted 页面的 `imk.render.onMessage` 或 node main 的 `imk.render.onMessage`。没有 main 层时消息被丢弃。
- main → render:restricted 走 `imk.render.send` op,node 走 `imk.render.send`(同一个 op)。消息只传数据,不传能力;通道名 ≤64 字符、单条 ≤256 KiB、限流 120/分钟。
- 生命周期顺序:启用 = main 先起 → render 注入;停用 = render 先收 → main 停。render 层要主动在 `onEnable` 里发第一条消息,不要假设 main 启动时 render 已经就绪。

#### 行首「+」菜单与动作

清单里声明 `lineMenu` 后,宿主会在光标行左边画「+」;条目要么给 `template`(固定文本,不惊动插件),要么给 `action`(+ 可选 `dialog` 参数表单)。插件在 `runAction` 里收到 `values` 与这一行的快照,返回 `editor: { text, cursorOffset }` 由宿主插入。**文档始终由宿主改**(除了 render 层,它可以直接操作 `EditorView`)。

动作路由规则:有 main 走 main,只有 render 走 render;两者都有时 main 没实现就返回"未实现",不会偷偷回退。混合插件需要 render 处理某个动作时,在 main 的 `runAction` 里 `imk.render.send('do-action', { actionId })`,由 render 的 `onMessage` 接住。

#### 无代码 capability

不用写代码:清单里写 `capability: "webhook"` 与它要求的字段/动作,行为完全由宿主内置能力执行。它不能与 main/render 并存。安装确认框会点名"借的是哪个能力"。

#### 发布

在「发布插件」页选目录 → 预览(文件清单、权限、体积、整包 sha256、main/render 入口哈希)→ 发布。服务端重算逐文件 sha256 与整包 integrity,不符就 400。`manifest.id` 首次发布即被账号认领;同一 `(id, 版本)` 不可重发。版本可以下架,没有硬删除。

### 七、其他子系统

- **仓库(Vault)工作流**:主进程 `vault.ts` 用 `fs.promises.readdir` 递归列目录(跳过隐藏目录与 `node_modules`/`.obsidian` 等),渲染层 `vaultService.ts` 负责状态与流程编排;删除走 `shell.trashItem`(系统回收站),新建/重命名走专用 IPC——渲染层不直接触碰文件系统。
- **进程边界与安全**:系统能力全部经 `contextBridge` 暴露的 `window.api`(类型定义在 `shared/api.ts`);渲染层开启 `sandbox`、无 Node 集成;外链在打开前于主进程校验 `^https?://`,本地图片走自定义 `imark://` 特权协议(编码绝对路径,由主进程读取后返回,规避 `file://` 的编码与安全限制)。
- **主题**:两档主题(亮/深色)全部由 CSS 变量驱动(变量定义在 `shared/theme/tokens.css`,见 §三),CodeMirror 侧通过 `EditorView.theme` 引用 `var(--…)`。注意:base theme 已定义过的 `.cm-*` 属性必须写在主题扩展里,外部 CSS 会因特异度不足被静默忽略。
- **导出 HTML**:markdown-it(代码高亮用 highlight.js)+ 内联样式模板,输出单文件。

### 八、数据放在哪(备份与重置)

iMark 的所有数据都在**应用自己所在的目录**里:安装版是 `<安装目录>\.imark`(你把 iMark 装在 `D:\imark`,数据就在 `D:\imark\.imark`),开发版是 `<仓库>\.imark`(已加入 `.gitignore`)。

> **为什么不在家目录**:把应用目录整体拷到另一台机器/另一个盘,数据和程序一起走,不用去 `%APPDATA%` 里翻;也不会因为 C 盘空间紧张而把笔记应用的数据留在系统盘上。
> **例外**:应用目录**不可写**时(装进 `Program Files`、Linux AppImage 的只读挂载、macOS 的 `.app` 包)会自动回退到家目录 `~/.imark`,启动日志里会写明实际用的是哪个。

```
<应用目录>/.imark/
├── css/               自定义样式(§三)
├── plugins/           插件包 + installed.json + .staging/ + <id>.old/
├── settings.json      仓库列表、上次打开的文件、界面偏好、插件启用态与配置
├── secrets.json       插件访问令牌、市场登录令牌(**safeStorage 加密**,不是明文)
└── profile/           Chromium 自己的 profile:缓存、Cookie、restricted main 隐藏页的分区存储……
                       ↑ 解密密钥(Local State)也在里面,别单独删它
```

- **备份**:拷 `<应用目录>/.imark` 即可。最少要含 `plugins/` + `secrets.json`(只拷配置不拷密钥,插件会认为你没填过令牌);`profile/` 是缓存与登录态,可以不拷。
- **升级/卸载前请先备份**:数据放在安装目录里,而安装器/卸载器可能会覆盖或删除安装目录中的文件。移动整个应用文件夹时,数据会跟着走(这正是这个布局的好处);但**用安装器升级/卸载**时建议先把 `.imark` 拷出来。
- **彻底重置**:退出应用 → 删掉 `<应用目录>/.imark` → 重启。设置、插件、令牌、缓存一起清空。
- **换机器**:数据拷过去后 `settings.json` / `plugins/` 直接可用,但 `secrets.json` 里的令牌要重填 —— 加密密钥绑当前 Windows 用户(DPAPI),换用户或换机器都解不开,插件那边表现为"还没填令牌"。
- **搬迁**(只发生一次):启动时若新位置还没有数据,会从旧位置搬 —— 来源依次是家目录 `~/.imark` 与更早的 `%APPDATA%\iMark` / `%APPDATA%\imarkdown`。**先搬 profile**(缓存、登录态、插件分区、解密密钥一起走),通过完整性守卫后才搬 `plugins/` 与三个 json。同盘用 `rename`;跨盘(比如 C: → D:)退化为拷贝,校验文件数对得上才删源。任一步失败(被占用、旧实例还在跑)就整体放弃、本次继续用可用的旧布局,下次启动再试 —— 绝不会出现"路径换了但数据没搬完"或"令牌解不开"。
- **`--imark-data-dir=<目录>`**(高级):把数据根指到别处(别的盘、U 盘、并行实例)。单用它等于"接管这个构建的真实数据目录",所以它要配 `--user-data-dir` 一起用;验收里就是这么把搬迁跑在沙箱内的(`verify/data-dir-harness.ts`)。
- **单实例锁绑在这个目录上**:安装版与开发版现在各用各的数据目录,可以同时运行;同一个数据目录同时只允许一个实例(两个 Chromium 同时写一份 profile 会互相破坏)。要并行开两个共用数据目录的实例,给其中一个加 `--imark-data-dir` 另指一处。
