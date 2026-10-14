import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { Settings, Theme } from '@shared/types'

/** 各主题的窗口底色,用于首帧(渲染完成前)避免白闪 */
const WINDOW_BG: Record<Theme, string> = { light: '#ffffff', dark: '#0d1117', black: '#000000' }

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
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 620,
    minHeight: 400,
    show: false,
    title: 'iMark',
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

export function setWindowTitle(name: string, isDirty: boolean, vaultName?: string | null): void {
  currentFileName = name
  currentVaultName = vaultName ?? null
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
