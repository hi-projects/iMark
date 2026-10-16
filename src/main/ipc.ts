import { dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  DockSlotRect,
  PluginActionPayload,
  PluginContribInvoke,
  PluginUiClick
} from '@shared/plugins'
import type { SaveDialogOptions, Settings } from '@shared/types'
import {
  currentDocPath,
  getMainWindow,
  handleSaveDone,
  hasEditor,
  setCurrentDocPath,
  setDocDirty,
  setEditorPresent,
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
import {
  ensureUserStylesDir,
  importUserStyle,
  importUserStylesFromDir,
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

  ipcMain.on(IPC.SetTitle, (_e, o: { name: string | null; dirty: boolean; vaultName?: string | null }) => {
    setWindowTitle(o.name, o.dirty, o.vaultName)
  })

  ipcMain.on(IPC.SetView, (_e, view: 'picker' | 'editor') => {
    setWindowView(view)
  })

  ipcMain.on(IPC.DocDirty, (_e, value: boolean) => {
    setDocDirty(value)
  })

  ipcMain.on(IPC.DocPath, (_e, p: unknown) => {
    const path = typeof p === 'string' ? p : null
    // 换了文件要告诉插件。放在这里而不是窗口那一层:插件事件的触发点应当集中在
    // 一处,不然「哪些事插件能知道」就要满仓找 ipcMain.on 才说得清。
    const changed = currentDocPath() !== path
    setCurrentDocPath(path)
    if (changed) {
      void getPluginHost()?.emit('file:open', { filePath: path })
      // 有了路径就意味着编辑器里有东西 —— 命令的可用性变了(见 contextChanged)
      getPluginHost()?.contextChanged()
    }
  })

  ipcMain.on(IPC.EditorPresence, (_e, value: unknown) => {
    // 比的是**结论**而不是这个布尔值本身:路径也在参与判断,文档没变时
    // 这个字段怎么翻都不会改变结论,那就没必要重算一遍菜单
    const before = hasEditor()
    setEditorPresent(Boolean(value))
    if (hasEditor() !== before) getPluginHost()?.contextChanged()
  })

  ipcMain.on(IPC.DocChanged, (_e, o: { dirty?: boolean; words?: number; chars?: number }) => {
    void getPluginHost()?.emit('document:change', {
      filePath: currentDocPath(),
      dirty: Boolean(o?.dirty),
      words: Number(o?.words) || 0,
      chars: Number(o?.chars) || 0
    })
  })

  ipcMain.on(IPC.SaveDone, (_e, o: { ok: boolean }) => {
    handleSaveDone(o.ok)
  })

  // 一次真的写盘完成了(手动保存、定时保存、另存为都走这儿)。
  // 关闭前那次保存走的是上面的 SaveDone —— 那条路上渲染层调用 saveCurrentFile,
  // 于是这里照样会收到一条,不必在那边重复发。
  ipcMain.on(IPC.DocSaved, (_e, path: unknown) => {
    const saved = typeof path === 'string' && path ? path : currentDocPath()
    void getPluginHost()?.emit('document:save', { filePath: saved, ok: true })
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

  ipcMain.handle(
    IPC.PluginRun,
    (_e, o: { id: string; action: string; targetId?: string; payload?: PluginActionPayload }) =>
      requirePluginHost().runAction(o.id, o.action, o.targetId, o.payload)
  )

  ipcMain.handle(
    IPC.PluginSetNetAccess,
    async (_e, o: { id: string; allow: boolean }) => {
      const host = requirePluginHost()
      await host.setNetAccess(o.id, o.allow)
      return host.list()
    }
  )

  ipcMain.handle(IPC.PluginOpenWindow, (_e, id: string) => {
    requirePluginHost().openWindow(id)
  })

  // 渲染层报来的两类回执:停靠面板的位置、注入界面里的点击。
  // 两条都是**渲染层说、宿主照做** —— 位置由它算(它才知道布局),点击由它捕获
  // (只有它看得见 DOM)
  ipcMain.on(IPC.PluginDockRect, (_e, rect: DockSlotRect) => {
    getPluginHost()?.handleDockRect(rect)
  })

  ipcMain.on(IPC.PluginUiClick, (_e, click: PluginUiClick) => {
    void getPluginHost()?.handleUiClick(click)
  })

  ipcMain.on(IPC.PluginFlushDone, () => {
    getPluginHost()?.handleFlushDone()
  })

  // ---------- 插件界面贡献点 ----------

  ipcMain.handle(IPC.PluginContribGet, async () => {
    const host = getPluginHost()
    if (!host) return { contribs: [], context: { hasEditor: false, hasVault: false } }
    // 可用性判定要在主进程算:渲染层拿到的每条命令已经带上了「现在能不能用」,
    // 这样两边看到的结论天生一致(渲染层无法只靠自己的状态算出同一个答案 ——
    // 它不知道主进程视角的仓库状态)
    return { contribs: await host.contributions(), context: host.commandContext() }
  })

  ipcMain.handle(IPC.PluginContribRun, (_e, o: PluginContribInvoke) => {
    return requirePluginHost().invokeContrib(o)
  })

  // ---------- 插件市场 ----------

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
    const outcome = await importUserStylesFromDir(picked)
    return { state: await readUserStyles(), outcome }
  })

  ipcMain.handle(IPC.UserStylesRemove, async (_e, name: string) => {
    await removeUserStyle(name)
    return readUserStyles()
  })
}
