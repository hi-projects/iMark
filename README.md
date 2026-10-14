# iMark

基于 **CodeMirror 6 + Electron + Vue 3** 的所见即所得(Obsidian Live Preview 风格)Markdown 编辑器。

作者:**Chuxiao Xiang** <13439022108@163.com>

## 功能

- **所见即所得编辑**:语法树驱动的装饰层——光标不在节点上时自动隐藏 `**`、`` ` ``、`#`、`](url)` 等标记,内容按样式渲染;光标进入即显形为原始语法
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
- **插件系统(内置核心插件)**:设置面板「插件」分类统一管理——启用/停用、按字段表自动渲染配置表单、动作按钮、运行状态与错误详情;密钥类字段经 Electron safeStorage 加密后单独存于 `userData/secrets.json`,**渲染层永远拿不到明文**
  - **定时上传(Git)**:按固定间隔把当前仓库 `git add -A` → commit → push 到 GitLab / Gitee / GitHub 等任意 Git 远端,可配置**多个远端**(一次提交推全部);另有「立即上传」「测试连接」动作,以及状态栏同步图标(成功/失败/进行中/未启用四态)
  - 同步前会先把编辑器里**未保存的改动**落盘,刚敲的内容不会漏;无改动时直接跳过,不产生空提交
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

**实现文件**:

| 文件 | 职责 |
|---|---|
| `editor/wysiwyg/build.ts` | ViewPlugin 主体:视口遍历、语法树可用性检查、装饰集构建、Ctrl+点击链接 |
| `editor/wysiwyg/rules.ts` | **节点名 → 装饰策略**的唯一分发表(标题/强调/代码/链接/图片/公式/任务列表…) |
| `editor/wysiwyg/widgets.ts` | `WidgetType` 实现:复选框、图片、水平线、公式 |
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
- **间接导入(插件)**:插件不依赖任何 CSS 文件路径,而是把一段 CSS 交给注册表运行时注入:

  ```ts
  import css from './my-plugin.css?inline'            // Vite ?inline:读成字符串,不自动注入
  import { registerStyle, unregisterStyle } from '@renderer/styles'

  export function activate() { registerStyle('my-plugin', css) }
  export function deactivate() { unregisterStyle('my-plugin') }
  ```

- **插件样式约定**:类名加 `imk-` 前缀;颜色/边框一律用 `tokens.css` 的变量(亮/暗/纯黑三档主题自动适配);需要覆盖 CodeMirror base theme 已有属性时须走 `EditorView.theme`(外部 CSS 会因特异度不足被静默忽略)。

### 四、插件系统与 Git 定时同步

**内置核心插件注册表**(仿 Obsidian「核心插件」):插件是仓库内实现统一接口的代码,注册进 `src/main/plugins/registry.ts` 即可被宿主接管——设置面板会自动列出它、渲染配置表单、调度动作。接口留了将来挂载外部插件的余地(`MainPlugin` 的 `onEnable/onDisable/onConfigChange/runAction` 不依赖任何内部细节)。

| 文件 | 职责 |
|---|---|
| `shared/plugins.ts` | 共享类型:字段表 / 目标 / 状态 / 视图,以及 `secretKey()` 约定 |
| `main/plugins/types.ts` | 插件契约(`MainPlugin`)与宿主给插件的 `PluginContext` |
| `main/plugins/host.ts` | 宿主:配置归一化、启停生命周期、动作调度、状态广播、保存握手 |
| `main/plugins/gitSync.ts` | 「定时上传」插件:字段表、定时器、提交流水线、动作与错误翻译 |
| `main/git.ts` | git 子进程封装:超时/中止、防交互挂起、URL 脱敏、一次性凭据 helper |
| `main/secrets.ts` | safeStorage 加解密 + `userData/secrets.json` 读写 |
| `renderer/services/pluginService.ts` | 渲染层封装:状态订阅、调用、flush 握手回执 |
| `renderer/components/plugins/` | 插件列表 / 详情 / 字段控件 / 远端列表 |

**两条设计要点**

- **声明式配置**:插件的配置项用 `PluginField[]` 描述(kind = text / password / number / boolean / select / targets),设置面板据此**通用渲染表单**,新增插件不必写任何 Vue 组件;需要特殊交互的结构化字段通过新增 kind 扩展(如 git 的远端列表)。
- **密钥与配置分离**:`password` 字段与 `targets.targetSecret` 的值不写进 `settings.json`,而是 `safeStorage.encryptString()` 后存 `secrets.json`(每条记录带 `enc` 标记,加密不可用时降级为明文并保留读回能力)。渲染层只拿到「是否已配置」。`settings.plugins` 只允许插件宿主写——渲染层的 `saveSettings` 会被主进程剔除该字段。

