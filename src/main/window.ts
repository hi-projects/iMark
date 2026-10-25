import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { Settings, Theme } from '@shared/types'
import { appIconPng } from './appIcon'
import { getSettingsSync, onSettingsChanged } from './settings'
import { hasPendingOpenFile } from './openFile'
import { APP_USER_MODEL_ID, NEW_WINDOW_FLAG } from './launchArgs'
import { taskbarIconPath } from './system'

/**
 * 窗口图标(任务栏 / Alt+Tab / 窗口列表里那个)。
 *
 * **必须显式给,Linux 上的 Electron 不会自己去读 desktop 条目的 Icon=**:
 * 不给的话窗口的 `_NET_WM_ICON` 属性就是空的(xprop 实测 `not found`),
 * 那些地方显示的是 Electron 的默认图标 —— 和应用网格里的 iMark 图标对不上。
 *
 * 路径解析(`?asset` / 源码目录 / resources)见 appIcon.ts。
 */
function windowIcon(): string | undefined {
  return appIconPng()
}

/** 各主题的窗口底色,用于首帧(渲染完成前)避免白闪 */
const WINDOW_BG: Record<Theme, string> = { light: '#ffffff', dark: '#262626' }

/**
 * 无边框窗口(WCO)的顶部配色 —— 去掉 Windows 原生那条浅色标题栏,
 * 和 Obsidian / VSCode 一样让窗口控件直接浮在应用自己的顶栏上。
 *
 * `titleBarOverlay` 只画右上角控件那一块(实测 138×36 DIP),其余顶部区域
 * 仍是网页内容,所以颜色只要跟当前视图的顶部底色一致,视觉上就不存在"标题栏"。
 * 仓库选择页铺的是 --bg-editor,编辑器是 --bg-app;符号色用 --text-secondary。
 */
const WINDOW_CHROME: Record<Theme, { app: string; editor: string; symbol: string }> = {
  light: { app: '#f8f9fb', editor: '#ffffff', symbol: '#57606a' },
  dark: { app: '#212121', editor: '#262626', symbol: '#b3b3b3' }
}

/** 与 .tab-bar / 两侧顶栏同高(见 tabs.css):窗口控件正好占满顶部这一行 */
const TITLE_BAR_HEIGHT = 36

/** 当前视图决定顶部底色;由 setWindowView(渲染层切换视图时调用)更新 */
let currentView: 'picker' | 'editor' = 'picker'

function applyWindowChrome(w: BrowserWindow, theme: Theme, view: 'picker' | 'editor'): void {
  w.setBackgroundColor(WINDOW_BG[theme] ?? WINDOW_BG.light)
  // 只有 Windows 用了 WCO;macOS 的交通灯 / Linux 的原生标题栏保持原样
  if (process.platform !== 'win32') return
  const c = WINDOW_CHROME[theme] ?? WINDOW_CHROME.light
  w.setTitleBarOverlay({
    color: view === 'picker' ? c.editor : c.app,
    symbolColor: c.symbol,
    height: TITLE_BAR_HEIGHT
  })
}

/** 仓库选择页的窗口尺寸。打开仓库后会最大化;取消最大化会回到这个尺寸 */
const PICKER_SIZE = { width: 820, height: 550 }

