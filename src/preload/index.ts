import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import type { MarketProgress, MarketQuery, MarketSource } from '@shared/market'
import type {
  DockSlotRect,
  PluginActionPayload,
  PluginActionResult,
  PluginContribInvoke,
  PluginContribsSnapshot,
  PluginNotice,
  PluginUiClick,
  PluginView,
  RendererOpReply,
  RendererOpRequest
} from '@shared/plugins'
import type { SaveDialogOptions, Settings } from '@shared/types'
import type { UserStyleImportResult, UserStyleState } from '@shared/userStyles'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

const api = {
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.FileOpenDialog),
  saveFileDialog: (o: SaveDialogOptions): Promise<string | null> => ipcRenderer.invoke(IPC.FileSaveDialog, o),
  readFile: (path: string) => ipcRenderer.invoke(IPC.FileRead, path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke(IPC.FileWrite, { path, content }),
  confirmDiscard: (fileName: string) => ipcRenderer.invoke(IPC.ConfirmDiscard, { fileName }),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.SettingsGet),
  saveSettings: (s: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.SettingsSet, s),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.OpenExternal, url),
  setWindowTitle: (name: string | null, dirty: boolean, vaultName?: string | null): void =>
    ipcRenderer.send(IPC.SetTitle, { name, dirty, vaultName }),
  setWindowView: (view: 'picker' | 'editor'): void => ipcRenderer.send(IPC.SetView, view),
  setDocDirty: (dirty: boolean): void => ipcRenderer.send(IPC.DocDirty, dirty),
  /** 告诉主进程当前开着哪个文件 —— 它据此决定 imark:// 能读哪些图片 */
  setDocPath: (path: string | null): void => ipcRenderer.send(IPC.DocPath, path),
  notifySaveDone: (ok: boolean): void => ipcRenderer.send(IPC.SaveDone, { ok }),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onMenuCommand: (cb: (id: MenuCommandId) => void): (() => void) =>
    subscribe<MenuCommandId>(IPC.MenuCommand, cb),
  onSaveBeforeClose: (cb: () => void): (() => void) => subscribe<void>(IPC.SaveBeforeClose, cb),
  // ---------- 仓库 ----------
  selectVaultDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.VaultSelectDialog),
  listVault: (path: string) => ipcRenderer.invoke(IPC.VaultList, path),
  createFile: (path: string, content = ''): Promise<void> =>
    ipcRenderer.invoke(IPC.VaultCreateFile, { path, content }),
  createDir: (path: string): Promise<void> => ipcRenderer.invoke(IPC.VaultCreateDir, { path }),
  renamePath: (from: string, to: string): Promise<void> =>
    ipcRenderer.invoke(IPC.VaultRename, { from, to }),
  trashPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.VaultDelete, { path }),
  confirmDelete: (name: string, isDir: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.VaultConfirmDelete, { name, isDir }),
  // ---------- 插件 ----------
  listPlugins: () => ipcRenderer.invoke(IPC.PluginList),
  savePlugin: (id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
    ipcRenderer.invoke(IPC.PluginSave, { id, ...patch }),
  setPluginSecret: (id: string, fieldKey: string, targetId: string | null, value: string | null) =>
    ipcRenderer.invoke(IPC.PluginSetSecret, { id, fieldKey, targetId, value }),
  /** 沙箱插件:是否为它放开「允许访问本机地址」 */
  setPluginNetAccess: (id: string, allow: boolean) =>
    ipcRenderer.invoke(IPC.PluginSetNetAccess, { id, allow }),
  /** 沙箱插件:唤出它自己的窗口 */
  openPluginWindow: (id: string) => ipcRenderer.invoke(IPC.PluginOpenWindow, id),
  runPluginAction: (id: string, action: string, targetId?: string, payload?: PluginActionPayload) =>
    ipcRenderer.invoke(IPC.PluginRun, { id, action, targetId, payload }),
  notifyPluginFlushed: (): void => ipcRenderer.send(IPC.PluginFlushDone),
  onPluginFlushDoc: (cb: () => void): (() => void) => subscribe<void>(IPC.PluginFlushDoc, cb),
  onPluginStatus: (cb: (plugins: PluginView[]) => void): (() => void) =>
    subscribe<PluginView[]>(IPC.PluginStatus, cb),
  // ---------- 插件界面贡献点 ----------
  getPluginContribs: (): Promise<PluginContribsSnapshot> =>
    ipcRenderer.invoke(IPC.PluginContribGet),
  runPluginContrib: (invoke: PluginContribInvoke): Promise<PluginActionResult> =>
    ipcRenderer.invoke(IPC.PluginContribRun, invoke),
  onPluginContribs: (cb: (snapshot: PluginContribsSnapshot) => void): (() => void) =>
    subscribe<PluginContribsSnapshot>(IPC.PluginContrib, cb),
  onPluginNotice: (cb: (notice: PluginNotice) => void): (() => void) =>
    subscribe<PluginNotice>(IPC.PluginNotice, cb),
  /** 「插件」菜单或它的快捷键点了某条命令 —— 回到渲染层来执行(它才知道光标在哪) */
  onPluginCommand: (cb: (o: { pluginId: string; itemId: string }) => void): (() => void) =>
    subscribe<{ pluginId: string; itemId: string }>(IPC.PluginCommand, cb),
  /** 文档内容变了(渲染层已节流,最快约 400ms 一次) */
  notifyDocChanged: (o: { dirty: boolean; words: number; chars: number }): void =>
    ipcRenderer.send(IPC.DocChanged, o),
  /** 编辑器里有没有文档 —— 与「有没有文件路径」是两件事,未命名文档没有路径 */
  setEditorPresence: (present: boolean): void => ipcRenderer.send(IPC.EditorPresence, present),
  /** 一份文档成功写进了磁盘(插件的 document:save 钩子靠它触发) */
  notifyDocSaved: (filePath: string): void => ipcRenderer.send(IPC.DocSaved, filePath),
  /** 主→渲染:插件要往当前文档里插入内容(由宿主执行,插件只出文本) */
  onPluginEditorInsert: (cb: (o: { text: string; cursorOffset?: number }) => void): (() => void) =>
    subscribe<{ text: string; cursorOffset?: number }>(IPC.PluginEditorInsert, cb),
  /** 主→渲染:这个文件被插件改了(是正开着的就重新加载) */
  onFileExternalChange: (cb: (filePath: string) => void): (() => void) =>
    subscribe<string>(IPC.FileExternalChange, cb),
  // ---------- 编辑器扩展点与界面注入(宿主请渲染层办事) ----------
  /** 主→渲染:替某个插件做一件事(读/改文档、加装饰、挂界面);做完要 replyHostRequest */
  onPluginHostRequest: (cb: (req: RendererOpRequest) => void): (() => void) =>
    subscribe<RendererOpRequest>(IPC.PluginHostRequest, cb),
  /** 渲染→主:上面那件事的结果 */
  replyHostRequest: (reply: RendererOpReply): void => ipcRenderer.send(IPC.PluginHostReply, reply),
  /** 渲染→主:注入的界面里有人点了带 data-imk-click 的元素 */
  notifyPluginUiClick: (click: PluginUiClick): void => ipcRenderer.send(IPC.PluginUiClick, click),
  /** 渲染→主:停靠面板的槽位位置(主进程据此摆 WebContentsView) */
  notifyPluginDockRect: (rect: DockSlotRect): void => ipcRenderer.send(IPC.PluginDockRect, rect),
  /** 渲染→主:界面这边准备好了(见 IPC.PluginUiReady 的说明) */
  notifyPluginUiReady: (): void => ipcRenderer.send(IPC.PluginUiReady),
  // ---------- 插件市场 ----------
  pickMarketPackage: () => ipcRenderer.invoke(IPC.MarketPickPackage),
  packMarketDir: () => ipcRenderer.invoke(IPC.MarketPackDir),
  dropMarketPending: (token: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MarketDropPending, token),
  installMarketPending: (token: string) => ipcRenderer.invoke(IPC.MarketInstallPending, token),
  uninstallPlugin: (id: string, options: { removeConfig: boolean }) =>
    ipcRenderer.invoke(IPC.MarketUninstall, { id, ...options }),
  listMarketInstalled: () => ipcRenderer.invoke(IPC.MarketInstalled),
  restoreBundledPlugins: () => ipcRenderer.invoke(IPC.MarketRestoreBundled),
  onMarketProgress: (cb: (p: MarketProgress) => void): (() => void) =>
    subscribe<MarketProgress>(IPC.MarketProgress, cb),
  setMarketRegistry: (url: string) => ipcRenderer.invoke(IPC.MarketSetRegistry, url),
  testMarketRegistry: (url: string) => ipcRenderer.invoke(IPC.MarketTestRegistry, url),
  searchMarket: (query: MarketQuery) => ipcRenderer.invoke(IPC.MarketSearch, query),
  marketDetail: (id: string) => ipcRenderer.invoke(IPC.MarketDetail, id),
  marketIcon: (id: string) => ipcRenderer.invoke(IPC.MarketIcon, id),
  installFromMarket: (id: string, version: string | null) =>
    ipcRenderer.invoke(IPC.MarketInstall, { id, version }),
  marketAuthStatus: () => ipcRenderer.invoke(IPC.MarketAuthStatus),
  marketLogin: (username: string, password: string) =>
    ipcRenderer.invoke(IPC.MarketLogin, { username, password }),
  marketRegister: (username: string, password: string) =>
    ipcRenderer.invoke(IPC.MarketRegister, { username, password }),
  marketLogout: () => ipcRenderer.invoke(IPC.MarketLogout),
  acknowledgeMarketPlainHttp: (): Promise<void> =>
    ipcRenderer.invoke(IPC.MarketAckPlainHttp),
  previewMarketPublish: () => ipcRenderer.invoke(IPC.MarketPublishPreview),
  publishToMarket: (dir: string) => ipcRenderer.invoke(IPC.MarketPublish, dir),
  checkMarketUpdates: (force?: boolean) => ipcRenderer.invoke(IPC.MarketCheckUpdates, force),
  marketSource: (id: string, version: string | null): Promise<MarketSource> =>
    ipcRenderer.invoke(IPC.MarketSource, id, version),
  // ---------- 自定义样式 ----------
  listUserStyles: (): Promise<UserStyleState> => ipcRenderer.invoke(IPC.UserStylesList),
  openUserStylesDir: (): Promise<void> => ipcRenderer.invoke(IPC.UserStylesOpenDir),
  importUserStyle: (): Promise<UserStyleImportResult | null> =>
    ipcRenderer.invoke(IPC.UserStylesImport),
  importUserStylesFromDir: (): Promise<UserStyleImportResult | null> =>
    ipcRenderer.invoke(IPC.UserStylesImportDir),
  removeUserStyle: (name: string): Promise<UserStyleState> =>
    ipcRenderer.invoke(IPC.UserStylesRemove, name),
  onUserStylesChanged: (cb: (state: UserStyleState) => void): (() => void) =>
    subscribe<UserStyleState>(IPC.UserStylesChanged, cb)
}

contextBridge.exposeInMainWorld('api', api)

export type RendererApi = typeof api