**Git 上传的两个实现要点**

- **凭据既不落盘也不进命令行**:推送时 URL 保持干净(不带 user:token),而是临时挂一个一次性 credential helper `-c credential.helper=` + `-c credential.helper=!f(){…}`,用户名与 token 从子进程**环境变量**读取(`GIT_IMK_USER` / `GIT_IMK_TOKEN`)。这样既不会把 token 写进 `.git/config`,也不出现在进程命令行里;同时固定 `GIT_TERMINAL_PROMPT=0` 与 `GCM_INTERACTIVE=never`,缺凭据时快速失败而不是弹凭据窗口把同步卡死。**用户名可留空**:留空按 `oauth2` 认证(GitLab / GitHub 通用),Gitee 建议填真实用户名;未填 token 时完全不注入凭据(公开仓库或无凭据场景)。
- **全链路脱敏**:任何要展示、写状态或落盘的 git 输出都先过 `redactUrl()`,把 `://user:token@host` 洗成 `://user:***@host`;失败按类型翻成可操作的中文提示(远端有新提交被拒 / 认证失败 / 连不上 / 仓库不存在)。

**远端配置项**(每个远端一行):**远程仓库**(必填,HTTPS 或 SSH 地址)+ **本地分支**(必填)/ **远程分支**(留空则与本地分支同名)+ **认证方式**(三选一):

| 认证方式 | 说明 |
|---|---|
| 访问令牌 | 默认。GitHub / GitLab 的 personal access token,按 `oauth2:<令牌>` 认证;私有仓库必填(界面提示会写明) |
| 账号密码 | 填账号 + 密码(如 Gitee 用账号名 + 私人令牌) |
| SSH | 用本机 SSH 密钥,不需要填写密钥;地址写成 `git@host:用户名/仓库.git` |

密钥经 safeStorage 加密保存,界面上只显示**掩码**(`ab****23`,由主进程算好下发,明文不出主进程),旁边是「更换 / 清除」;点「更换」才展开输入框。地址是 `file://` 这类本地路径时不需要凭据。

**首次同步会做的事**(都可在插件设置里关闭):不是 git 仓库时 `git init -b <分支>`;写入推荐 `.gitignore`(`.obsidian/`、`node_modules/`、`.imark-tmp` 等,**已存在则不覆盖**);仓库没有任何 remote 时补一个不带凭据的 `origin`,方便你在命令行 `git pull`。作者身份仅在仓库与全局都没配 `user.name/user.email` 时用插件配置兜底,否则尊重你的 git 配置。

**这个插件只做上传**：它不替你处理仓库层面的疑难(远端已有无关历史、两边都改过同一文件、需要合并或变基等)。遇到这类情况插件会**如实报错**(状态变红、详情里给出 git 的原始信息),请你在仓库目录自己用 git 处理完再点「立即上传」—— 插件保持简单,行为可预期。

**配置改完会自动试跑一次**(3 秒后):否则容易出现「先启用插件(还没填远端)→「启动后同步一次」当场失败并被消耗 → 要干等一个完整间隔才再试」的错觉。

**边界**:定时器跑在主进程,而应用是「窗口全关即退出」(无托盘),所以**关掉应用期间不会上传**——用「启动后同步一次」弥补;仓库切换后始终同步 `settings.vaultPath` 指向的当前仓库。远端与本地的历史冲突(非快进被拒)不在插件内处理,按报错提示在仓库目录自己解决。

### 五、其他子系统

- **仓库(Vault)工作流**:主进程 `vault.ts` 用 `fs.promises.readdir` 递归列目录(跳过隐藏目录与 `node_modules`/`.obsidian` 等),渲染层 `vaultService.ts` 负责状态与流程编排;删除走 `shell.trashItem`(系统回收站),新建/重命名走专用 IPC——渲染层不直接触碰文件系统。
- **进程边界与安全**:系统能力全部经 `contextBridge` 暴露的 `window.api`(类型定义在 `shared/api.ts`);渲染层开启 `sandbox`、无 Node 集成;外链在打开前于主进程校验 `^https?://`,本地图片走自定义 `imark://` 特权协议(编码绝对路径,由主进程读取后返回,规避 `file://` 的编码与安全限制)。
- **主题**:三档主题(亮/暗/纯黑)全部由 CSS 变量驱动(`assets/styles/vars.css`),CodeMirror 侧通过 `EditorView.theme` 引用 `var(--…)`。注意:base theme 已定义过的 `.cm-*` 属性必须写在主题扩展里,外部 CSS 会因特异度不足被静默忽略。
- **导出 HTML**:markdown-it(代码高亮用 highlight.js)+ 内联样式模板,输出单文件。
