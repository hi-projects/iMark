import { dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { SaveDialogOptions, Settings } from '@shared/types'
import {
  getMainWindow,
  handleSaveDone,
  setCurrentDocPath,
  setDocDirty,
  setWindowTheme,
  setWindowTitle,
  setWindowView
} from './window'
import {
  showConfirmDelete,
  showConfirmDiscard,
  showOpenCssDialog,
  showOpenCssDirDialog,
  showOpenFileDialog,
  showSaveFileDialog
} from './dialogs'
import {
  readFileContent,
  saveImageAsset,
  trashUnreferencedImageAssets,
  writeFileAtomic
} from './files'
import { getSettings, saveSettings } from './settings'
import { takePendingOpenFile } from './openFile'
import { defaultEditorStatus, registerAsDefaultEditor } from './system'
import { registerExtensionIpc } from './extensions/ipc'
import { registerMarketIpc } from './market/ipc'
import {
  createVaultDir,
  createVaultFile,
  listVault,
  missingVaults,
  renameVaultPath,
  trashVaultPath
} from './vault'
import { claimVault, releaseVault } from './vaultHandoff'
import { launchedForNewWindow } from './launchArgs'
import {
  ensureUserStylesDir,
  importUserStyle,
  importUserStyleDir,
  readUserStyles,
  removeUserStyle,
  userStylesDir
} from './userStyles'

/** 校验只允许 http(s) 外链,防 file:/自定义协议注入 */
function safeOpenExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url)
  }
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

  // 启动参数里带的文件(双击 .md 启动时那条路);渲染层初始化完后主动来取
  ipcMain.handle(IPC.OpenFileTake, () => takePendingOpenFile())

  // 任务栏中键 / Shift+点击「新开一个」:渲染层据此跳过自动恢复上次仓库
  ipcMain.handle(IPC.LaunchIntent, () => ({ newWindow: launchedForNewWindow }))

  // ---------- 系统(设置 → 系统) ----------
  ipcMain.handle(IPC.SystemDefaultEditorStatus, () => defaultEditorStatus())
  ipcMain.handle(IPC.SystemSetDefaultEditor, () => registerAsDefaultEditor())

  ipcMain.handle(IPC.FileWrite, async (_e, o: { path: string; content: string }) => {
    await writeFileAtomic(o.path, o.content)
  })

  ipcMain.handle(
    IPC.FileSaveImage,
    (_e, o: { docPath: string; mime: string; data: Uint8Array }) =>
      saveImageAsset(o.docPath, o.mime, o.data)
  )

  ipcMain.handle(
    IPC.FileTrashImages,
    (_e, o: { docPath: string; names: string[] }) =>
      trashUnreferencedImageAssets(o.docPath, o.names)
  )

  ipcMain.handle(IPC.ConfirmDiscard, (_e, o: { fileName: string }) => {
    const win = getMainWindow()
    return win ? showConfirmDiscard(win, o.fileName) : 'cancel'
  })

  ipcMain.handle(IPC.SettingsGet, () => getSettings())

  ipcMain.handle(IPC.SettingsSet, (_e, partial: Partial<Settings>) => {
    // 扩展相关的三组设置只由扩展服务写(它要保证归一化、持久化与宿主生命周期),
    // 渲染层把整份 settings 回传时这三组一律忽略 —— 否则设置面板保存一次主题
    // 就可能把扩展的启用态/配置覆盖回旧值。
    const { extensions: _ignoredExtensions, extensionHost: _ignoredHost, ...rest } = partial
    return saveSettings(rest)
  })

  ipcMain.handle(IPC.OpenExternal, (_e, url: string) => {
    safeOpenExternal(url)
  })

  ipcMain.on(IPC.SetTitle, (_e, o: { name: string | null; dirty: boolean; vaultName?: string | null }) => {
    setWindowTitle(o.name, o.dirty, o.vaultName)
  })

  ipcMain.on(IPC.SetView, (_e, view: 'picker' | 'editor') => {
    setWindowView(view)
    // 回到选择界面 = 这个窗口不再开着仓库,把占用让出来给别的实例
    if (view === 'picker') releaseVault()
  })

  ipcMain.on(IPC.SetTheme, (_e, theme: unknown) => {
    setWindowTheme(theme === 'dark' ? 'dark' : 'light')
  })

  ipcMain.on(IPC.DocDirty, (_e, value: unknown) => {
    // names 让关闭提示能列出所有有未保存改动的标签页,而不只是当前这一份
    const o = value as { dirty?: unknown; names?: unknown } | null
    const names = Array.isArray(o?.names)
      ? o.names.filter((n): n is string => typeof n === 'string' && n.length > 0)
      : []
    setDocDirty(Boolean(o?.dirty), names)
  })

  ipcMain.on(IPC.DocPath, (_e, p: unknown) => {
    setCurrentDocPath(typeof p === 'string' ? p : null)
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

  ipcMain.handle(IPC.VaultClaim, (_e, o: unknown) => {
    const input = o as { vaultPath?: unknown; filePath?: unknown } | null
    if (!input || typeof input.vaultPath !== 'string' || input.vaultPath.length === 0) return 'busy'
    return claimVault(
      input.vaultPath,
      typeof input.filePath === 'string' && input.filePath.length > 0 ? input.filePath : null
    )
  })

  ipcMain.handle(IPC.VaultRelease, (_e, vaultPath: unknown) => {
    releaseVault(typeof vaultPath === 'string' && vaultPath.length > 0 ? vaultPath : undefined)
  })

  ipcMain.handle(IPC.VaultList, (_e, p: string) => listVault(p))

  ipcMain.handle(IPC.VaultMissing, (_e, paths: unknown) =>
    missingVaults(
      Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
    )
  )

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

  // ---------- 扩展 ----------
  registerExtensionIpc()

  // ---------- 扩展市场 ----------

  registerMarketIpc()

  // ---------- 自定义样式 ----------

  ipcMain.handle(IPC.UserStylesList, () => readUserStyles())

  ipcMain.handle(IPC.UserStylesOpenDir, async () => {
    await ensureUserStylesDir()
    // openPath 不 reject:打不开时返回一句错误字符串,原样带给用户比静默强
    const problem = await shell.openPath(userStylesDir())
    if (problem) throw new Error(`打开样式文件夹失败:${problem}`)
  })

  ipcMain.handle(IPC.UserStylesImport, async () => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await showOpenCssDialog(win)
    // 用户取消不是错误(同市场挑包的约定),渲染层据此什么都不做
    if (!picked) return null
    const outcome = await importUserStyle(picked)
    return { state: await readUserStyles(), outcome }
  })

  ipcMain.handle(IPC.UserStylesImportDir, async () => {
    const win = getMainWindow()
    if (!win) return null
    const picked = await showOpenCssDirDialog(win)
    if (!picked) return null
    const outcome = await importUserStyleDir(picked)
    return { state: await readUserStyles(), outcome }
  })

  ipcMain.handle(IPC.UserStylesRemove, async (_e, name: string) => {
    await removeUserStyle(name)
    return readUserStyles()
  })
}
