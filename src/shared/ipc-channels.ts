/** IPC 通道名常量(主/渲染进程共用,零运行时依赖) */
export const IPC = {
  FileOpenDialog: 'file:open-dialog',
  FileSaveDialog: 'file:save-dialog',
  FileRead: 'file:read',
  FileWrite: 'file:write',
  /**
   * 渲染→主:把剪贴板图片保存到当前文档旁的 `assets/` 目录。
   *
   * 图片字节走 IPC 的结构化克隆(Uint8Array),不转 base64;主进程负责生成不与现有
   * 文件冲突的名字,并返回**相对文档目录**的引用路径(见 main/files.ts)。
   */
  FileSaveImage: 'file:save-image',
  /**
   * 渲染→主:回收正文里已经不再引用的粘贴图片(移到系统回收站)。
   *
   * 渲染层只负责比较保存前后的正文、给出候选文件名;真正的路径校验与
   * 「同目录其他笔记是否还引用」的判断都在主进程做(见 main/files.ts)。
   */
  FileTrashImages: 'file:trash-images',
  ConfirmDiscard: 'dialog:confirm-discard',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  OpenExternal: 'shell:open-external',
  SetTitle: 'window:set-title',
  SetView: 'window:set-view',
  DocDirty: 'doc:dirty',
  /**
   * 渲染→主:当前打开文档的**绝对路径**(没有打开任何文件时传 null)。
   *
   * 主进程本来完全不知道用户开着哪个文件 —— 它只知道标题里的文件名。但有两件事
   * 必须要它知道:① imark:// 协议只允许读「当前文档所在目录 + 仓库根」里的图片
   * (见 main/protocol.ts);② 插件往文档里写字时要先让编辑器落盘、写完再让编辑器重载。
   * 两者都以「当前文档是谁」为基准。
   *
   * 单独开一个通道而不是塞进 SetTitle:标题的 watcher 盯的是文件名,而两个不同
   * 目录下的同名文件切换时文件名不变 —— 那种情况下文档路径照样得更新。
   */
  DocPath: 'doc:path',
  MenuCommand: 'menu:command',
  SaveBeforeClose: 'app:save-before-close',
  SaveDone: 'app:save-done',
  /**
   * 主→渲染:系统递来一个要打开的文件(双击 .md / 资源管理器「打开方式」)。
   *
   * 单独一条通道而不是塞进 MenuCommand:菜单命令是「用户点了某个功能」,
   * 这里带的是**一个路径**,而且可能在启动过程中就发生(见 OpenFileTake)。
   */
  OpenFileFromSystem: 'app:open-file-from-system',
  /**
   * 渲染→主:取走启动时命令行里带的文件(只取一次)。
   *
   * 启动那一个用**拉取**而不是推送:窗口刚建好时渲染层的服务还没初始化完,
   * 推过去只能靠延时赌时序;拉取发生在 App 初始化之后,天然没有竞态。
   */
  OpenFileTake: 'app:open-file-take',
  /** 渲染→主:默认编辑器现在是谁(设置 → 系统) */
  SystemDefaultEditorStatus: 'system:default-editor-status',
  /** 渲染→主:把 iMark 注册进 .md 的「打开方式」,并打开系统的默认应用设置 */
  SystemSetDefaultEditor: 'system:set-default-editor',
  VaultSelectDialog: 'vault:select-dialog',
  VaultList: 'vault:list',
  VaultCreateFile: 'vault:create-file',
  VaultCreateDir: 'vault:create-dir',
  VaultRename: 'vault:rename',
  VaultDelete: 'vault:delete',
  VaultConfirmDelete: 'vault:confirm-delete',
  // ---------- 扩展(v2 模型) ----------
  /** 渲染→主:整份扩展视图(含密钥掩码) */
  ExtensionList: 'extension:list',
  /** 渲染→主:启用/禁用;返回最新视图 */
  ExtensionSetEnabled: 'extension:set-enabled',
  /** 渲染→主:保存非密配置(值为完整配置键);返回最新视图 */
  ExtensionSetConfig: 'extension:set-config',
  /** 渲染→主:写/清一条密钥(key 为 `<扩展内键>` 或 `<字段>:<目标>`);返回最新视图 */
  ExtensionSetSecret: 'extension:set-secret',
  /** 渲染→主:重新加载单个扩展 */
  ExtensionReload: 'extension:reload',
  /** 渲染→主:重新加载一个宿主组 */
  ExtensionReloadHost: 'extension:reload-host',
  /** 渲染→主:修改 isolated/shared 与 affinity */
  ExtensionSetHostSettings: 'extension:set-host-settings',
  /** 渲染→主:卸载扩展 */
  ExtensionUninstall: 'extension:uninstall',
  /** 用系统默认程序打开某个扩展的日志文件 */
  ExtensionLogOpen: 'extension:log-open',
  /** 渲染→主:取一次界面贡献点快照 */
  ExtensionContribGet: 'extension:contrib-get',
  /** 渲染→主:执行一条扩展命令 */
  ExtensionCommandRun: 'extension:command-run',
  /** 主→渲染:菜单里的扩展命令被点了 */
  ExtensionCommand: 'extension:command',
  /**
   * 渲染→主:编辑器桥与界面回执(RendererToMainMessage)。
   *
   * 与 v1 的多条通道不同,v2 的 renderer↔main 协议在 extensionProtocol.ts 里
   * 有完整的可辨识联合;一条通道既避免十几组重复的序列化代码,也让「哪些消息
   * 可以跨进程」只有一处定义。
   */
  ExtensionToMain: 'extension:to-main',
  /** 主→渲染:编辑器请求 / 贡献点 / webview / UI 请求(MainToRendererMessage) */
  ExtensionToRenderer: 'extension:to-renderer',

  PluginList: 'plugin:list',
  PluginSave: 'plugin:save',
  PluginSetSecret: 'plugin:set-secret',
  PluginRun: 'plugin:run',
  /** 主→渲染:配置/状态变化时广播整份插件视图 */
  PluginStatus: 'plugin:status',
  /** 主→渲染:请先保存脏文档 */
  PluginFlushDoc: 'plugin:flush-doc',
  /** 渲染→主:保存完成回执 */
  PluginFlushDone: 'plugin:flush-done',
  /**
   * 主→渲染:当前启用插件的**界面贡献点**快照(命令 / 状态栏 / 右键菜单)。
   *
   * 单独一条通道,不塞进 PluginStatus:那条是高频的(插件每 setState 一次就广播),
   * 而贡献点只在插件启停/重载时变。混在一起的话,一次状态栏进度更新也要把
   * 几十条命令的描述搬过 IPC。
   */
  PluginContrib: 'plugin:contrib',
  /** 渲染→主:执行一次贡献点(命令面板 / 状态栏 / 右键菜单共用) */
  PluginContribRun: 'plugin:contrib-run',
  /** 渲染→主:渲染层主动要一次贡献点快照(首次挂载时) */
  PluginContribGet: 'plugin:contrib-get',
  /** 主→渲染:插件发来的一条通知(右下角气泡) */
  PluginNotice: 'plugin:notice',
  /** 渲染→主:为某个 restricted main 放开/收回「允许访问本机地址」 */
  PluginSetNetAccess: 'plugin:set-net-access',
  /** 用系统默认程序打开某个插件的完整日志文件(不存在则先创建) */
  PluginLogOpen: 'plugin:log-open',
  /**
   * 主→渲染:render 层的生命周期请求(prepare/enable/config/runAction/unload)。
   *
   * render 层代码跑在渲染进程里,宿主只能经这条通道把它叫起来 —— 渲染层做完用
   * `PluginHostReply` 回执。这条通道是**双向的**,和 plugin:bridge 一样:
   * 同一条通道名,主→渲染是请求,渲染→主是回执。
   */
  PluginHostRequest: 'plugin:host-request',
  PluginHostReply: 'plugin:host-reply',
  /**
   * render 层 ↔ main 层的消息。**同一条通道名,双向**:
   * 渲染层用 `send` 往主进程发,主进程中转给该插件的 main 层;
   * main 层发来的消息由主进程用 `send` 推回渲染层。
   * 消息只是不可解析的数据 —— 它不携带任何能力,能力永远走 `plugin:rpc` 的闸门。
   */
  PluginRenderMessage: 'plugin:render-message',
  /** 渲染→主:render 层更新自己的状态卡(setState) */
  PluginRenderState: 'plugin:render-state',
  /** 渲染→主:render 层写一行日志 */
  PluginRenderLog: 'plugin:render-log',
  /**
   * 渲染→主:界面这边准备好了,可以往这儿发 PluginHostRequest 了。
   *
   * 必须有这条握手:主进程"窗口对象建好了"与"渲染层能收消息了"之间隔着整个页面加载
   * —— 早发的那几条会**被静默丢掉**(没有监听器),而插件那边只看到一句超时。
   * 页面重载时也会再报一次,于是重载后界面能自己长回来。
   */
  PluginUiReady: 'plugin:ui-ready',
  /**
   * 主→渲染:「插件」菜单(或它的快捷键)点了某条命令。
   *
   * 命令的快捷键必须挂成原生菜单项,于是这条命令的入口就在主进程那边 ——
   * 但真正干活的是渲染层(它才知道光标在哪、哪一行),所以原生菜单点完
   * 还是回到这里,与命令面板走同一条 `PluginContribRun`。
   */
  PluginCommand: 'plugin:command',
  /**
   * 渲染→主:文档内容变了。
   *
   * 渲染层**已节流**才发出来 —— 每次按键都过一次 IPC 是不可接受的,
   * 而插件要的「文档变了」本来就是粗粒度的(自动保存、字数统计这类用途)。
   */
  DocChanged: 'doc:changed',
  /**
   * 渲染→主:编辑器里**有没有文档**。
   *
   * 不能用 DocPath 是否为 null 来代替:一份还没保存过的新文档同样是在编辑文档,
   * 而它的路径就是 null。命令的可用性判定要的是「有没有东西可编辑」,
   * 这两件事在"未命名文档"上恰好相反。
   */
  EditorPresence: 'editor:presence',
  /**
   * 渲染→主:一份文档**成功写进了磁盘**。
   *
   * 与 SaveDone 是两件事,别合并:那条是"关闭窗口前那次保存做完了"的**回执**,
   * 主进程在等它(handleSaveDone 会兑现一个挂起的 flush);这条是**通知**,
   * 谁都没在等 —— 手动保存、自动保存各来一条,插件的 document:save 钩子靠它触发。
   * 合并的话,一次用户随手按的 Ctrl+S 会去兑现一个与它无关的 flush 等待。
   *
   * 为什么由渲染层发而不是主进程自己看:只有渲染层知道"这次写盘是哪份文档"——
   * 写盘那一小会儿用户可能已经切走了(自动保存尤其如此)。
   */
  DocSaved: 'doc:saved',
  /**
   * 主→渲染:某个文件被插件改了(插件有 vault:write)。
   *
   * 渲染层据此判断"是不是我正开着的那份",是就重新加载 —— 不重新加载的话,
   * 编辑器里还是旧内容,用户下一次保存会把插件的改动原样覆盖掉。
   */
  FileExternalChange: 'file:external-change',

  // ---------- 插件市场 ----------
  /** 挑一个本地 .imkpkg.json 包 → 预览(不安装) */
  MarketPickPackage: 'market:pick-package',
  /** 挑一个插件目录 → 打包 → 预览(不安装) */
  MarketPackDir: 'market:pack-dir',
  /** 丢弃一个待确认的安装(用户点了取消) */
  MarketDropPending: 'market:drop-pending',
  /** 确认安装一个待确认项(只回传令牌,不回传字节) */
  MarketInstallPending: 'market:install-pending',
  MarketUninstall: 'market:uninstall',
  /** 已安装插件 + 来源/更新信息的整体视图 */
  MarketInstalled: 'market:installed',
  /** 把应用自带的兜底插件重新装回来(离线可用) */
  MarketRestoreBundled: 'market:restore-bundled',
  /** 主→渲染:安装/下载进度 */
  MarketProgress: 'market:progress',
  /** 设置市场地址;返回规范化后的地址(空串 = 不使用市场) */
  MarketSetRegistry: 'market:set-registry',
  /** 测一下这个地址上是不是我们的服务(is-online 判定,不写设置) */
  MarketTestRegistry: 'market:test-registry',
  MarketSearch: 'market:search',
  MarketDetail: 'market:detail',
  /** 取插件图标,转成 data: URL(CSP 不让渲染层直接加载 http 图片) */
  MarketIcon: 'market:icon',
  /** 从市场下载一个版本 → 预览(不安装) */
  MarketInstall: 'market:install',
  MarketAuthStatus: 'market:auth-status',
  MarketLogin: 'market:auth-login',
  MarketRegister: 'market:auth-register',
  MarketLogout: 'market:auth-logout',
  /** 用户看过了「你在用明文 http」的提示,不再提 */
  MarketAckPlainHttp: 'market:ack-plain-http',
  /** 挑目录 → 打包 → 预览(不上传) */
  MarketPublishPreview: 'market:publish-preview',
  /** 上传一个目录的当前内容 */
  MarketPublish: 'market:publish',
  /** 检查已安装插件有没有新版本 */
  MarketCheckUpdates: 'market:check-updates',
  /** 读某个版本包里的文本文件(装之前先看源码) */
  MarketSource: 'market:source',

  // ---------- 自定义样式(~/.imark/css) ----------
  /** 读样式目录里的全部 .css(含内容) */
  UserStylesList: 'userstyle:list',
  /** 在文件管理器里打开样式目录(不存在则先创建) */
  UserStylesOpenDir: 'userstyle:open-dir',
  /** 挑一个 .css 复制进样式目录 → 返回做了什么 + 最新清单(用户取消返回 null) */
  UserStylesImport: 'userstyle:import',
  /** 挑一个文件夹,把它顶层的 .css 全部复制进来 → 同上 */
  UserStylesImportDir: 'userstyle:import-dir',
  /** 把一个样式文件移到回收站 → 返回最新清单 */
  UserStylesRemove: 'userstyle:remove',
  /** 主→渲染:目录内容变化时广播整份清单(渲染层自己 diff) */
  UserStylesChanged: 'userstyle:changed'
} as const

/** 原生菜单点击后转发给渲染层的命令 ID */
export type MenuCommandId =
  | 'file:new'
  | 'file:open'
  | 'file:open-vault'
  | 'file:quick-switch'
  | 'file:close-tab'
  | 'file:next-tab'
  | 'file:prev-tab'
  | 'file:save'
  | 'file:save-as'
  | 'file:export-html'
  | 'format:bold'
  | 'format:italic'
  | 'format:strike'
  | 'format:inline-code'
  | 'format:code-block'
  | 'format:quote'
  | 'format:bullet-list'
  | 'format:ordered-list'
  | 'format:task-list'
  | 'format:hr'
  | 'format:h1'
  | 'format:h2'
  | 'format:h3'
  | 'format:h4'
  | 'format:h5'
  | 'format:h6'
  | 'format:plain'
  | 'format:link'
  | 'format:image'
  | 'view:toggle-theme'
  | 'view:toggle-outline'
  | 'view:toggle-explorer'
  | 'view:settings'
  | 'view:market'
  | 'view:command-palette'
