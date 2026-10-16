/** IPC 通道名常量(主/渲染进程共用,零运行时依赖) */
export const IPC = {
  FileOpenDialog: 'file:open-dialog',
  FileSaveDialog: 'file:save-dialog',
  FileRead: 'file:read',
  FileWrite: 'file:write',
  ConfirmDiscard: 'dialog:confirm-discard',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  OpenExternal: 'shell:open-external',
  SetTitle: 'window:set-title',
  SetView: 'window:set-view',
  DocDirty: 'doc:dirty',
  MenuCommand: 'menu:command',
  SaveBeforeClose: 'app:save-before-close',
  SaveDone: 'app:save-done',
  VaultSelectDialog: 'vault:select-dialog',
  VaultList: 'vault:list',
  VaultCreateFile: 'vault:create-file',
  VaultCreateDir: 'vault:create-dir',
  VaultRename: 'vault:rename',
  VaultDelete: 'vault:delete',
  VaultConfirmDelete: 'vault:confirm-delete',
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
