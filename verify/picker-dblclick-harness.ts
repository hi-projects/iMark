/**
 * 仓库选择页：双击拖拽区**不该**把窗口放大（编辑器视图不受影响）。
 *
 * Windows 上 `-webkit-app-region: drag` 就是非客户区标题栏，双击会变成
 * SC_MAXIMIZE。真实双击路径绕过了 WM_NCLBUTTONDBLCLK 的 hook（Chromium 自己
 * 判断后直接发 SYSCOMMAND），所以实现改成「选择页不可最大化」（见
 * src/main/window.ts 的 setWindowView）。
 *
 * 这里先验证原生状态与消息路径；加 IMARK_VERIFY_INPUT=1 再跑一遍真实鼠标双击
 * （窗口 1% 透明度，肉眼不可见）。
 *
 *   IMARK_VERIFY_HIDDEN=1 node verify/run.mjs picker-dblclick
 */

import { app, BrowserWindow, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { createMainWindow, setWindowView } from '../src/main/window'

const run = promisify(execFile)
const isWindows = process.platform === 'win32'
const REAL_INPUT = process.env.IMARK_VERIFY_INPUT === '1' && isWindows

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const PREFIX = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct POINT { public int X, Y; }
public class Native {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
`

function psEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.LIB
  delete env.INCLUDE
  // shell 的 TEMP 是 C:\WINDOWS\TEMP（不可写）:Add-Type 编译时会报找不到源文件
  const tmp = join(process.env.LOCALAPPDATA ?? '', 'Temp')
  env.TEMP = tmp
  env.TMP = tmp
  return env
}

async function powershell(body: string): Promise<string> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PREFIX + body],
    { env: psEnv(), timeout: 30_000 }
  )
  return stdout
}

/** 屏幕坐标处的 WM_NCHITTEST 返回值（2 = HTCAPTION 拖拽区） */
async function hitTest(hwnd: string, x: number, y: number): Promise<number> {
  const out = await powershell(`
$hwnd = [IntPtr][long]${hwnd}
$lp = [IntPtr](((${Math.round(y)} -band 0xFFFF) -shl 16) -bor (${Math.round(x)} -band 0xFFFF))
[Native]::SendMessage($hwnd, 0x84, [IntPtr]::Zero, $lp).ToInt64()
`)
  return Number(out.trim())
}

/** 发一条 WM_NCLBUTTONDBLCLK（wParam = HTCAPTION），等同于系统对标题栏双击的处理 */
async function postNcDoubleClick(hwnd: string, x: number, y: number): Promise<void> {
  await powershell(`
$hwnd = [IntPtr][long]${hwnd}
$lp = [IntPtr](((${Math.round(y)} -band 0xFFFF) -shl 16) -bor (${Math.round(x)} -band 0xFFFF))
[Native]::SendMessage($hwnd, 0x00A3, [IntPtr]2, $lp) | Out-Null
`)
}

/**
 * 在屏幕坐标上点 count 次（2 次即双击），返回前后状态。
 * 调用方负责先用一次页面内的单击把窗口激活 —— 直接双击标题栏时，第一下可能
 * 只被系统当成「激活窗口」，第二次才进入双击计数，结果不稳定。
 */
async function realClicks(hwnd: string, x: number, y: number, count: 1 | 2): Promise<string> {
  return powershell(`
$hwnd = [IntPtr][long]${hwnd}
$old = New-Object POINT
[Native]::GetCursorPos([ref]$old) | Out-Null
$isFg = ([Native]::GetForegroundWindow() -eq $hwnd)
$zoomBefore = [Native]::IsZoomed($hwnd)
[Native]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 120
$clicks = ${count}
for ($i = 0; $i -lt $clicks; $i++) {
  if ($i -gt 0) { Start-Sleep -Milliseconds 90 }
  [Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
Start-Sleep -Milliseconds 800
$zoomAfter = [Native]::IsZoomed($hwnd)
$isFgAfter = ([Native]::GetForegroundWindow() -eq $hwnd)
[Native]::SetCursorPos($old.X, $old.Y) | Out-Null
"isFg=$isFg isFgAfter=$isFgAfter zoomBefore=$zoomBefore zoomAfter=$zoomAfter"
`)
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('必须带 --user-data-dir（用 node verify/run.mjs picker-dblclick 跑）')
    app.exit(2)
    return
  }
  app.on('window-all-closed', () => {})
  await app.whenReady()

  const ud = app.getPath('userData')
  await mkdir(ud, { recursive: true })
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: false,
        vaultPath: null,
        vaults: [],
        lastFile: null,
        openFiles: [],
        autoSaveMode: 'off',
        marketUrl: '',
        marketAutoCheck: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.webContents.setBackgroundThrottling(false)
  win.setOpacity(REAL_INPUT ? 0.01 : 0)
  win.setSkipTaskbar(true)
  win.setAlwaysOnTop(true)
  // hidden-window-launcher 会设鼠标穿透，会让 WM_NCHITTEST 与真实点击失真
  win.setIgnoreMouseEvents(false)
  await new Promise<void>(res => win.webContents.once('did-finish-load', () => res()))
  await sleep(1000)

  function evalJs<T>(code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(code: string, ms = 10_000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      } catch {
        /* 页面还没就绪 */
      }
      await sleep(60)
    }
    return false
  }

  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  /** 顶部拖拽条中点（窗口内 8px 处；选择页的 .vault-picker-main/sidebar 是 drag） */
  const topStrip = (): { x: number; y: number } => {
    const b = win.getContentBounds()
    return { x: b.x + b.width / 2, y: b.y + 8 }
  }
  /** 页面元素中心点 → 屏幕坐标 */
  async function pointOf(selector: string): Promise<{ x: number; y: number } | null> {
    const rect = await evalJs<{ x: number; y: number; w: number; h: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })()`)
    if (!rect) return null
    const b = win.getContentBounds()
    return { x: b.x + rect.x + rect.w / 2, y: b.y + rect.y + rect.h / 2 }
  }

  if (!isWindows) {
    console.log('跳过：这里验证的是 Windows 的标题栏双击路径')
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
    app.exit(0)
    return
  }

  console.log('\n【A】选择页：窗口不可最大化')
  check('停在仓库选择页', await waitFor(`document.querySelector('.vault-picker')`))
  const p1 = topStrip()
  check('顶部仍是拖拽区（窗口还能拖）', (await hitTest(hwnd, p1.x, p1.y)) === 2)
  check('窗口当前未最大化', !win.isMaximized())
  check('选择页已禁用最大化（最大化按钮变灰）', !win.isMaximizable())

  await postNcDoubleClick(hwnd, p1.x, p1.y)
  await sleep(500)
  check('双击标题栏没有放大', !win.isMaximized())

  console.log('\n【B】编辑器视图：最大化能力恢复，顶栏双击照常')
  setWindowView('editor')
  await sleep(500)
  check('切到编辑器后重新可最大化', win.isMaximizable())
  check('切到编辑器后窗口最大化', win.isMaximized())
  const p2 = topStrip()
  await postNcDoubleClick(hwnd, p2.x, p2.y)
  await sleep(500)
  check('编辑器顶栏双击还原', !win.isMaximized())

  setWindowView('picker')
  await sleep(500)
  check('回到选择页后窗口还原到启动尺寸', !win.isMaximized())
  check('回到选择页后再次禁止最大化', !win.isMaximizable())
  const p3 = topStrip()
  await postNcDoubleClick(hwnd, p3.x, p3.y)
  await sleep(500)
  check('选择页双击仍不放大', !win.isMaximized())

  if (REAL_INPUT) {
    console.log('\n【C】真实鼠标双击（IMARK_VERIFY_INPUT=1）')
    win.moveTop()

    // 先在页面内(no-drag 的 Logo/标题区)点一下把窗口激活:直接双击标题栏时
    // 第一下可能只被系统当成激活窗口,双击计数不稳定。
    const activate = async (): Promise<void> => {
      const hero = await pointOf('.vault-picker-hero')
      if (hero) console.log('   [activate]', (await realClicks(hwnd, hero.x, hero.y, 1)).trim())
    }
    await activate()

    // 对照：把最大化能力临时打开，同一条真实双击路径应当能放大。
    // 有这一步才能证明鼠标输入确实送到了窗口，而不是"没点到所以没变化"。
    win.setMaximizable(true)
    const p4 = topStrip()
    console.log('   [control]', (await realClicks(hwnd, p4.x, p4.y, 2)).trim())
    check('对照：允许最大化时真实双击会放大', win.isMaximized())

    win.unmaximize()
    await sleep(500)
    setWindowView('picker')
    await sleep(300)
    await activate()
    const p5 = topStrip()
    console.log('   [guard]', (await realClicks(hwnd, p5.x, p5.y, 2)).trim())
    check('真实双击标题栏不放大', !win.isMaximized())
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[picker-dblclick] 未捕获异常:', err)
  app.exit(1)
})
