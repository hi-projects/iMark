import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import type { MarketProgress, MarketQuery, MarketSource } from '@shared/market'
import type {
  CloneProgress,
  CloneVaultRequest,
  CloneVaultResult,
  DefaultEditorStatus,
  LaunchIntent,
  SaveDialogOptions,
  Settings,
  Theme,
  VaultClaimResult,
  VaultGitRemote,
  VaultGitRemoteInput
} from '@shared/types'
import type { UserStyleImportResult, UserStyleState } from '@shared/userStyles'
import type {
  ExtensionCommandInvocation,
  ExtensionCommandResult,
  ExtensionContributionsSnapshot,
  ExtensionHostSettingsPatch,
  ExtensionView
} from '@shared/extensions'
import type { MainToRendererMessage, RendererToMainMessage } from '@shared/extensionProtocol'

/*
 * 首帧之前定下主题。
 *
 * 主题令牌的默认值是亮色(见 @shared/theme/tokens.css),而渲染层要等异步取到设置
 * 才 applyTheme。深色主题下这两者之间的第一帧就是白底 —— 启动时肉眼可见地闪一下。
 * 主进程在建窗时通过 additionalArguments 把主题传进来,preload 在页面脚本与
 * 首次绘制之前就把 data-theme 写好,后续 applyTheme 只是覆盖同一个值。
 */
interface HtmlRoot {
  setAttribute(name: string, value: string): void
}
interface ThemeDocument {
  documentElement?: HtmlRoot | null
}
const root = globalThis as {
  document?: ThemeDocument
  MutationObserver?: new (cb: () => void) => {
    observe(target: ThemeDocument, options: { childList: boolean }): void
    disconnect(): void
  }
}
const themeArg = process.argv.find(arg => arg.startsWith('--imark-theme='))
const initialTheme = themeArg?.slice('--imark-theme='.length)
const themed = initialTheme === 'light' || initialTheme === 'dark'

/**
 * preload 执行时 `document.documentElement` 可能还不存在(实测为 null),所以不能
 * 只写一次:先试一次,不行就等 <html> 插进来。MutationObserver 的回调在解析阶段
 * 作为微任务跑,早于样式表加载完成后的首帧绘制,不会慢半拍又闪一下。
 */
function applyInitialTheme(): boolean {
  const element = root.document?.documentElement
  if (!element) return false
  element.setAttribute('data-theme', initialTheme!)
  // 样式表还没到时的首帧:画布默认是白的。先用与主题一致的底色兜住
  // (与主进程 BrowserWindow 的 backgroundColor 同一组颜色)。
  // 只写背景色:整份 style 会在 applyTheme 里被清掉,别把 color-scheme 也留在上面。
  const windowBg = initialTheme === 'dark' ? '#262626' : '#ffffff'
  element.setAttribute('style', `background:${windowBg}`)
  return true
}

