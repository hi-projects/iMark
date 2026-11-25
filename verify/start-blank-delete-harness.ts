/**
 * 复现:空文档回车 → 输入「# 阿」后,文档开头多出的空行要按两次 Delete / Backspace
 * 才能删掉。
 *
 * 步骤(二选一):
 *   A 光标在第一行,按 Delete
 *   B 光标在标题行首,按 Backspace
 *
 * 期望:一次按键就把开头那条空行删掉,标题成为第一行。
 *
 * 跑法:xvfb-run -a node verify/run.mjs start-blank-delete
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
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(250)
  }
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(30)
    }
    await sleep(300)
  }
  const docText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)
  const caretHead = (): Promise<number> =>
    evalJs<number>(`document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head`)
  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(150)
  }
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
    await focusEditor()
  }

  /** 用户的步骤:空文档 → 回车 → 输入「# 阿」 */
  async function seed(): Promise<string> {
    await loadDoc('')
    await key('Return')
    await type('# 阿')
    return docText()
  }

  console.log('\n【0】种子文档')
  const base = await seed()
  console.log(`     doc = ${JSON.stringify(base)}`)

  console.log('\n【A】光标在文档第一行,按 Delete')
  let src = await seed()
  await setCaret(0)
  await key('Delete')
  const afterDelete1 = await docText()
  console.log(`     一次 Delete 后 = ${JSON.stringify(afterDelete1)}(head=${await caretHead()})`)
  check(
    '一次 Delete 就删掉开头空行',
    afterDelete1 === '# 阿',
    JSON.stringify(afterDelete1)
  )

  console.log('\n【B】光标在标题行首,按 Backspace')
  src = await seed()
  await setCaret(src.indexOf('#'))
  await key('Backspace')
  const afterBackspace1 = await docText()
  console.log(`     一次 Backspace 后 = ${JSON.stringify(afterBackspace1)}(head=${await caretHead()})`)
  check(
    '一次 Backspace 就删掉开头空行',
    afterBackspace1 === '# 阿',
    JSON.stringify(afterBackspace1)
  )
  check('光标落在标题行首', (await caretHead()) === 0, String(await caretHead()))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
