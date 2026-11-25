/**
 * 验收:在公式 / 图表的**源码态**里按住左键拖选,选区要跟着鼠标走,
 * 不能一动就切回渲染态、整块全选(全选 / 全不选来回闪)。
 *
 * 复现:公式 / Mermaid 源码里按住左键拖动 → 选区无法落在起始位置到
 * 鼠标当前位置,而是变成整块选中 / 恢复渲染。
 *
 * 断言:
 *   A 公式源码里拖选:全程保持源码态,锚点不动,选区头随鼠标变化;
 *   B Mermaid 源码里拖选:同样保持源码态,选区头随鼠标变化。
 *
 * 跑法(先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs source-drag
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const DOC = [
  '上方正文。',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '$$',
  'a = b',
  'c = d',
  '$$',
  '',
  '下方正文。',
  ''
].join('\n')

const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

async function main(): Promise<void> {
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'a.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, DOC, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify({
      skipVaultPicker: true,
      vaultPath: vault,
      vaults: [vault],
      lastFile: note,
      theme: 'dark',
      editorFontSize: 15,
      editorFontSizeVersion: 2
    }),
    'utf8'
  )
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1000, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1400)
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  wc.debugger.attach('1.3')
  const types: Record<string, string> = {
    down: 'mousePressed',
    move: 'mouseMoved',
    up: 'mouseReleased'
  }
  const mouse = async (type: string, x: number, y: number, buttons: number): Promise<void> => {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: types[type],
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1
    })
  }

  const selection = (): Promise<{ from: number; to: number; anchor: number; head: number }> =>
    evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const r = view.state.selection.main
        return { from: r.from, to: r.to, anchor: r.anchor, head: r.head }
      })()`)

  async function dragInSource(
    label: string,
    setCaretExpr: string,
    sourceSelector: string,
    contentText: string,
    widgetSelector: string
  ): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      ${setCaretExpr}
      view.focus()
      return true
    })()`)
    const ready = await (async (): Promise<boolean> => {
      for (let i = 0; i < 80; i++) {
        const ok = await evalJs<boolean>(
          `document.querySelectorAll(${JSON.stringify(sourceSelector)}).length > 0`
        )
        if (ok) return true
        await sleep(60)
      }
      return false
    })()
    check(`${label}:进入源码态`, ready)
    if (!ready) return

    const points = await evalJs<{ sx: number; sy: number; ex: number; ey: number } | null>(`
      (() => {
        const lines = [...document.querySelectorAll(${JSON.stringify(sourceSelector)})]
          .filter(el => (el.textContent || '').includes(${JSON.stringify(contentText)}))
        if (lines.length === 0) return null
        const line = lines[0]
        const next = lines[1] ?? line
        const a = line.getBoundingClientRect()
        const b = next.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(line)
        const t = range.getBoundingClientRect()
        return {
          sx: Math.round(t.left + 1),
          sy: Math.round(a.top + a.height / 2),
          ex: Math.round(t.left + 40),
          ey: Math.round(b.top + b.height / 2)
        }
      })()`)
    check(`${label}:找得到拖选起止点`, !!points, JSON.stringify(points))
    if (!points) return

    await mouse('down', points.sx, points.sy, 1)
    await sleep(80)
    const anchors: number[] = []
    const heads: number[] = []
    let stayedSource = true
    for (let step = 1; step <= 8; step++) {
      const x = Math.round(points.sx + ((points.ex - points.sx) * step) / 8)
      const y = Math.round(points.sy + ((points.ey - points.sy) * step) / 8)
      await mouse('move', x, y, 1)
      await sleep(70)
      const sel = await selection()
      anchors.push(sel.anchor)
      heads.push(sel.head)
      const widget = await evalJs<boolean>(
        `!!document.querySelector(${JSON.stringify(widgetSelector)})`
      )
      if (widget) stayedSource = false
    }
    await mouse('up', points.ex, points.ey, 0)
    await sleep(200)
    console.log(
      `     [${label}] anchors=${JSON.stringify(anchors)} heads=${JSON.stringify(heads)}` +
        ` source=${stayedSource}`
    )
    check(`${label}:拖选全程保持源码态`, stayedSource)
    check(
      `${label}:锚点固定不动`,
      anchors.length > 0 && anchors.every(value => value === anchors[0]),
      JSON.stringify(anchors)
    )
    check(
      `${label}:选区头随鼠标变化(至少 3 个不同位置)`,
      new Set(heads).size >= 3,
      JSON.stringify(heads)
    )
  }

  console.log('\n【A】公式源码里拖选')
  await dragInSource(
    '公式',
    `const at = view.state.doc.toString().indexOf('a = b'); view.dispatch({ selection: { anchor: at + 1 } })`,
    '.cm-md-math-src-line',
    'a = b',
    '.cm-md-math-display'
  )

  console.log('\n【B】Mermaid 源码里拖选')
  await dragInSource(
    '图表',
    `const at = view.state.doc.toString().indexOf('graph TD'); view.dispatch({ selection: { anchor: at + 1 } })`,
    '.cm-line.cm-md-code',
    'graph TD',
    '.cm-md-mermaid'
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
