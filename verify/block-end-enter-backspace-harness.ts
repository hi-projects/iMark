/**
 * 复现:
 *   1. 第一行输入 `$$`,回车,创建公式块
 *   2. 光标移到第二个 `$$`(公式块末尾),回车,在新行输入阿
 *   3. 光标移到阿那一行行首,一次 Backspace 就应该把阿挪到 `$$` 后面
 *      (即阿行与 `$$` 之间不再留空行),实际要按两次
 *
 * 先打印每步源码与行结构。
 *
 * 跑法:xvfb-run -a node verify/run.mjs block-end-enter-backspace
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
  line: number
  text: string
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
        return { doc: v.state.doc.toString(), head, line: line.number, text: line.text }
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
  const dump = (s: Snap, title: string): void => {
    console.log(`[${title}] doc=${JSON.stringify(s.doc)} caretLine=${s.line} text=${JSON.stringify(s.text)}`)
  }

  await focusEditor()
  await type('$$')
  dump(await snap(), '1 输入 $$')
  await key('Return')
  dump(await snap(), '2 回车补全公式块')

  // 光标移到第二个 $$(末尾那条)的行尾
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    const doc = v.state.doc.toString()
    const second = doc.lastIndexOf('$$')
    const line = v.state.doc.lineAt(second)
    v.dispatch({ selection: { anchor: line.to }, scrollIntoView: true })
    v.focus()
    return true
  })()`)
  await sleep(200)
  dump(await snap(), '3 光标到末尾 $$ 行尾')

  await key('Return')
  dump(await snap(), '4 末尾回车')
  await type('阿')
  dump(await snap(), '5 输入阿')

  // 光标到阿行行首,连续两次退格
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    const line = v.state.doc.lineAt(v.state.selection.main.head)
    v.dispatch({ selection: { anchor: line.from } })
    v.focus()
    return true
  })()`)
  await sleep(200)
  const before = await snap()
  dump(before, '6 光标到阿行行首')

  await key('Backspace')
  const after1 = await snap()
  dump(after1, '7 一次退格')
  await key('Backspace')
  const after2 = await snap()
  dump(after2, '8 两次退格')

  // 期望:一次退格后阿直接贴在末尾 $$ 的下一行("$$\n阿" 或 "$$阿"?)
  const onePressOk = /(\$\$)\n阿/.test(after1.doc) && !/\$\$\n\n+阿/.test(after1.doc)
  check(
    '一次 Backspace 后阿直接接在公式块后面(中间不再空行)',
    onePressOk,
    JSON.stringify({ after1: after1.doc, after2: after2.doc })
  )
  // 再按一次不能把「阿」并进围栏行 —— 那会把公式块写坏(以前整篇文档被清空)
  check(
    '再按一次 Backspace 不会把文字塞进公式围栏、也不会清空文档',
    after2.doc === after1.doc && after2.doc.includes('阿') && after2.doc.includes('$$'),
    JSON.stringify(after2.doc)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
