/**
 * 复现(用户口述):
 *   1. 第一行输入阿,回车
 *   2. 第二行回车
 *   3. 第三行输入阿
 *   4. 光标到第三行首,Backspace → 第三行移到第二行;再按 → 只剩一行「阿阿」
 *   5. 光标到第二个阿前面,回车,再回车
 *   6. 光标到第三行首,这次要按两次 Backspace 才能删掉第二行空行
 *
 * 打印每一步的源码与行结构,看第 6 步第一次退格到底删了什么。
 *
 * 跑法:xvfb-run -a node verify/run.mjs seam-double-enter-backspace
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
  line: number
  text: string
  lines: string[]
  empty: number[]
  cls: string[]
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
  win.setContentSize(1200, 900)
  const wc = win.webContents
  await new Promise<void>((resolve) => { wc.once('did-finish-load', () => resolve()) })
  await sleep(1400)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const line = v.state.doc.lineAt(head)
        const lines = []
        for (let n = 1; n <= v.state.doc.lines; n++) lines.push(v.state.doc.line(n).text)
        const empty = [...document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph')]
          .map(el => el.textContent)
        const cls = [...document.querySelectorAll('.cm-content .cm-line')]
          .map(el => el.textContent.slice(0, 6) + ' [' + [...el.classList].filter(c => c.startsWith('cm-md')).join(' ') + ']')
        return { doc: v.state.doc.toString(), line: line.number, text: line.text, lines, empty, cls }
      })()`)

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(400)
  }
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(45)
    }
    await sleep(400)
  }
  const setCaretLineStart = async (lineNo: number): Promise<void> => {
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const line = v.state.doc.line(${lineNo})
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
    await sleep(250)
  }
  const setCaretOffset = async (offset: number): Promise<void> => {
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ selection: { anchor: ${offset} }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
    await sleep(250)
  }
  const dump = (s: Snap, title: string): void => {
    console.log(
      `[${title}] doc=${JSON.stringify(s.doc)} caretLine=${s.line} text=${JSON.stringify(s.text)}\n` +
        `          lines=${JSON.stringify(s.lines)} 可见空段落=${s.empty.length}\n          cls=${JSON.stringify(s.cls)}`
    )
  }

  // 1-3
  await focusEditor()
  await type('阿')
  await key('Return')
  await key('Return')
  await type('阿')
  dump(await snap(), '1-3 阿/回车/回车/阿')

  // 4: 「第三行首」= 第二个阿那一行的行首(视觉行号,源码里中间夹着零高的分隔空行)
  const secondALine = async (): Promise<number> =>
    evalJs<number>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      return v.state.doc.lineAt(doc.lastIndexOf('阿')).number
    })()`)
  await setCaretLineStart(await secondALine())
  await key('Backspace')
  dump(await snap(), '4a 第二阿行首一次退格')
  await key('Backspace')
  dump(await snap(), '4b 第二阿行首两次退格')
  check('4: 第二次退格后只剩一行「阿阿」', (await snap()).doc.replace(/\n+$/, '') === '阿阿')

  // 5: 光标到第二个阿前面,回车两次(用户说法),每按一次 Backspace 收掉一条
  //    看得见的空段落 —— 不能出现「按了没反应」的一下
  const seam = (await snap()).doc.indexOf('阿', 1)
  await setCaretOffset(seam)
  await key('Return')
  dump(await snap(), '5a 接缝处一次回车')
  await key('Return')
  dump(await snap(), '5b 接缝处两次回车')
  await setCaretLineStart(await secondALine())
  const twoEnters = await snap()
  dump(twoEnters, '5c 两次回车后,第二阿行首')
  await key('Backspace')
  const twoA = await snap()
  dump(twoA, '5d 一次退格')
  await key('Backspace')
  const twoB = await snap()
  dump(twoB, '5e 两次退格')

  check(
    '5: 每一次 Backspace 都收掉一条可见空段落',
    twoA.empty.length === twoEnters.empty.length - 1 && twoA.doc !== twoEnters.doc,
    JSON.stringify({ before: twoEnters.empty.length, after1: twoA.empty.length, doc1: twoA.doc })
  )
  check(
    '5: 按够次数后空段落全收掉,两个阿回到一行',
    twoB.empty.length === 0 && twoB.doc.replace(/\n+$/, '') === '阿阿',
    JSON.stringify(twoB.doc)
  )

  // 6: 同样的「接缝处回车」只按一次(用户看到的第三行状态):一次 Backspace
  //    就该把那条空行收掉,而不是按两次
  await setCaretOffset((await snap()).doc.indexOf('阿', 1))
  await key('Return')
  const oneEnter = await snap()
  dump(oneEnter, '6b 接缝处一次回车')
  await setCaretLineStart(await secondALine())
  await key('Backspace')
  const oneBack = await snap()
  dump(oneBack, '6c 一次退格')
  // 这一次回车出的空行可能是可见空段落,也可能只是零高的结构空行;两种都
  // 只该按一次 Backspace 就收掉,不能有「按了没反应」的一下
  check(
    '6: 一次回车出来的那条空行,一次 Backspace 就删掉',
    oneBack.doc !== oneEnter.doc &&
      oneBack.empty.length === 0 &&
      /^阿\n?阿$/.test(oneBack.doc.replace(/\n+$/, '')),
    JSON.stringify({ entered: oneEnter.doc, enteredEmpty: oneEnter.empty.length, back: oneBack.doc })
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
