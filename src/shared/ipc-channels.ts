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
  /**
   * 渲染→主:界面实际应用的主题。窗口控件(WCO)的配色按它来,
   * 而不是按 settings 里的值 —— 两者在启动异常时可能不一致。
   */
  SetTheme: 'window:set-theme',
  DocDirty: 'doc:dirty',
  /**
   * 渲染→主:当前打开文档的**绝对路径**(没有打开任何文件时传 null)。
   *
   * 主进程本来完全不知道用户开着哪个文件 —— 它只知道标题里的文件名。但有两件事
   * 必须要它知道:① imark:// 协议只允许读「当前文档所在目录 + 仓库根」里的图片
   * (见 main/protocol.ts);② 扩展往文档里写字时要先让编辑器落盘、写完再让编辑器重载。
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
  /**
   * 渲染→主:本次启动的意图(普通启动 / 任务栏中键「新开一个」)。
   * 新窗口要停在仓库选择页,不能恢复上次仓库 —— 否则多开的窗口又会去抢同一个仓库。
   */
  LaunchIntent: 'app:launch-intent',
  /** 渲染→主:默认编辑器现在是谁(设置 → 系统) */
  SystemDefaultEditorStatus: 'system:default-editor-status',
  /** 渲染→主:把 iMark 注册进 .md 的「打开方式」,并打开系统的默认应用设置 */
  SystemSetDefaultEditor: 'system:set-default-editor',
  VaultSelectDialog: 'vault:select-dialog',
  /**
   * 渲染→主:认领一个要打开的仓库。
   *
   * 多实例下同一个仓库只保留一个窗口:别的实例已经开着它时,主进程会把那个窗口
   * 叫到前面(带文件时把文件也递过去),返回 `forwarded`;联系不上主人返回 `busy`,
   * 都不应继续在本窗口打开。
   */
  VaultClaim: 'vault:claim',
  /** 渲染→主:打开失败/离开仓库时退掉认领(见 main/vaultHandoff.ts) */
  VaultRelease: 'vault:release',
  VaultList: 'vault:list',
  /** 渲染→主:批量确认最近仓库里哪些路径已经不是目录(已删掉的从列表里剔除) */
  VaultMissing: 'vault:missing',
  VaultCreateFile: 'vault:create-file',
  VaultCreateDir: 'vault:create-dir',
  VaultRename: 'vault:rename',
  VaultDelete: 'vault:delete',
  VaultConfirmDelete: 'vault:confirm-delete',
  // ---------- 扩展 ----------
  /** 渲染→主:整份扩展视图(含密钥掩码) */
  ExtensionList: 'extension:list',
  /** 渲染→主:取扩展包内图标,返回 data: URL;没有图标时 null */
  ExtensionIcon: 'extension:icon',
  /** 渲染→主:读取扩展清单声明的外部 JSON 设置(如 ~/.claude/settings.json) */
  ExtensionExternalGet: 'extension:external-get',
  /** 渲染→主:写入扩展清单声明的外部 JSON 设置;空串表示删除该键 */
  ExtensionExternalSet: 'extension:external-set',
  /** 渲染→主:用系统默认程序打开外部设置文件(如 ~/.claude/settings.json) */
  ExtensionExternalOpen: 'extension:external-open',
  /** 渲染→主:启用/禁用;返回最新视图 */
  ExtensionSetEnabled: 'extension:set-enabled',
  /** 渲染→主:保存单个配置项;按清单里的 imark.scope 落到全局层或当前仓库层 */
  ExtensionSetField: 'extension:set-field',
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
   * renderer↔main 协议在 extensionProtocol.ts 里有完整的可辨识联合;一条通道
   * 既避免十几组重复的序列化代码,也让「哪些消息可以跨进程」只有一处定义。
   */
  ExtensionToMain: 'extension:to-main',
  /** 主→渲染:编辑器请求 / 贡献点 / webview / UI 请求(MainToRendererMessage) */
  ExtensionToRenderer: 'extension:to-renderer',

  // ---------- 扩展市场 ----------
  /** 挑一个本地 .imkpkg.json 包 → 预览(不安装) */
  MarketPickPackage: 'market:pick-package',
  /** 挑一个扩展目录 → 打包 → 预览(不安装) */
  MarketPackDir: 'market:pack-dir',
  /** 丢弃一个待确认的安装(用户点了取消) */
  MarketDropPending: 'market:drop-pending',
  /** 确认安装一个待确认项(只回传令牌,不回传字节) */
  MarketInstallPending: 'market:install-pending',
  MarketUninstall: 'market:uninstall',
  /** 已安装扩展 + 来源/更新信息的整体视图 */
  MarketInstalled: 'market:installed',
  /** 把应用自带的兜底扩展重新装回来(离线可用) */
  MarketRestoreBundled: 'market:restore-bundled',
  /** 主→渲染:安装/下载进度 */
  MarketProgress: 'market:progress',
  /** 设置市场地址;返回规范化后的地址(空串 = 不使用市场) */
  MarketSetRegistry: 'market:set-registry',
  /** 测一下这个地址上是不是我们的服务(is-online 判定,不写设置) */
  MarketTestRegistry: 'market:test-registry',
  MarketSearch: 'market:search',
  MarketDetail: 'market:detail',
  /** 取扩展图标,转成 data: URL(CSP 不让渲染层直接加载 http 图片) */
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
  /** 检查已安装扩展有没有新版本 */
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