/**
 * 登记任务栏的「再启动一份」命令(Windows 专用)。
 *
 * 中键 / Shift+点击任务栏图标时,Windows 不是给现有窗口发事件,而是按窗口上登记的
 * `System.AppUserModel.RelaunchCommand` 再执行一次。给它加上 `--new-window`,
 * 新进程才知道这是用户明确要的新窗口,不会去恢复上次仓库、也不会被仓库占用协调
 * 挡回去(见 launchArgs.ts / vaultHandoff.ts)。
 *
 * 两个属性必须成对设置,而 `appId` 不设则整组都会被 Windows 忽略 —— 所以三者
 * 一起给。打包版的 appId 与 electron-builder.yml 保持一致,任务栏分组才对得上;
 * 开发版带 .dev 后缀(见 launchArgs.ts),否则会复用打包版 ID 上缓存的旧图标。
 *
 * **`appIconPath` 必须指一张真正的 `.ico`**。它写的是
 * `System.AppUserModel.RelaunchIconResource`,Windows 11 拿它画任务栏按钮的图标:
 *   - 指 `process.execPath`:开发版是 electron.exe(原子图标),打包版跳过 rcedit
 *     时 exe 也还是 Electron 图标 —— 两种都会把 iMark 顶掉(2026-10-25 实测);
 *   - 完全不传:也一样回落到 exe 的图标(同一天用纯绿图标验证过);
 *   - 指 asar 里的路径:Windows 打不开。
 * 所以用 `prepareTaskbarIcon()` 预先生成在数据根的那张(见 system.ts)。
 */
function applyTaskbarRelaunch(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  // 开发版 process.execPath 是 electron.exe,得把应用目录也带上;打包版就是 exe 自己
  const relaunchCommand = app.isPackaged
    ? `"${process.execPath}" ${NEW_WINDOW_FLAG}`
    : `"${process.execPath}" "${app.getAppPath()}" ${NEW_WINDOW_FLAG}`
  const iconPath = taskbarIconPath()
  try {
    win.setAppDetails({
      appId: APP_USER_MODEL_ID,
      relaunchCommand,
      relaunchDisplayName: 'iMark',
      ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {})
    })
    if (!app.isPackaged) console.log(`[iMark] 任务栏「新开一个」命令:${relaunchCommand}`)
  } catch (err) {
    // 登记失败只影响任务栏中键新开窗口,不该拦住应用启动
    console.warn('[iMark] 登记任务栏重启动命令失败:', err)
  }
}

let mainWindow: BrowserWindow | null = null
let dirty = false
/** 有未保存改动的标签页名(窗口关闭提示里列出来,免得只提当前那一个) */
let dirtyNames: string[] = []
let closing = false
let pendingSave = false
let currentFileName = '未命名'
let currentVaultName: string | null = null
let forceCloseTimer: ReturnType<typeof setTimeout> | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 主窗口关闭后要做的事(目前是 app.quit);由 index.ts 设置 */
let mainWindowClosedHandler: (() => void) | null = null

export function setMainWindowClosedHandler(fn: () => void): void {
  mainWindowClosedHandler = fn
}

