import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { Settings, Theme } from '@shared/types'
import iconPath from '../../build/icon.png?asset'

/**
 * 窗口图标(任务栏 / Alt+Tab / 窗口列表里那个)。
 *
 * **必须显式给,Linux 上的 Electron 不会自己去读 desktop 条目的 Icon=**:
 * 不给的话窗口的 `_NET_WM_ICON` 属性就是空的(xprop 实测 `not found`),
 * 那些地方显示的是 Electron 的默认图标 —— 和应用网格里的 iMark 图标对不上。
 *
 * 首选 electron-vite 的 `?asset`:文件被复制进产物目录,再随 `files: [out/**]`
 * 一并进 asar —— **打包后唯一保证命中的就是它**(那时 `app.getAppPath()` 指向
 * app.asar,而 `build/` 不在 files 里)。后两条覆盖不经过 electron-vite 的形态:
 * 直接从源码目录跑(仓库里的 `build/icon.png`)与 electron-builder 打包后
 * (图标进 resources)。都不存在就返回 undefined,让 Electron 用默认图标 ——
 * 总好过递一个不存在的路径。
 */
function windowIcon(): string | undefined {
  const candidates = [
    iconPath,
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png')
  ]
  return candidates.find(p => existsSync(p))
}

/** 各主题的窗口底色,用于首帧(渲染完成前)避免白闪 */
const WINDOW_BG: Record<Theme, string> = { light: '#ffffff', dark: '#0d1117', black: '#000000' }

/** 仓库选择页的窗口尺寸。打开仓库后会最大化;取消最大化会回到这个尺寸 */
const PICKER_SIZE = { width: 820, height: 550 }

let mainWindow: BrowserWindow | null = null
let dirty = false
let closing = false
let pendingSave = false
let currentFileName = '未命名'
let currentVaultName: string | null = null
let forceCloseTimer: ReturnType<typeof setTimeout> | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(settings: Settings): BrowserWindow {
  // 勾了「启动时直接打开上次仓库」就直接最大化开窗,免得先小后大地闪一下
  // (渲染层的视图切换发生在建窗之后)
  const startAtPicker = !(settings.skipVaultPicker && settings.vaultPath)
  mainWindow = new BrowserWindow({
    width: PICKER_SIZE.width,
    height: PICKER_SIZE.height,
    minWidth: 620,
    minHeight: 400,
    show: false,
    title: 'iMark',
    // 窗口与任务栏图标。不设的话 Windows 会退回 exe 自带的图标,
    // 而 dev 下 exe 是 node_modules 里的 electron,于是显示 Electron 默认的原子图标。
    icon: windowIcon(),
    // 按主题预设背景色,避免启动白闪
    backgroundColor: WINDOW_BG[settings.theme] ?? WINDOW_BG.light,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // 隐藏原生菜单栏:菜单对象仍挂在窗口上,所以菜单里的加速键(Ctrl+N/O/S/P…)照常生效,
  // 只是不占窗口高度;非 auto-hide 模式,按 Alt 也不会再把它唤回来。
  // 注意别改成 Menu.setApplicationMenu(null) —— 那样菜单加速键会一并失效。
  mainWindow.setMenuBarVisibility(false)

  // show 之前就最大化,避免窗口先以小尺寸露一下
  if (!startAtPicker) mainWindow.maximize()

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 渲染层内的导航一律拒绝,外部链接走 shell
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', e => {
    if (!app.isPackaged) {
      console.log(`[iMark] 窗口 close 事件 closing=${closing} dirty=${dirty}`)
    }
    if (closing || !dirty) return
    e.preventDefault()
    // 原生保存对话框自身会再次派发 close 事件,靠 pendingSave 防递归
    if (pendingSave) {
      closing = true
      return
    }
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      message: `是否保存对「${currentFileName}」的更改?`,
      detail: '如果不保存就关闭,更改将丢失。',
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })
    if (choice === 2) return
    if (choice === 1) {
      closing = true
      mainWindow?.close()
      return
    }
    // 交给渲染层执行保存流程,完成后 notifySaveDone → win.close()
    pendingSave = true
    mainWindow!.webContents.send(IPC.SaveBeforeClose)
    // 渲染层崩溃或未加载完成时的兜底强关
    forceCloseTimer = setTimeout(() => {
      closing = true
      mainWindow?.destroy()
    }, 5000)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

export function setDocDirty(value: boolean): void {
  dirty = value
}

/**
 * 跟随视图切换窗口状态:仓库选择页是启动尺寸,打开仓库后最大化。
 *
 * 取消最大化时 Windows 会还原到最大化之前的尺寸,也就是建窗时的 PICKER_SIZE,
 * 所以不需要在这里显式设回尺寸。
 */
export function setWindowView(view: 'picker' | 'editor'): void {
  if (!mainWindow) return
  if (view === 'editor') {
    if (!mainWindow.isMaximized()) mainWindow.maximize()
  } else if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  }
}

/**
 * 当前打开文档的绝对路径(null = 没打开文件)。
 *
 * 主进程需要它来回答两个问题:「imark:// 这个请求读的图片能不能读」
 * (见 protocol.ts 的 allowedRoots)与「插件要写的这个文件是不是正开着的那个」。
 * 两者都不能靠猜 —— 主进程本来只拿得到标题里的文件名,而文件名不构成路径。
 */
let docPath: string | null = null

export function setCurrentDocPath(p: string | null): void {
  docPath = p || null
}

export function currentDocPath(): string | null {
  return docPath
}

/**
 * 编辑器里有没有文档(未保存的新文档也算)。
 *
 * 不能拿 docPath 是否为 null 代替:一份还没落过盘的新文档同样是在编辑文档,
 * 而它的路径恰好就是 null —— 两件事在"未命名文档"上结论相反。
 * 命令的可用性判定(`when: 'editor'`)要的是前者。
 */
let editorPresent = false

export function setEditorPresent(value: boolean): void {
  editorPresent = value
}

export function hasEditor(): boolean {
  return editorPresent || docPath !== null
}

/**
 * name 传 null 表示当前没有文档上下文(仓库选择页),标题只留应用名。
 *
 * 注意别用「vaultName 为空」来代替这个判断 —— 从编辑器退回选择页时
 * (requestVaultSwitch)仓库名仍然是设着的,那样会漏掉。
 */
export function setWindowTitle(name: string | null, isDirty: boolean, vaultName?: string | null): void {
  currentVaultName = vaultName ?? null
  if (name === null) {
    mainWindow?.setTitle('iMark')
    return
  }
  currentFileName = name
  const parts = [`${isDirty ? '● ' : ''}${name}`]
  if (currentVaultName) parts.push(currentVaultName)
  parts.push('iMark')
  mainWindow?.setTitle(parts.join(' - '))
}

/** 渲染层保存流程结束后的回调(ok=true 时关闭窗口) */
export function handleSaveDone(ok: boolean): void {
  if (forceCloseTimer) {
    clearTimeout(forceCloseTimer)
    forceCloseTimer = null
  }
  pendingSave = false
  if (ok) {
    closing = true
    mainWindow?.close()
  }
}