if (themed) {
  if (!applyInitialTheme() && root.document && root.MutationObserver) {
    const observer = new root.MutationObserver(() => {
      if (applyInitialTheme()) observer.disconnect()
    })
    observer.observe(root.document, { childList: true })
  }
}

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
  saveImageAsset: (
    docPath: string,
    vaultPath: string | null,
    mime: string,
    data: Uint8Array
  ): Promise<string> =>
    request(IPC.FileSaveImage, { docPath, vaultPath, mime, data }),
  trashImageAssets: (docPath: string, vaultPath: string | null, names: string[]): Promise<void> =>
    request(IPC.FileTrashImages, { docPath, vaultPath, names }),
  restoreImageAssets: (docPath: string, vaultPath: string | null, names: string[]): Promise<void> =>
    request(IPC.FileRestoreImages, { docPath, vaultPath, names }),
  confirmDiscard: (fileName: string) => request(IPC.ConfirmDiscard, { fileName }),
  getSettings: (): Promise<Settings> => request(IPC.SettingsGet),
  saveSettings: (s: Partial<Settings>): Promise<Settings> => request(IPC.SettingsSet, s),
  openExternal: (url: string): Promise<void> => request(IPC.OpenExternal, url),
  setWindowTitle: (name: string | null, dirty: boolean, vaultName?: string | null): void =>
    ipcRenderer.send(IPC.SetTitle, { name, dirty, vaultName }),
  setWindowView: (view: 'picker' | 'editor'): void => ipcRenderer.send(IPC.SetView, view),
  /** 报告界面实际用的主题:窗口右上角的系统按钮跟着它换色 */
  setWindowTheme: (theme: Theme): void => ipcRenderer.send(IPC.SetTheme, theme),
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
  getLaunchIntent: (): Promise<LaunchIntent> => request(IPC.LaunchIntent),
  onOpenFile: (cb: (path: string) => void): (() => void) => subscribe<string>(IPC.OpenFileFromSystem, cb),
  defaultEditorStatus: (): Promise<DefaultEditorStatus> =>
    request(IPC.SystemDefaultEditorStatus),
  setDefaultEditor: (): Promise<DefaultEditorStatus> => request(IPC.SystemSetDefaultEditor),
  // ---------- 通用 ----------
  pickDirectory: (defaultPath?: string | null): Promise<string | null> =>
    request(IPC.PickDirectory, defaultPath ?? null),
  openDirectory: (path: string): Promise<string | null> =>
    request(IPC.OpenDirectory, path),
  // ---------- 仓库 ----------
  selectVaultDialog: (): Promise<string | null> => request(IPC.VaultSelectDialog),
  claimVault: (vaultPath: string, filePath?: string | null): Promise<VaultClaimResult> =>
    request(IPC.VaultClaim, { vaultPath, filePath: filePath ?? null }),
  releaseVault: (vaultPath: string): Promise<void> => request(IPC.VaultRelease, vaultPath),
  cloneVault: (o: CloneVaultRequest): Promise<CloneVaultResult> =>
    request(IPC.VaultClone, o),
  onCloneProgress: (cb: (p: CloneProgress) => void): (() => void) =>
    subscribe<CloneProgress>(IPC.VaultCloneProgress, cb),
  vaultGitRemotes: (paths: string[]): Promise<Record<string, VaultGitRemote | null>> =>
    request(IPC.VaultGitList, paths),
  setVaultGitRemote: (path: string, remote: VaultGitRemoteInput | null): Promise<void> =>
    request(IPC.VaultGitSet, { path, remote }),
  listVault: (path: string) => request(IPC.VaultList, path),
  missingVaults: (paths: string[]): Promise<string[]> => request(IPC.VaultMissing, paths),
  createFile: (path: string, content = ''): Promise<void> =>
    request(IPC.VaultCreateFile, { path, content }),
  createDir: (path: string): Promise<void> => request(IPC.VaultCreateDir, { path }),
  renamePath: (from: string, to: string): Promise<void> =>
    request(IPC.VaultRename, { from, to }),
  trashPath: (path: string): Promise<void> => request(IPC.VaultDelete, { path }),
  confirmDelete: (name: string, isDir: boolean): Promise<boolean> =>
    request(IPC.VaultConfirmDelete, { name, isDir }),
  // ---------- 扩展 ----------
  listExtensions: (): Promise<ExtensionView[]> => request(IPC.ExtensionList),
  extensionIcon: (id: string): Promise<string | null> => request(IPC.ExtensionIcon, id),
  readExtensionExternal: (id: string, key: string): Promise<string> =>
    request(IPC.ExtensionExternalGet, { id, key }),
  writeExtensionExternal: (id: string, key: string, value: string): Promise<void> =>
    request(IPC.ExtensionExternalSet, { id, key, value }),
  setExtensionEnabled: (id: string, enabled: boolean): Promise<ExtensionView[]> =>
    request(IPC.ExtensionSetEnabled, { id, enabled }),
  setExtensionField: (
    id: string,
    key: string,
    value: unknown
  ): Promise<ExtensionView[]> => request(IPC.ExtensionSetField, { id, key, value }),
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
  openExtensionExternalFile: (id: string, key: string): Promise<void> =>
    request(IPC.ExtensionExternalOpen, { id, key }),
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
  // ---------- 扩展市场 ----------
  pickMarketPackage: () => request(IPC.MarketPickPackage),
  packMarketDir: () => request(IPC.MarketPackDir),
  dropMarketPending: (token: string): Promise<void> =>
    request(IPC.MarketDropPending, token),
  installMarketPending: (token: string) => request(IPC.MarketInstallPending, token),
  uninstallMarketExtension: (id: string) => request(IPC.MarketUninstall, id),
  listMarketInstalled: () => request(IPC.MarketInstalled),
  restoreBundledExtensions: () => request(IPC.MarketRestoreBundled),
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
 * 桥**只暴露一次取用函数**,不直接暴露 `api` 对象。
 *
 * 原因:扩展页面与主界面跑在同一个 realm 里,contextBridge 暴露的属性
 * 既不可删除也不可改写(实测 configurable:false / writable:false)。
 * 只要 `window.api` 存在,扩展就能调用应用的全部 IPC —— 那「页面脚本没有
 * 系统能力」的承诺就不成立。一次性取用后:
 *   - 应用在入口(renderer/src/main.ts 的第一条 import)取走并保存在模块闭包里;
 *   - 之后任何页面脚本(包括扩展)再调用这个函数都只能拿到 null。
 * 注意:取用必须发生在**任何扩展代码加载之前** —— 由 main.ts 的 import 顺序保证。
 */
let apiTaken = false
contextBridge.exposeInMainWorld('__imarkTakeApi', () => {
  if (apiTaken) return null
  apiTaken = true
  return api
})
