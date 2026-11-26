/**
 * 复现:标题回车后,在第二行输入 `$$`(还没补全的公式围栏),第二行会上移。
 *
 * 期望:敲 `$$` 的过程中这一行的位置不变(它还是一条正文行,等回车补全才变公式)。
 *
 * 跑法:xvfb-run -a node verify/run.mjs math-pending-shift
 */
import { app, dialog, protocol } from 'electron'
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
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

interface Snap {
  doc: string
  head: number
  caretLine: number
  caretTop: number | null
  lines: {
    text: string
    cls: string
    top: number
    h: number
    textTop: number | null
    padTop: string
    padBottom: string
  }[]
}

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
  const note = join(vault, '测试.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '', 'utf8')
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
        lineWrapping: false
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1300)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(30)
    }
    await sleep(350)
  }
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(400)
  }

  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const caret = v.coordsAtPos(head)
        return {
          doc: v.state.doc.toString(),
          head,
          caretLine: v.state.doc.lineAt(head).number,
          caretTop: caret ? Math.round(caret.top * 10) / 10 : null,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            let textTop = null
            const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
            for (let n = w.nextNode(); n; n = w.nextNode()) {
              if (!n.textContent.trim()) continue
              const rg = document.createRange(); rg.selectNodeContents(n)
              const rr = rg.getBoundingClientRect()
              textTop = textTop === null ? rr.top : Math.min(textTop, rr.top)
            }
            return {
              text: el.textContent,
              cls: el.className,
              top: Math.round(r.top * 10) / 10,
              h: Math.round(r.height * 10) / 10,
              textTop: textTop === null ? null : Math.round(textTop * 10) / 10,
              padTop: cs.paddingTop,
              padBottom: cs.paddingBottom
            }
          })
        }
      })()`)

  await focusEditor()
  await type('# 阿')
  const heading = await snap()
  console.log('\n【A】标题写好', JSON.stringify(heading.doc))
  await key('Return')
  const afterEnter = await snap()
  console.log('【B】回车后', JSON.stringify(afterEnter.doc), 'caretLine=', afterEnter.caretLine)
  console.log(JSON.stringify(afterEnter.lines, null, 2))

  await type('$$')
  const afterDollar = await snap()
  console.log('\n【C】输入 $$ 后', JSON.stringify(afterDollar.doc), 'caretLine=', afterDollar.caretLine)
  console.log(JSON.stringify(afterDollar.lines, null, 2))

  const secondAfter = afterDollar.lines[1]
  /*
   * 比较「内容起点」= 行顶 + padding-top。光标 / 文字矩形的顶部会差几像素
   * (空行没有字形盒、有字后有 ascent),不能直接拿来比。
   */
  const contentTop = (l: Snap['lines'][number]): number => l.top + parseFloat(l.padTop)
  const before = afterEnter.lines[1]
  check(
    '输入 `$$` 后这一行的内容起点没有上移(±1px)',
    !!before && !!secondAfter && Math.abs(contentTop(secondAfter) - contentTop(before)) <= 1,
    JSON.stringify({ before: before && contentTop(before), after: secondAfter && contentTop(secondAfter) })
  )
  check(
    '这一行仍带着标题下方的配对间距',
    !!secondAfter && /cm-md-heading-body/.test(secondAfter.cls) && secondAfter.padTop === '15px',
    JSON.stringify(secondAfter)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
