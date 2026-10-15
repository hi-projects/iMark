import { dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { SaveDialogOptions, Settings } from '@shared/types'
import { getMainWindow, handleSaveDone, setDocDirty, setWindowTitle } from './window'
import {
  showConfirmDelete,
  showConfirmDiscard,
  showOpenFileDialog,
  showSaveFileDialog
} from './dialogs'
import { readFileContent, writeFileAtomic } from './files'
import { getSettings, saveSettings } from './settings'
import { getPluginHost, type PluginHost } from './plugins/host'
import { registerMarketIpc } from './market/ipc'
import {
  createVaultDir,
  createVaultFile,
  listVault,
  renameVaultPath,
  trashVaultPath
} from './vault'

/** 校验只允许 http(s) 外链,防 file:/自定义协议注入 */
function safeOpenExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url)
  }
}

/** 插件系统由 index.ts 在窗口创建前初始化,这里只做兜底断言 */
function requirePluginHost(): PluginHost {
  const host = getPluginHost()
  if (!host) throw new Error('插件系统尚未就绪')
  return host
}

export function registerIpc(): void {
  ipcMain.handle(IPC.FileOpenDialog, async () => {
    const win = getMainWindow()
    return win ? showOpenFileDialog(win) : null
  })

  ipcMain.handle(IPC.FileSaveDialog, async (_e, o: SaveDialogOptions) => {
    const win = getMainWindow()
    return win ? showSaveFileDialog(win, o) : null
  })

  ipcMain.handle(IPC.FileRead, (_e, path: string) => readFileContent(path))

  ipcMain.handle(IPC.FileWrite, async (_e, o: { path: string; content: string }) => {
    await writeFileAtomic(o.path, o.content)
  })

  ipcMain.handle(IPC.ConfirmDiscard, (_e, o: { fileName: string }) => {
    const win = getMainWindow()
    return win ? showConfirmDiscard(win, o.fileName) : 'cancel'
  })

  ipcMain.handle(IPC.SettingsGet, () => getSettings())

  ipcMain.handle(IPC.SettingsSet, (_e, partial: Partial<Settings>) => {
    // plugins 只由插件宿主写(它要保证归一化与生命周期),渲染层传来的这份一律忽略
    const { plugins: _ignored, ...rest } = partial
    return saveSettings(rest)
  })

  ipcMain.handle(IPC.OpenExternal, (_e, url: string) => {
    safeOpenExternal(url)
  })

  ipcMain.on(IPC.SetTitle, (_e, o: { name: string; dirty: boolean; vaultName?: string | null }) => {
    setWindowTitle(o.name, o.dirty, o.vaultName)
  })

  ipcMain.on(IPC.DocDirty, (_e, value: boolean) => {
    setDocDirty(value)
  })

  ipcMain.on(IPC.SaveDone, (_e, o: { ok: boolean }) => {
    handleSaveDone(o.ok)
  })

  // ---------- 仓库 ----------

  ipcMain.handle(IPC.VaultSelectDialog, async () => {
    const win = getMainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle(IPC.VaultList, (_e, p: string) => listVault(p))

  ipcMain.handle(IPC.VaultCreateFile, async (_e, o: { path: string; content?: string }) => {
    await createVaultFile(o.path, o.content ?? '')
  })

  ipcMain.handle(IPC.VaultCreateDir, async (_e, o: { path: string }) => {
    await createVaultDir(o.path)
  })

  ipcMain.handle(IPC.VaultRename, async (_e, o: { from: string; to: string }) => {
    await renameVaultPath(o.from, o.to)
  })

  ipcMain.handle(IPC.VaultDelete, async (_e, o: { path: string }) => {
    await trashVaultPath(o.path)
  })

  ipcMain.handle(IPC.VaultConfirmDelete, (_e, o: { name: string; isDir: boolean }) => {
    const win = getMainWindow()
    return win ? showConfirmDelete(win, o.name, o.isDir) : false
  })

  // ---------- 插件 ----------

  ipcMain.handle(IPC.PluginList, () => requirePluginHost().list())

  ipcMain.handle(
    IPC.PluginSave,
    async (_e, o: { id: string; enabled?: boolean; config?: Record<string, unknown> }) => {
      const host = requirePluginHost()
      await host.save(o.id, { enabled: o.enabled, config: o.config })
      return host.list()
    }
  )

  ipcMain.handle(
    IPC.PluginSetSecret,
    async (_e, o: { id: string; fieldKey: string; targetId: string | null; value: string | null }) => {
      const host = requirePluginHost()
      await host.setSecretValue(o.id, o.fieldKey, o.targetId, o.value)
      return host.list()
    }
  )

  ipcMain.handle(IPC.PluginRun, (_e, o: { id: string; action: string; targetId?: string }) =>
    requirePluginHost().runAction(o.id, o.action, o.targetId)
  )

  ipcMain.on(IPC.PluginFlushDone, () => {
    getPluginHost()?.handleFlushDone()
  })

  // ---------- 插件市场 ----------

  registerMarketIpc()
}
