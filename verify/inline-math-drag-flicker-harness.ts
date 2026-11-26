/**
 * 复现:在某行内公式左边按下左键,往右拖选整个 `$...$`,拖动过程中行内公式
 * 在「源码 / 渲染」之间反复闪烁。
 *
 * 做法:加载文档快照,滚到「解析式 $p_0(x)$」那一行;在公式左侧按下鼠标,
 * 分多步往右拖,每步采样这一行是渲染态还是源码态,统计切换次数。
 *
 * 跑法:xvfb-run -a node verify/run.mjs inline-math-drag-flicker
 */
import { app, dialog, protocol } from 'electron'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const SRC = '/tmp/fm-fixture.md'

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
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
  const note = join(vault, 'Flow Matching.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await copyFile(SRC, note)
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false,
        theme: 'dark',
        editorFontSize: 15,
        editorFontSizeVersion: 2
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1500, 1000)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1800)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  // 滚到「解析式」那一行
  await evalJs(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const pos = v.state.doc.toString().indexOf('解析式')
      if (pos < 0) return false
      const block = v.lineBlockAt(v.state.doc.lineAt(pos).from)
      document.querySelector('.cm-scroller').scrollTop = Math.max(0, block.top - 120)
      return true
    })()`)
  await sleep(500)

  interface Pt {
    startX: number
    endX: number
    y: number
    posFrom: number
    posTo: number
    hit: number | null
  }
  const target = await evalJs<Pt | null>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const anchor = doc.indexOf('解析式 $p_0(x)$')
      if (anchor < 0) return null
      const posFrom = anchor + '解析式 '.length
      const posTo = posFrom + '$p_0(x)$'.length - 1
      const a = v.coordsAtPos(posFrom)
      const b = v.coordsAtPos(posTo)
      if (!a || !b) return null
      const y = Math.round((a.top + a.bottom) / 2)
      const startX = Math.round(a.left + 2)
      const hit = v.posAtCoords({ x: startX, y })
      return {
        startX,
        endX: Math.round(b.right + 12),
        y,
        posFrom,
        posTo,
        hit
      }
    })()`)
  console.log('[target]', JSON.stringify(target))
  if (!target) {
    app.exit(1)
    return
  }

  const measure = (): Promise<unknown> =>
    evalJs(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const line = lines.find(el => (el.textContent || '').includes('解析式'))
        const sel = v.state.selection.main
        const dbg = window.__imarkSnapDebug
        return {
          rendered: line ? line.querySelectorAll('.cm-md-math-inline').length : -1,
          srcText: line ? (line.textContent || '').includes('$p_0') : null,
          selFrom: sel.from,
          selTo: sel.to,
          snap: dbg
            ? {
                sched: dbg.scheduled,
                result: dbg.result,
                pointerDown: dbg.pointerDown,
                pointerSelection: dbg.pointerSelection,
                selection: dbg.selection,
                attempt: dbg.attempt
              }
            : null
        }
      })()`)

  wc.debugger.attach('1.3')
  const cdp = (method: string, params?: unknown): Promise<unknown> =>
    wc.debugger.sendCommand(method, params)
  const mouse = async (
    type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
    x: number,
    y: number,
    buttons: number
  ): Promise<void> => {
    await cdp('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1
    })
  }

  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  await sleep(200)
  console.log('[before]', JSON.stringify(await measure()))

  const startX = target.startX
  await mouse('mousePressed', startX, target.y, 1)
  await sleep(120)
  const states: unknown[] = [{ at: 'down', ...(await measure() as Record<string, unknown>) }]

  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(startX + ((target.endX - startX) * i) / steps)
    await mouse('mouseMoved', x, target.y, 1)
    await sleep(80)
    states.push({ at: x, ...(await measure() as Record<string, unknown>) })
  }
  await mouse('mouseReleased', target.endX, target.y, 0)
  await sleep(200)
  states.push({ at: 'up', ...(await measure() as Record<string, unknown>) })

  for (const s of states) console.log(JSON.stringify(s))

  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
    else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
  }

  const dragStates = states.filter(s => (s as { at: unknown }).at !== 'down') as {
    srcText: boolean
    rendered: number
    selFrom: number
    selTo: number
  }[]
  check(
    '按下后公式进入源码态',
    (states[0] as { srcText: boolean }).srcText === true,
    JSON.stringify(states[0])
  )
  check(
    '拖动全程公式保持源码态(不再渲染/源码来回闪)',
    dragStates.length > 0 && dragStates.every(s => s.srcText === true),
    JSON.stringify(dragStates.map(s => s.srcText))
  )
  const final = dragStates[dragStates.length - 1]
  check(
    '最终选区覆盖整个 $p_0(x)$',
    !!final && final.selFrom === target.posFrom && final.selTo === target.posFrom + 8,
    JSON.stringify(final)
  )
  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
