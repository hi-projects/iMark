import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import type { MarketProgress, MarketQuery, MarketSource } from '@shared/market'
import type { DefaultEditorStatus, SaveDialogOptions, Settings } from '@shared/types'
import type { UserStyleImportResult, UserStyleState } from '@shared/userStyles'
import type {
  ExtensionCommandInvocation,
  ExtensionCommandResult,
  ExtensionContributionsSnapshot,
  ExtensionHostSettingsPatch,
  ExtensionView
} from '@shared/extensions'
import type { MainToRendererMessage, RendererToMainMessage } from '@shared/extensionProtocol'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener as never)
  return () => ipcRenderer.removeListener(channel, listener as never)
}

/**
 * 主进程抛出的错误跨进程时会被 Electron 再包一层:
 *
 *   Error invoking remote method 'market:search': MarketError: 连不上 127.0.0.1:8787:…
 *
 * 前半截只对开发者有意义,界面却会把 `message` 原样贴给用户,于是报错里
 * 混着英文和类名。所有 IPC 请求都从这里走,统一剥掉这层包装。
 */
function humanizeIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const clean = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    // 错误类名(Error / TypeError / MarketError…)是给调试看的,不留
    .replace(/^[A-Za-z_$][\w$]*Error:\s*/, '')
  return clean || raw
}

/** ipcRenderer.invoke 的薄包装:只做错误消息的去包装,不改任何调用语义 */
async function request<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (err) {
    throw new Error(humanizeIpcError(err))
  }
}

