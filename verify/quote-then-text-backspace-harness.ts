/**
 * 复现(用户口述):
 *   1. 第一行输入 `> 阿`,创建引用;回车、回车、回车,创建非引用的第二行
 *   2. 第二行输入阿,光标回到第二行行首,一次 Backspace 应该把阿直接并回引用,
 *      实际第一下只往上挪了一点点,要按两次
 *
 * 期望:引用后面的正文 / 标题等文字块,行首退格一次就把文字源码并进引用。
 *
 * 跑法:xvfb-run -a node verify/run.mjs quote-then-text-backspace
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
  empty: number
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
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
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
        return {
          doc: v.state.doc.toString(),
          line: line.number,
          text: line.text,
          empty: document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph').length
        }
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
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
  }
  const dump = (s: Snap, title: string): void => {
    console.log(`[${title}] doc=${JSON.stringify(s.doc)} caretLine=${s.line} text=${JSON.stringify(s.text)} 可见空段落=${s.empty}`)
  }
  const setCaretSecondA = async (): Promise<void> => {
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const line = v.state.doc.lineAt(doc.lastIndexOf('阿'))
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
    await sleep(250)
  }

  // 1-2
  await focusEditor()
  await type('> 阿')
  dump(await snap(), '1a 输入 > 阿')
  await key('Return')
  await key('Return')
  await key('Return')
  dump(await snap(), '1b 三次回车')
  await type('阿')
  dump(await snap(), '2a 输入第二个阿')

  await setCaretSecondA()
  const before = await snap()
  dump(before, '2b 第二行行首')
  await key('Backspace')
  const after1 = await snap()
  dump(after1, '2c 一次退格')
  await key('Backspace')
  const after2 = await snap()
  dump(after2, '2d 两次退格')

  // 期望:一次退格就把第二个阿并进引用(源码里落进 > 的部分),不经过「先挪一点点」
  const joined = /^>\s*阿[^\n]*\n?阿\s*$/.test(after1.doc.trimEnd()) || /^>[^\n]*阿[^\n]*$/.test(after1.doc.trimEnd())
  check(
    '一次 Backspace 就把第二行的阿并进引用',
    joined && after1.empty === 0,
    JSON.stringify({ after1: after1.doc, after2: after2.doc })
  )

  // 3: 引用后的标题也算「文字类」—— 一次退格把标题文字并进引用,`##` 一起去掉
  await loadDoc('> 阿\n\n')
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true })
    v.focus()
    return true
  })()`)
  await sleep(200)
  await type('## 阿')
  dump(await snap(), '3a 引用后输入 ## 阿')
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    const doc = v.state.doc.toString()
    const line = v.state.doc.lineAt(doc.lastIndexOf('阿'))
    v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
    v.focus()
    return true
  })()`)
  await sleep(250)
  dump(await snap(), '3b 标题行首')
  await key('Backspace')
  const headAfter = await snap()
  dump(headAfter, '3c 一次退格')
  check(
    '引用后的标题,一次 Backspace 就把文字并进引用(去掉 ##)',
    headAfter.doc.trimEnd() === '> 阿阿',
    JSON.stringify(headAfter.doc)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
