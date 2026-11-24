import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  CloneVaultRequest,
  SaveDialogOptions,
  Settings,
  VaultGitRemoteInput
} from '@shared/types'
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
  restoreImageAssets,
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
import { cloneRepository, folderNameFromUrl } from './git'
import { getExtensionService } from './extensions/service'
import { moveProjectGit, readProjectGitRemotes, setProjectGitRemote } from './projectGit'
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
    (_e, o: { docPath: string; vaultPath?: string | null; mime: string; data: Uint8Array }) =>
      saveImageAsset(o.docPath, o.vaultPath ?? null, o.mime, o.data)
  )

  ipcMain.handle(
    IPC.FileTrashImages,
    (_e, o: { docPath: string; vaultPath?: string | null; names: string[] }) =>
      trashUnreferencedImageAssets(o.docPath, o.vaultPath ?? null, o.names)
  )

  ipcMain.handle(
    IPC.FileRestoreImages,
    (_e, o: { docPath: string; vaultPath?: string | null; names: string[] }) =>
      restoreImageAssets(o.docPath, o.vaultPath ?? null, o.names)
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

  // ---------- 通用 ----------

  ipcMain.handle(IPC.PickDirectory, async (_e, defaultPath: unknown) => {
    const win = getMainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件夹',
      ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle(IPC.OpenDirectory, async (_e, dir: unknown): Promise<string | null> => {
    if (typeof dir !== 'string' || !dir.trim()) return '目录为空'
    let path = dir.trim()
    if (path === '~') path = homedir()
    else if (path.startsWith('~/') || path.startsWith('~\\')) {
      path = join(homedir(), path.slice(2))
    }
    if (!isAbsolute(path)) return '目录必须是绝对路径'
    try {
      await mkdir(path, { recursive: true })
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    const error = await shell.openPath(path)
    return error || null
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

  ipcMain.handle(IPC.VaultClone, async (event, raw: unknown) => {
    const req = (raw && typeof raw === 'object' ? raw : {}) as Partial<CloneVaultRequest>
    const url = typeof req.url === 'string' ? req.url.trim() : ''
    if (!url) throw new Error('仓库地址不能为空')
    const parentDir = typeof req.parentDir === 'string' ? req.parentDir : ''
    if (!parentDir) throw new Error('请选择克隆到哪个位置')
    const name =
      (typeof req.name === 'string' && req.name.trim()) || folderNameFromUrl(url)
    const auth =
      req.auth === 'password' || req.auth === 'ssh' ? req.auth : ('token' as const)
    const branch = typeof req.branch === 'string' ? req.branch.trim() : ''
    const secret = typeof req.secret === 'string' ? req.secret : ''
    const outcome = await cloneRepository({
      url,
      parentDir,
      name,
      branch,
      username: typeof req.username === 'string' ? req.username : '',
      secret,
      onProgress: progress => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.VaultCloneProgress, progress)
        }
      }
    })
    if (!outcome.ok) throw new Error(outcome.detail)

    // 克隆出来的仓库自动登记为项目远端:打开它以后「远程同步」直接就有地址了。
    // 写失败不影响克隆本身(比如扩展被卸掉了),如实告诉渲染层没写进去。
    let remoteSaved = false
    try {
      await setProjectGitRemote(outcome.path, {
        url,
        auth,
        username: typeof req.username === 'string' ? req.username : '',
        localBranch: outcome.branch || branch || 'main',
        remoteBranch: '',
        secret
      })
      getExtensionService()?.notifyProjectGitChanged()
      remoteSaved = true
    } catch (err) {
      console.warn('[iMark] 克隆成功,但写入项目 Git 远端失败:', err)
    }
    return {
      path: outcome.path,
      branch: outcome.branch || branch || 'main',
      remoteSaved
    }
  })

  ipcMain.handle(IPC.VaultGitList, (_e, paths: unknown) =>
    readProjectGitRemotes(
      Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
    )
  )

  ipcMain.handle(IPC.VaultGitSet, async (_e, raw: unknown) => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as {
      path?: unknown
      remote?: unknown
    }
    if (typeof input.path !== 'string' || !input.path) throw new Error('仓库路径无效')
    const remote = input.remote as VaultGitRemoteInput | null | undefined
    await setProjectGitRemote(input.path, remote ?? null)
    getExtensionService()?.notifyProjectGitChanged()
  })

  ipcMain.handle(IPC.VaultCreateFile, async (_e, o: { path: string; content?: string }) => {
    await createVaultFile(o.path, o.content ?? '')
  })

  ipcMain.handle(IPC.VaultCreateDir, async (_e, o: { path: string }) => {
    await createVaultDir(o.path)
  })

  ipcMain.handle(IPC.VaultRename, async (_e, o: { from: string; to: string }) => {
    await renameVaultPath(o.from, o.to)
    // 项目 Git 配置按绝对路径索引:目录改名 / 移动后连密钥一起迁到新路径,
    // 否则仓库选择页里这个项目的 Git 设置会"消失"
    await moveProjectGit(o.from, o.to)
    getExtensionService()?.notifyProjectGitChanged()
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
