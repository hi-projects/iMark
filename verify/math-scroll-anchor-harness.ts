/**
 * 长公式切态(渲染块 ↔ 源码)时,视口不能跳。
 *
 * 回归:渲染高度改成跟内容走之后,多行源码(很长)与单行渲染(很短)之间
 * 切态会改变整块高度。如果只恢复绝对 scrollTop,用户眼前的内容会整体
 * 上下搬家。这里断言:
 *   1. 点渲染块进源码态:公式首行仍停在点击前的位置(钉块首行);
 *   2. 点下方正文回渲染态:被点的那一行仍停在原来的位置(钉光标行)。
 *
 * 跑法(仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-scroll-anchor
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

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

/** 很长但渲染只有一行:行首 `+` 是续行,mathForKatex 不会断行 */
const BODY = [
  'x = a_0',
  ...Array.from({ length: 10 }, (_, i) => `+ a_{${i + 1}}`),
  '+ \\cdots'
]
const FORMULA = ['$$', ...BODY, '$$'].join('\n')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <name>` 跑会自动带上)')
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
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  // 公式前后都要有足够多的正文:否则折叠后没有内容可滚,锚点会因为
  // scrollTop 被夹到 0 而失败,那是测试场景的锅,不是实现的问题。
  const before = Array.from({ length: 40 }, (_, i) => `开头填充 ${i + 1}`).join('\n\n')
  const after = Array.from({ length: 40 }, (_, i) => `末尾填充 ${i + 1}`).join('\n\n')
  await writeFile(
    note,
    `${before}\n\n${FORMULA}\n\n末尾第一段\n\n末尾第二段\n\n${after}\n`,
    'utf8'
  )
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
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
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1600)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  if (!win.isVisible()) win.show()
  win.focus()
  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  await sleep(120)

  /* 光标在文首,公式在下方;先滚到公式渲染出来,再把它摆到视口上方 120px 处 */
  for (let i = 0; i < 60; i++) {
    const found = await evalJs<boolean>(`!!document.querySelector('.cm-md-math-display')`)
    if (found) break
    await evalJs(`(() => {
      const s = document.querySelector('.cm-scroller')
      s.scrollTop += Math.round(s.clientHeight * 0.8)
      return true
    })()`)
    await sleep(150)
  }
  await evalJs(`(() => {
    const box = document.querySelector('.cm-scroller').getBoundingClientRect()
    const line = [...document.querySelectorAll('.cm-content .cm-line')]
      .find(el => el.querySelector('.cm-md-math-display'))
    if (!line) return false
    const r = line.getBoundingClientRect()
    document.querySelector('.cm-scroller').scrollTop += r.top - (box.top + 120)
    return true
  })()`)
  await sleep(500)

  const mathPoint = await evalJs<{ x: number; y: number; top: number } | null>(`
    (() => {
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => el.querySelector('.cm-md-math-display'))
      if (!line) return null
      const r = line.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top }
    })()`)
  check('找到渲染中的公式块', mathPoint !== null, JSON.stringify(mathPoint))

  if (mathPoint) {
    wc.sendInputEvent({ type: 'mouseDown', x: mathPoint.x, y: mathPoint.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: mathPoint.x, y: mathPoint.y, button: 'left', clickCount: 1 })
    await sleep(900)

    const after = await evalJs<{ widgets: number; srcTop: number | null; scrollTop: number }>(`
      (() => {
        const first = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').trim() === '$$')
        return {
          widgets: document.querySelectorAll('.cm-md-math-display').length,
          srcTop: first ? first.getBoundingClientRect().top : null,
          scrollTop: document.querySelector('.cm-scroller').scrollTop
        }
      })()`)
    console.log(`\n【1】点公式进源码态:切态前 top=${mathPoint.top.toFixed(1)},切态后源码首行 top=${after.srcTop?.toFixed(1)}`)
    check('已经切到源码态', after.widgets === 0, JSON.stringify(after))
    check(
      '公式首行仍停在点击前的位置(±4px)',
      after.srcTop !== null && Math.abs(after.srcTop - mathPoint.top) <= 4,
      JSON.stringify({ before: mathPoint.top, after: after.srcTop })
    )
  }

  /* 往回切:先把「末尾第一段」滚到视口里,点它 —— 它不该动 */
  await evalJs(`(() => {
    const box = document.querySelector('.cm-scroller').getBoundingClientRect()
    const line = [...document.querySelectorAll('.cm-content .cm-line')]
      .find(el => (el.textContent || '').includes('末尾第一段'))
    if (!line) return false
    const r = line.getBoundingClientRect()
    document.querySelector('.cm-scroller').scrollTop += r.top - (box.top + 220)
    return true
  })()`)
  await sleep(500)

  const paragraphPoint = await evalJs<{ x: number; y: number; top: number } | null>(`
    (() => {
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => (el.textContent || '').includes('末尾第一段'))
      if (!line) return null
      const r = line.getBoundingClientRect()
      return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2), top: r.top }
    })()`)
  check('找到公式后面的正文行', paragraphPoint !== null, JSON.stringify(paragraphPoint))

  if (paragraphPoint) {
    wc.sendInputEvent({ type: 'mouseDown', x: paragraphPoint.x, y: paragraphPoint.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: paragraphPoint.x, y: paragraphPoint.y, button: 'left', clickCount: 1 })
    await sleep(900)

    const after2 = await evalJs<{ widgets: number; top: number | null }>(`
      (() => {
        const line = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').includes('末尾第一段'))
        return {
          widgets: document.querySelectorAll('.cm-md-math-display').length,
          top: line ? line.getBoundingClientRect().top : null
        }
      })()`)
    console.log(`\n【2】点正文回渲染态:切态前 top=${paragraphPoint.top.toFixed(1)},切态后 top=${after2.top?.toFixed(1)}`)
    check('公式恢复渲染态', after2.widgets === 1, JSON.stringify(after2))
    check(
      '被点的正文行仍停在原来的位置(±4px)',
      after2.top !== null && Math.abs(after2.top - paragraphPoint.top) <= 4,
      JSON.stringify({ before: paragraphPoint.top, after: after2.top })
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
