/**
 * 复现:
 *   1. 第一行输入「阿」,回车
 *   2. 第二行回车,输入「阿」
 *   3. 回到第二行输入「阿」—— 第三行的「阿」往上移动
 *
 * 每步打印文档和各行位置,便于确认是哪一行的高度/间距变了。
 *
 * 跑法:xvfb-run -a node verify/run.mjs paragraph-type-shift
 */
import { app, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'
import { APP_VERSION } from './appVersion'

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
  lines: { text: string; cls: string; top: number; h: number; padTop: string }[]
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
  win.setContentSize(1200, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1300)
  if (!win.isVisible()) win.show()
  win.focus()

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
        return {
          doc: JSON.stringify(v.state.doc.toString()),
          head,
          caretLine: v.state.doc.lineAt(head).number,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            return {
              text: el.textContent,
              cls: el.className,
              top: Math.round(r.top * 10) / 10,
              h: Math.round(r.height * 10) / 10,
              padTop: getComputedStyle(el).paddingTop
            }
          })
        }
      })()`)
  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
    await sleep(150)
  }

  await focusEditor()
  await type('阿')
  console.log('\n【1】输入阿', JSON.stringify((await snap()).doc))
  await key('Return')
  const afterEnter1 = await snap()
  console.log('【2】回车', afterEnter1.doc, 'caretLine=', afterEnter1.caretLine)
  console.log(JSON.stringify(afterEnter1.lines, null, 2))

  await key('Return')
  const afterEnter2 = await snap()
  console.log('\n【3】第二行再回车', afterEnter2.doc, 'caretLine=', afterEnter2.caretLine)
  console.log(JSON.stringify(afterEnter2.lines, null, 2))

  await type('阿')
  const withSecond = await snap()
  console.log('\n【4】输入第二个阿', withSecond.doc, 'caretLine=', withSecond.caretLine)
  console.log(JSON.stringify(withSecond.lines, null, 2))

  // 回到**视觉上的第二行**(光标行下面那条空段落),输入阿
  const line2From = await evalJs<number>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const el = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(x => x.classList.contains('cm-md-empty-paragraph'))
      if (!el) return -1
      const r = el.getBoundingClientRect()
      return v.posAtCoords({ x: r.left + 4, y: Math.round(r.top + 6) }) ?? -1
    })()`)
  console.log('[line2From]', line2From)
  await setCaret(line2From)
  const beforeThirdType = await snap()
  console.log('\n【5】准备在第二行输入', beforeThirdType.doc, 'caretLine=', beforeThirdType.caretLine)
  console.log(JSON.stringify(beforeThirdType.lines, null, 2))

  await type('阿')
  const afterThirdType = await snap()
  console.log('\n【6】第二行输入阿之后', afterThirdType.doc, 'caretLine=', afterThirdType.caretLine)
  console.log(JSON.stringify(afterThirdType.lines, null, 2))

  // 比较「第三行的阿」在输入前后的屏幕位置
  const lineWithText = (s: Snap, needle: string, skip = 0): Snap['lines'][number] | undefined => {
    const matches = s.lines.filter(l => l.text.includes(needle))
    return matches[skip]
  }
  const thirdBefore = beforeThirdType.lines.filter(l => l.text.includes('阿')).at(-1)
  const thirdAfter = afterThirdType.lines.filter(l => l.text.includes('阿')).at(-1)
  check(
    '第三行的阿没有上移(±1px)',
    !!thirdBefore && !!thirdAfter && Math.abs(thirdAfter.top - thirdBefore.top) <= 1,
    JSON.stringify({ before: thirdBefore?.top, after: thirdAfter?.top })
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
