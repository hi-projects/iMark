import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type MenuCommandId } from '@shared/ipc-channels'
import type { MarketProgress, MarketQuery, MarketSource } from '@shared/market'
import type { PluginView } from '@shared/plugins'
import type { SaveDialogOptions, Settings } from '@shared/types'

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
  setWindowTitle: (name: string, dirty: boolean, vaultName?: string | null): void =>
    ipcRenderer.send(IPC.SetTitle, { name, dirty, vaultName }),
  setDocDirty: (dirty: boolean): void => ipcRenderer.send(IPC.DocDirty, dirty),
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
  runPluginAction: (id: string, action: string, targetId?: string) =>
    ipcRenderer.invoke(IPC.PluginRun, { id, action, targetId }),
  notifyPluginFlushed: (): void => ipcRenderer.send(IPC.PluginFlushDone),
  onPluginFlushDoc: (cb: () => void): (() => void) => subscribe<void>(IPC.PluginFlushDoc, cb),
  onPluginStatus: (cb: (plugins: PluginView[]) => void): (() => void) =>
    subscribe<PluginView[]>(IPC.PluginStatus, cb),
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
    ipcRenderer.invoke(IPC.MarketSource, id, version)
}

contextBridge.exposeInMainWorld('api', api)

export type RendererApi = typeof api
