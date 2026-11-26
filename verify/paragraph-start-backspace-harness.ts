/**
 * 复现:Flow Matching 文档里「1、**CNF（连续归一化流…」这一行,在行首回车
 * 多出一行;对新多出的行按一次 Backspace 就应该没了,实际要按两次。
 *
 * 做法:加载文档快照,把光标放到 CNF 行行首 → 回车 → 只按一次 Backspace,
 * 断言源码回到回车前的样子、光标仍在 CNF 行行首。
 *
 * 跑法:xvfb-run -a node verify/run.mjs paragraph-start-backspace
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

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

interface State {
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
  win.setContentSize(1400, 1000)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1600)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const state = (): Promise<State> =>
    evalJs<State>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const line = v.state.doc.lineAt(head)
        return {
          doc: v.state.doc.toString(),
          head,
          line: line.number,
          text: line.text
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
    await sleep(450)
  }

  await focusEditor()
  const target = await evalJs<{ from: number; number: number; text: string } | null>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const pos = doc.indexOf('CNF（连续归一化流')
      if (pos < 0) return null
      const line = v.state.doc.lineAt(pos)
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      v.focus()
      return { from: line.from, number: line.number, text: line.text }
    })()`)
  console.log('[target]', JSON.stringify(target))
  if (!target) {
    app.exit(1)
    return
  }
  await sleep(250)
  const original = await state()
  console.log('[before] line=', original.line, 'text=', JSON.stringify(original.text))

  await key('Return')
  const entered = await state()
  console.log('[after Enter] line=', entered.line, 'head=', entered.head, 'delta=', entered.doc.length - original.doc.length)
  check(
    '行首回车插入了段落分隔(源码变长)',
    entered.doc.length > original.doc.length,
    JSON.stringify({ before: original.doc.length, after: entered.doc.length })
  )

  await key('Backspace')
  const restored = await state()
  console.log('[after 1x Backspace] line=', restored.line, 'head=', restored.head)
  check(
    '一次 Backspace 就回到回车前的源码',
    restored.doc === original.doc,
    JSON.stringify({
      same: restored.doc === original.doc,
      entered: JSON.stringify(entered.text),
      restored: JSON.stringify(restored.text)
    })
  )
  check(
    '光标仍在 CNF 行行首',
    restored.text.startsWith('1、') && restored.text.includes('CNF'),
    JSON.stringify({ line: restored.line, text: restored.text.slice(0, 40) })
  )
  check(
    '没有多出空行',
    restored.doc.split('\n').length === original.doc.split('\n').length,
    JSON.stringify({ before: original.doc.split('\n').length, after: restored.doc.split('\n').length })
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