const api = {
  openFileDialog: (): Promise<string | null> => request(IPC.FileOpenDialog),
  saveFileDialog: (o: SaveDialogOptions): Promise<string | null> => request(IPC.FileSaveDialog, o),
  readFile: (path: string) => request(IPC.FileRead, path),
  writeFile: (path: string, content: string): Promise<void> =>
    request(IPC.FileWrite, { path, content }),
  saveImageAsset: (docPath: string, mime: string, data: Uint8Array): Promise<string> =>
    request(IPC.FileSaveImage, { docPath, mime, data }),
  trashImageAssets: (docPath: string, names: string[]): Promise<void> =>
    request(IPC.FileTrashImages, { docPath, names }),
  confirmDiscard: (fileName: string) => request(IPC.ConfirmDiscard, { fileName }),
  getSettings: (): Promise<Settings> => request(IPC.SettingsGet),
  saveSettings: (s: Partial<Settings>): Promise<Settings> => request(IPC.SettingsSet, s),
  openExternal: (url: string): Promise<void> => request(IPC.OpenExternal, url),
  setWindowTitle: (name: string | null, dirty: boolean, vaultName?: string | null): void =>
    ipcRenderer.send(IPC.SetTitle, { name, dirty, vaultName }),
  setWindowView: (view: 'picker' | 'editor'): void => ipcRenderer.send(IPC.SetView, view),
  setDocDirty: (dirty: boolean, dirtyNames: string[] = []): void =>
    ipcRenderer.send(IPC.DocDirty, { dirty, names: dirtyNames }),
  /** 告诉主进程当前开着哪个文件 —— 它据此决定 imark:// 能读哪些图片 */
  setDocPath: (path: string | null): void => ipcRenderer.send(IPC.DocPath, path),
  notifySaveDone: (ok: boolean): void => ipcRenderer.send(IPC.SaveDone, { ok }),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onMenuCommand: (cb: (id: MenuCommandId) => void): (() => void) =>
    subscribe<MenuCommandId>(IPC.MenuCommand, cb),
  onSaveBeforeClose: (cb: () => void): (() => void) => subscribe<void>(IPC.SaveBeforeClose, cb),
  // ---------- 系统集成 ----------
  takePendingOpenFile: (): Promise<string | null> => request(IPC.OpenFileTake),
  onOpenFile: (cb: (path: string) => void): (() => void) => subscribe<string>(IPC.OpenFileFromSystem, cb),
  defaultEditorStatus: (): Promise<DefaultEditorStatus> =>
    request(IPC.SystemDefaultEditorStatus),
  setDefaultEditor: (): Promise<DefaultEditorStatus> => request(IPC.SystemSetDefaultEditor),
  // ---------- 仓库 ----------
  selectVaultDialog: (): Promise<string | null> => request(IPC.VaultSelectDialog),
  listVault: (path: string) => request(IPC.VaultList, path),
  createFile: (path: string, content = ''): Promise<void> =>
    request(IPC.VaultCreateFile, { path, content }),
  createDir: (path: string): Promise<void> => request(IPC.VaultCreateDir, { path }),
  renamePath: (from: string, to: string): Promise<void> =>
    request(IPC.VaultRename, { from, to }),
  trashPath: (path: string): Promise<void> => request(IPC.VaultDelete, { path }),
  confirmDelete: (name: string, isDir: boolean): Promise<boolean> =>
    request(IPC.VaultConfirmDelete, { name, isDir }),
  // ---------- 扩展(v2) ----------
  listExtensions: (): Promise<ExtensionView[]> => request(IPC.ExtensionList),
  setExtensionEnabled: (id: string, enabled: boolean): Promise<ExtensionView[]> =>
    request(IPC.ExtensionSetEnabled, { id, enabled }),
  setExtensionConfig: (
    id: string,
    config: Record<string, unknown>
  ): Promise<ExtensionView[]> => request(IPC.ExtensionSetConfig, { id, config }),
  /** value 为 null 时清除该密钥;key 是完整键(`<id>:<property>[:<slot>]`) */
  setExtensionSecret: (
    id: string,
    key: string,
    value: string | null
  ): Promise<ExtensionView[]> => request(IPC.ExtensionSetSecret, { id, key, value }),
  reloadExtension: (id: string): Promise<ExtensionView[]> => request(IPC.ExtensionReload, id),
  reloadExtensionHost: (hostId: number): Promise<ExtensionView[]> =>
    request(IPC.ExtensionReloadHost, hostId),
  setExtensionHostSettings: (patch: ExtensionHostSettingsPatch): Promise<ExtensionView[]> =>
    request(IPC.ExtensionSetHostSettings, patch),
  uninstallExtension: (id: string): Promise<ExtensionView[]> =>
    request(IPC.ExtensionUninstall, id),
  openExtensionLog: (id: string): Promise<void> => request(IPC.ExtensionLogOpen, id),
  /** 首次挂载时主动要一次贡献点快照(不必等下一次变更) */
  getExtensionContributions: (): Promise<ExtensionContributionsSnapshot> =>
    request(IPC.ExtensionContribGet),
  /**
   * 执行一条扩展命令。IPC 不抛错:失败以 `{ok:false, message}` 返回,
   * 这样界面能原样显示主进程给出的中文说明。
   */
  runExtensionCommand: (
    command: string,
    args: unknown[] = [],
    from: ExtensionCommandInvocation['from'] = 'code'
  ): Promise<ExtensionCommandResult> =>
    request(IPC.ExtensionCommandRun, { command, args, from }),
  /** 主进程推来的编辑器桥/贡献点消息;渲染层按 `type` 分派 */
  onExtensionMessage: (cb: (message: MainToRendererMessage) => void): (() => void) =>
    subscribe<MainToRendererMessage>(IPC.ExtensionToRenderer, cb),
  /** 只订阅贡献点快照(高频且形状固定的那一种) */
  onExtensionContributions: (
    cb: (snapshot: ExtensionContributionsSnapshot) => void
  ): (() => void) => {
    const listener = (_e: unknown, message: MainToRendererMessage): void => {
      if (message && message.type === 'extensions.contributions') {
        cb(message.snapshot as ExtensionContributionsSnapshot)
      }
    }
    ipcRenderer.on(IPC.ExtensionToRenderer, listener as never)
    return () => ipcRenderer.removeListener(IPC.ExtensionToRenderer, listener as never)
  },
  /** 渲染层 → 主进程的编辑器桥消息 */
  sendExtensionMessage: (message: RendererToMainMessage): void =>
    ipcRenderer.send(IPC.ExtensionToMain, message),
  /** 原生菜单/快捷键触发的扩展命令(执行入口在渲染层) */
  onExtensionCommand: (
    cb: (invocation: Pick<ExtensionCommandInvocation, 'command' | 'from'>) => void
  ): (() => void) =>
    subscribe<Pick<ExtensionCommandInvocation, 'command' | 'from'>>(IPC.ExtensionCommand, cb),
  /** 文档内容变了(渲染层已节流,最快约 400ms 一次) */
  notifyDocChanged: (o: { dirty: boolean; words: number; chars: number }): void =>
    ipcRenderer.send(IPC.DocChanged, o),
  /** 编辑器里有没有文档 —— 与「有没有文件路径」是两件事,未命名文档没有路径 */
  setEditorPresence: (present: boolean): void => ipcRenderer.send(IPC.EditorPresence, present),
  /** 一份文档成功写进了磁盘 */
  notifyDocSaved: (filePath: string): void => ipcRenderer.send(IPC.DocSaved, filePath),
  /** 主→渲染:这个文件被外部改了(是正开着的就重新加载) */
  onFileExternalChange: (cb: (filePath: string) => void): (() => void) =>
    subscribe<string>(IPC.FileExternalChange, cb),
  // ---------- 插件市场 ----------
  pickMarketPackage: () => request(IPC.MarketPickPackage),
  packMarketDir: () => request(IPC.MarketPackDir),
  dropMarketPending: (token: string): Promise<void> =>
    request(IPC.MarketDropPending, token),
  installMarketPending: (token: string) => request(IPC.MarketInstallPending, token),
  uninstallPlugin: (id: string) => request(IPC.MarketUninstall, id),
  listMarketInstalled: () => request(IPC.MarketInstalled),
  restoreBundledPlugins: () => request(IPC.MarketRestoreBundled),
  onMarketProgress: (cb: (p: MarketProgress) => void): (() => void) =>
    subscribe<MarketProgress>(IPC.MarketProgress, cb),
  setMarketRegistry: (url: string) => request(IPC.MarketSetRegistry, url),
  testMarketRegistry: (url: string) => request(IPC.MarketTestRegistry, url),
  searchMarket: (query: MarketQuery) => request(IPC.MarketSearch, query),
  marketDetail: (id: string) => request(IPC.MarketDetail, id),
  marketIcon: (id: string) => request(IPC.MarketIcon, id),
  installFromMarket: (id: string, version: string | null) =>
    request(IPC.MarketInstall, { id, version }),
  marketAuthStatus: () => request(IPC.MarketAuthStatus),
  marketLogin: (username: string, password: string) =>
    request(IPC.MarketLogin, { username, password }),
  marketRegister: (username: string, password: string) =>
    request(IPC.MarketRegister, { username, password }),
  marketLogout: () => request(IPC.MarketLogout),
  acknowledgeMarketPlainHttp: (): Promise<void> =>
    request(IPC.MarketAckPlainHttp),
  previewMarketPublish: () => request(IPC.MarketPublishPreview),
  publishToMarket: (dir: string) => request(IPC.MarketPublish, dir),
  checkMarketUpdates: (force?: boolean) => request(IPC.MarketCheckUpdates, force),
  marketSource: (id: string, version: string | null): Promise<MarketSource> =>
    request(IPC.MarketSource, id, version),
  // ---------- 自定义样式 ----------
  listUserStyles: (): Promise<UserStyleState> => request(IPC.UserStylesList),
  openUserStylesDir: (): Promise<void> => request(IPC.UserStylesOpenDir),
  importUserStyle: (): Promise<UserStyleImportResult | null> =>
    request(IPC.UserStylesImport),
  importUserStylesFromDir: (): Promise<UserStyleImportResult | null> =>
    request(IPC.UserStylesImportDir),
  removeUserStyle: (name: string): Promise<UserStyleState> =>
    request(IPC.UserStylesRemove, name),
  onUserStylesChanged: (cb: (state: UserStyleState) => void): (() => void) =>
    subscribe<UserStyleState>(IPC.UserStylesChanged, cb)
}

/**
 * 桥**只暴露一次取用函数**,不再直接暴露 `api` 对象。
 *
 * 原因:render 层(见清单的 render)与主界面跑在同一个 realm 里,contextBridge
 * 暴露的属性既不可删除也不可改写(实测 configurable:false / writable:false)。
 * 只要 `window.api` 存在,插件就能调用应用的全部 IPC —— 那渲染半"没有系统能力"
 * 的承诺就不成立。改成一次性取用后:
 *   - 应用在入口(renderer/src/main.ts 的第一条 import)取走并保存在模块闭包里;
 *   - 之后任何页面脚本(包括插件)再调用这个函数都只能拿到 null。
 * 注意:取用必须发生在**任何插件代码加载之前** —— 由 main.ts 的 import 顺序保证。
 */
let apiTaken = false
contextBridge.exposeInMainWorld('__imarkTakeApi', () => {
  if (apiTaken) return null
  apiTaken = true
  return api
})

export type RendererApi = typeof api
