/**
 * 末行光标几何验证:点最后一行的行内 vs 点最后一行下方的空白,
 * 光标矩形应当一致(高度、水平位置)。
 *
 * 现象:行首「+」按钮是行内 widget,最后一行为空时它和光标落在同一个文档位置。
 * 点击行下方的空白,CodeMirror 返回 assoc = -1;光标绘制按该侧的邻居取矩形,
 * 若取到「+」按钮(20×20,且藏在左侧 padding 里),光标就会变短、左移。
 *
 * 跑法(仓库根目录):
 *   node verify/run.mjs cursor
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

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

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface Spot {
  cursor: Rect | null
  line: Rect | null
  plus: Rect | null
  content: Rect | null
  lines: { text: string; cls: string; rect: Rect | null }[]
  active: string
  editorClass: string
  cursorCount: number
  cursorStyle: string | null
  layer: Rect | null
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs cursor` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const emptyNote = join(vault, '空.md')
  const tailNote = join(vault, '尾空行.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(emptyNote, '', 'utf8')
  // 最后一行是空行(文件以换行结尾),这是最常见的情况
  await writeFile(tailNote, '第一行\n第二行\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: emptyNote,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned)
  await getPluginHost()
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  /** 和 quick-edit harness 一样:窗口不 focus,CodeMirror 不认为自己在焦点里,光标层是隐藏的 */
  async function focusWindow(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await sleep(120)
  }

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  const spot = (): Promise<Spot> =>
    evalJs<Spot>(`(() => {
      const rect = el => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }
      const cursor = document.querySelector('.cm-cursor')
      return {
        cursor: rect(cursor),
        line: rect(document.querySelector('.cm-line')),
        plus: rect(document.querySelector('.line-plus')),
        content: rect(document.querySelector('.cm-content')),
        lines: Array.from(document.querySelectorAll('.cm-line')).map(l => ({
          text: l.textContent || '',
          cls: l.className,
          rect: rect(l)
        })),
        active: document.activeElement ? document.activeElement.className : '',
        editorClass: document.querySelector('.cm-editor')?.className ?? '',
        cursorCount: document.querySelectorAll('.cm-cursor').length,
        cursorStyle: cursor ? cursor.getAttribute('style') : null,
        layer: rect(document.querySelector('.cm-cursorLayer'))
      }
    })()`)

  async function clickAt(x: number, y: number): Promise<void> {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(300)
  }

  const near = (a: Rect | null, b: Rect | null, tol = 1): boolean =>
    !!a && !!b && Math.abs(a.left - b.left) <= tol && Math.abs(a.top - b.top) <= tol &&
    Math.abs(a.height - b.height) <= tol

  const fmt = (r: Rect | null): string =>
    r ? `left=${r.left.toFixed(1)} top=${r.top.toFixed(1)} h=${r.height.toFixed(1)}` : 'null'

  /** 通过左侧文件树打开(渲染层没把 api 挂到 window 上,只能走用户路径) */
  async function openNote(path: string): Promise<boolean> {
    const clicked = await evalJs<boolean>(`(() => {
      const row = document.querySelector('.explorer-file[title=${JSON.stringify(path)}]')
      if (!row) return false
      row.click()
      return true
    })()`)
    await focusWindow()
    await sleep(600)
    // setState 之后把焦点送回编辑器(用户点文件树后接着打字就是这个效果)
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await focusWindow()
    await sleep(200)
    return clicked
  }

  let observedEmptyLine = false
  let observedTailBlank = false

  // ---------- 空文档:唯一一行就是最后一行 ----------
  {
    await waitFor(`document.querySelector('.cm-line')`)
    await focusWindow()
    await sleep(300)
    const before = await spot()
    console.log(
      `    [diag] editor=${before.editorClass} count=${before.cursorCount} style=${before.cursorStyle} layer=${fmt(before.layer)}`
    )
    check('空文档:编辑器有焦点', before.active.includes('cm-content') || before.active.includes('cm-editor'), before.active)
    check('空文档:行首「+」已出现', !!before.plus)
    check('空文档:光标已画出', !!before.cursor, fmt(before.cursor))
    console.log(`    默认光标 ${fmt(before.cursor)};行 ${fmt(before.line)};+ ${fmt(before.plus)}`)

    const { content, line } = before
    if (!content || !line) {
      check('空文档:拿到几何', false)
    } else {
      // 点行下方 80px 的空白(仍在 .cm-content 的 40vh 底部 padding 里)
      const x = Math.round(line.left + 120)
      const y = Math.round(line.bottom + 80)
      check('空文档:落点在 .cm-content 内', y < content.bottom, `y=${y} content.bottom=${content.bottom}`)
      await clickAt(x, y)
      const after = await spot()
      console.log(`    点下方后光标 ${fmt(after.cursor)};+ ${fmt(after.plus)}`)
      const sameSize = near(before.cursor, after.cursor)
      check(
        '空文档:点末行下方空白后,光标高度/水平位置不变',
        sameSize,
        `before ${fmt(before.cursor)} / after ${fmt(after.cursor)}`
      )
      observedEmptyLine = true
    }
  }

  // ---------- 有正文、末尾是空行 ----------
  {
    await openNote(tailNote)
    await waitFor(`document.querySelectorAll('.cm-line').length >= 3`)
    await sleep(400)
    // 先点正文中间,让光标离开末行,再点末行行内
    const pre = await spot()
    const body = pre.lines[1]?.rect
    if (body) await clickAt(Math.round(body.left + 100), Math.round((body.top + body.bottom) / 2))
    const last = (await spot()).lines[pre.lines.length - 1]
    if (last?.rect) {
      await clickAt(Math.round(last.rect.left + 60), Math.round((last.rect.top + last.rect.bottom) / 2))
      const before = await spot()
      console.log(
        `    末行行内点击:光标 ${fmt(before.cursor)};末行 ${fmt(before.line)};+ ${fmt(before.plus)};focus=${before.active} editor=${before.editorClass}`
      )

      const content = before.content
      if (content && last.rect) {
        const x = Math.round(last.rect.left + 60)
        const y = Math.round(last.rect.bottom + 80)
        await clickAt(x, y)
        const after = await spot()
        console.log(`    末行下方点击:光标 ${fmt(after.cursor)};+ ${fmt(after.plus)}`)
        check(
          '末行空行:行内点击 vs 下方空白点击,光标矩形一致',
          near(before.cursor, after.cursor),
          `inline ${fmt(before.cursor)} / below ${fmt(after.cursor)}`
        )
      }
      observedTailBlank = true
    }
  }

  check('两条场景都执行到', observedEmptyLine && observedTailBlank)

  console.log(`\n[cursor] ${pass} 通过, ${fail} 失败`)
  win.destroy()
  app.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
