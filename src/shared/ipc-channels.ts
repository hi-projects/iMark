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
  PluginFlushDone: 'plugin:flush-done'
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
