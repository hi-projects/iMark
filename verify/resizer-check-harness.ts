/**
 * 临时验证:左右两条分界线可拖动,宽度落盘。
 * 跑法:node verify/run.mjs resizer-check
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir')
    app.exit(2)
    return
  }
  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({ canceled: true, filePath: undefined })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '文档.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await writeFile(note, '# 标题\n\n正文内容\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify({ skipVaultPicker: true, vaultPath: vault, vaults: [vault], lastFile: note, marketUrl: '', autoSave: false }, null, 2),
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
  if (!win.isVisible()) win.show()
  win.focus()
  await sleep(400)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const ready = await evalJs<boolean>(
    `document.querySelectorAll('.pane-resizer').length === 2 && !!document.querySelector('.explorer') && !!document.querySelector('.outline-sidebar')`
  )
  check('两条分界线都已渲染', ready)
  if (!ready) {
    console.log(`resizer-check: ${pass} pass, ${fail} fail`)
    app.exit(1)
    return
  }

  const layout = (): Promise<{ explorer: number; outline: number; editor: number }> =>
    evalJs(`(() => {
      const r = s => document.querySelector(s).getBoundingClientRect()
      return { explorer: r('.explorer').width, outline: r('.outline-sidebar').width, editor: r('.editor-column').width }
    })()`)
  const center = (i: number): Promise<{ x: number; y: number }> =>
    evalJs(`(() => {
      const r = document.querySelectorAll('.pane-resizer')[${i}].getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)

  wc.debugger.attach('1.3')
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => wc.debugger.sendCommand(method, params)
  async function drag(from: { x: number; y: number }, toX: number): Promise<void> {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((toX - from.x) * i) / 6, y: from.y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: from.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(250)
  }

  const initial = await layout()
  console.log(`    [initial] ${JSON.stringify(initial)}`)

  await evalJs(`(() => {
    window.__log = []
    window.addEventListener('pointerdown', e => window.__log.push(['down', e.clientX, e.target.className, e.target.dataset && e.target.dataset.side]), true)
    window.addEventListener('pointermove', e => window.__log.push(['move', e.clientX, e.buttons, e.target.className]), true)
    window.addEventListener('pointerup', e => window.__log.push(['up', e.clientX, e.target.className]), true)
    return true
  })()`)

  const left = await center(0)
  console.log(`    [left center] ${JSON.stringify(left)} body=${await evalJs<number>(`document.querySelector('.app-body').clientWidth`)}`)
  await drag(left, left.x + 60)
  console.log(`    [left events] ${await evalJs<string>('JSON.stringify(window.__log)')}`)
  await evalJs(`(window.__log = [], true)`)
  const afterLeft = await layout()
  console.log(`    [after left] ${JSON.stringify(afterLeft)}`)
  check('左分界线右拖 60px:文件栏 300px', Math.abs(afterLeft.explorer - 300) < 2, String(afterLeft.explorer))
  check('左分界线拖动后正文区变窄', initial.editor - afterLeft.editor > 55, String(afterLeft.editor))

  const right = await center(1)
  console.log(`    [right center] ${JSON.stringify(right)}`)
  await drag(right, right.x - 40)
  console.log(`    [events] ${await evalJs<string>('JSON.stringify(window.__log)')}`)
  const afterRight = await layout()
  console.log(`    [after right] ${JSON.stringify(afterRight)}`)
  check('右分界线左拖 40px:大纲栏 280px', Math.abs(afterRight.outline - 280) < 2, String(afterRight.outline))
  check('右分界线拖动后正文区变窄', afterLeft.editor - afterRight.editor > 35, String(afterRight.editor))

  await sleep(500)
  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as { explorerWidth?: number; outlineWidth?: number }
  console.log(`    [saved] ${JSON.stringify(saved)}`)
  check('explorerWidth 已落盘', saved.explorerWidth === 300, String(saved.explorerWidth))
  check('outlineWidth 已落盘', saved.outlineWidth === 280, String(saved.outlineWidth))

  wc.debugger.detach()
  try {
    win.focus()
    await sleep(200)
    await writeFile(join(ud, 'resizer-check.png'), (await wc.capturePage()).toPNG())
    console.log(`    [shot] ${join(ud, 'resizer-check.png')}`)
  } catch (err) {
    console.log(`    [shot] 截图失败(忽略):${String(err)}`)
  }

  console.log(`resizer-check: ${pass} pass, ${fail} fail`)
  app.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
