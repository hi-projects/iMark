/**
 * 复现:文档第一行是标题,光标停在标题行首按回车。
 *
 * 期望:标题向下让出一行(新段在它上面),光标仍停在标题行行首 —— 和普通
 * 编辑器在行首回车一致。当前实现会把光标放到新创建的第一行上。
 *
 * 跑法:xvfb-run -a node verify/run.mjs heading-enter-at-start
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
  await writeFile(note, '# 阿\n', 'utf8')
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
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(300)
  }

  const snap = (): Promise<{ doc: string; head: number; line: number; text: string }> =>
    evalJs<{ doc: string; head: number; line: number; text: string }>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const line = v.state.doc.lineAt(head)
        return { doc: v.state.doc.toString(), head, line: line.number, text: line.text }
      })()`)

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(150)
  }

  await focusEditor()
  await setCaret(0)
  console.log('\n【之前】', JSON.stringify(await snap()))
  await key('Return')
  const after = await snap()
  console.log('【行首回车之后】', JSON.stringify(after))

  const headingFrom = after.doc.indexOf('#')
  check('标题仍在(源码里有 # 阿)', headingFrom >= 0, JSON.stringify(after))
  check(
    '标题向下挪了一行(前面补了段落分隔)',
    after.doc.startsWith('\n\n# ') || after.doc.startsWith('\n# '),
    JSON.stringify(after.doc)
  )
  check(
    '光标停在标题行行首(仍贴着标题,不在新空行上)',
    after.head === headingFrom && after.text.startsWith('#'),
    JSON.stringify({ head: after.head, headingFrom, line: after.line, text: after.text })
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