export function createMainWindow(
  settings: Settings,
  options?: { startAtPicker?: boolean }
): BrowserWindow {
  // 勾了「启动时直接打开上次仓库」就直接最大化开窗,免得先小后大地闪一下
  // (渲染层的视图切换发生在建窗之后)。带文件启动(双击 .md)同理:
  // 渲染层会直接进编辑器打开这份文件,窗口没理由先以选择页的尺寸露一下。
  // options.startAtPicker:任务栏「新开一个」明确要的是空窗口,别恢复上次仓库。
  const startAtPicker =
    options?.startAtPicker ??
    (!hasPendingOpenFile() && !(settings.skipVaultPicker && settings.vaultPath))
  currentView = startAtPicker ? 'picker' : 'editor'
  const chrome = WINDOW_CHROME[settings.theme] ?? WINDOW_CHROME.light
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
    /*
     * Windows:藏掉原生标题栏。系统的最小化/最大化/关闭仍由 WCO 画在右上角,
     * 颜色跟着主题走;顶部其余区域还是网页内容,由渲染层的拖拽区负责移动窗口。
     * 其他平台保持原生标题栏 —— macOS 的交通灯位置、Linux 的 WCO 兼容性
     * 都需要单独适配,不在这次改动里冒险。
     */
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: startAtPicker ? chrome.editor : chrome.app,
            symbolColor: chrome.symbol,
            height: TITLE_BAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // 任务栏中键/Shift+点击新开窗口靠这条命令;必须在窗口建好后登记
  applyTaskbarRelaunch(mainWindow)

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
    // 多标签页时脏的可能不止当前这一份。提示里把名字列全,
    // 否则「是否保存对 A 的更改」会让用户以为 B 的改动已经安全了
    const multiple = dirtyNames.length > 1
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      message: multiple
        ? `有 ${dirtyNames.length} 个文档有未保存的更改`
        : `是否保存对「${dirtyNames[0] ?? currentFileName}」的更改?`,
      detail: multiple
        ? `${dirtyNames.join('\n')}\n\n如果不保存就关闭,这些更改将丢失。`
        : '如果不保存就关闭,更改将丢失。',
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
    // 渲染层崩溃或未加载完成时的兜底强关。
    // 时间给得长:多标签页关闭时会逐个保存,未命名文档还会弹出「另存为」——
    // 用户正对着对话框选路径时,5 秒就销毁窗口等于把刚敲的内容直接扔掉
    forceCloseTimer = setTimeout(() => {
      closing = true
      mainWindow?.destroy()
    }, 120_000)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 退出决策交给 index.ts
    mainWindowClosedHandler?.()
  })

  // 切换主题时窗口底色与 WCO 配色跟着换。saveSettings 是唯一漏斗,挂在它上面
  // 能覆盖状态栏快捷键、设置面板、扩展改设置等所有路径
  const offSettings = onSettingsChanged((next, prev) => {
    if (next.theme === prev.theme || !mainWindow) return
    applyWindowChrome(mainWindow, next.theme, currentView)
  })
  mainWindow.once('closed', offSettings)

  return mainWindow
}

export function setDocDirty(value: boolean, names: string[] = []): void {
  dirty = value
  dirtyNames = names
}

/**
 * 渲染层报告它**实际画出来**的主题。
 *
 * 窗口控件那块(WCO)由主进程画,但它必须和界面同色。只靠「设置变了」触发
 * 不够:渲染层可能因为启动时的某一步失败而退回默认主题(见 App.vue 的启动
 * 兜底),这时设置没变、主进程也不会收到变更通知,右上角就会留下一块深色
 * 标题区。渲染层应用主题后主动报一次,颜色永远跟界面一致。
 */
export function setWindowTheme(theme: Theme): void {
  if (!mainWindow) return
  applyWindowChrome(mainWindow, theme, currentView)
}

/**
 * 跟随视图切换窗口状态:仓库选择页是启动尺寸,打开仓库后最大化。
 *
 * 取消最大化时 Windows 会还原到最大化之前的尺寸,也就是建窗时的 PICKER_SIZE,
 * 所以不需要在这里显式设回尺寸。
 */
export function setWindowView(view: 'picker' | 'editor'): void {
  if (!mainWindow) return
  if (view !== currentView) {
    currentView = view
    // 两个视图的顶部底色不同(选择页 --bg-editor,编辑器 --bg-app),
    // WCO 那块也要跟着换,否则选择页右上角会出现一个色块
    applyWindowChrome(mainWindow, getSettingsSync()?.theme ?? 'light', view)
  }
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
 * (见 protocol.ts 的 allowedRoots)与「扩展要写的这个文件是不是正开着的那个」。
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
 * name 传 null 表示当前没有打开的文档。
 *
 * 两种「没有文档」要分开看,区别就在 vaultName:
 * - 仓库选择页:调用方连仓库名一起传 null,标题只留应用名;
 * - 已进入编辑器但没打开页面:仓库名照常传,标题显示「仓库名 - iMark」。
 *
 * 注意别用「vaultName 为空」来代替这个判断 —— 从编辑器退回选择页时
 * (requestVaultSwitch)仓库名仍然是设着的,那样会漏掉。
 */
export function setWindowTitle(name: string | null, isDirty: boolean, vaultName?: string | null): void {
  currentVaultName = vaultName ?? null
  if (name === null) {
    mainWindow?.setTitle(currentVaultName ? `${currentVaultName} - iMark` : 'iMark')
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
