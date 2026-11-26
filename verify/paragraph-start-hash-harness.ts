/**
 * 复现:Flow Matching 文档里「1、**CNF（连续归一化流…」行首回车,在新行输入
 * `#` —— 该行及后面内容整体往下移动。
 *
 * 跑法:xvfb-run -a node verify/run.mjs paragraph-start-hash
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
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        return {
          doc: v.state.doc.toString(),
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
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(40)
    }
    await sleep(400)
  }

  await focusEditor()
  const ok = await evalJs<boolean>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const pos = doc.indexOf('CNF（连续归一化流')
      if (pos < 0) return false
      const line = v.state.doc.lineAt(pos)
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      v.focus()
      return true
    })()`)
  if (!ok) {
    console.log('找不到目标行')
    app.exit(1)
    return
  }
  await sleep(250)

  await key('Return')
  const afterEnter = await snap()
  {
    const idx = afterEnter.lines.findIndex(l => l.text.includes('CNF（连续归一化流'))
    console.log('[after enter around CNF]', JSON.stringify(afterEnter.lines.slice(Math.max(0, idx - 4), idx + 3), null, 2))
    console.log('[after enter caret]', 'line=', afterEnter.caretLine, 'head=', afterEnter.head,
      'text=', JSON.stringify(afterEnter.lines[afterEnter.caretLine - 1] ?? null))
  }
  // 用户说的「新行」:回车后光标行上方那条空段落。把光标挪到它上面再输入 #
  const moved = await evalJs<unknown>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const head = v.state.selection.main.head
      const caret = v.state.doc.lineAt(head)
      const above = v.state.doc.line(caret.number - 1)
      v.dispatch({ selection: { anchor: above.from }, scrollIntoView: true })
      v.focus()
      const now = v.state.doc.lineAt(v.state.selection.main.head)
      return { movedToLine: now.number, text: now.text }
    })()`)
  console.log('[move to new line]', JSON.stringify(moved))
  await sleep(250)
  const newLineTop = await evalJs<number | null>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const caret = v.coordsAtPos(v.state.selection.main.head)
      if (!caret) return null
      const el = [...document.querySelectorAll('.cm-content .cm-line')].find(x => {
        const r = x.getBoundingClientRect()
        return x.classList.contains('cm-md-empty-paragraph') &&
          caret.top >= r.top - 2 && caret.top <= r.bottom + 2
      })
      return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null
    })()`)
  console.log('[new line top]', newLineTop)
  const entered = await snap()
  console.log('\n【A】行首回车之后', JSON.stringify(entered.doc.slice(0, 0)))
  console.log(JSON.stringify(entered.lines.map(l => [l.text.slice(0, 12), l.top, l.h, l.padTop, l.cls]).slice(0, 8), null, 2))

  await type('#')
  const hashed = await snap()
  const srcAround = await evalJs<unknown>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const head = v.state.selection.main.head
      const caret = v.state.doc.lineAt(head)
      const out = []
      for (let n = Math.max(1, caret.number - 3); n <= Math.min(v.state.doc.lines, caret.number + 3); n++) {
        out.push([n, v.state.doc.line(n).text.slice(0, 30)])
      }
      return { caretLine: caret.number, head, lines: out }
    })()`)
  console.log('[source around caret]', JSON.stringify(srcAround))
  {
    const idx = hashed.lines.findIndex(l => l.text.includes('CNF（连续归一化流'))
    console.log('[after # around CNF]', JSON.stringify(hashed.lines.slice(Math.max(0, idx - 4), idx + 3), null, 2))
    console.log('[after # caret]', 'line=', hashed.caretLine, 'head=', hashed.head,
      'text=', JSON.stringify(hashed.lines[hashed.caretLine - 1] ?? null))
  }
  console.log('\n【B】输入 # 之后')
  console.log(JSON.stringify(hashed.lines.map(l => [l.text.slice(0, 12), l.top, l.h, l.padTop, l.cls]).slice(0, 8), null, 2))

  const lineOf = (s: Snap, needle: string): Snap['lines'][number] | undefined =>
    s.lines.find(l => l.text.includes(needle))
  const hashBefore = lineOf(entered, '#')
  const hashAfter = lineOf(hashed, '#')
  const cnfBefore = entered.lines.find(l => l.text.includes('CNF（连续归一化流'))
  const cnfAfter = hashed.lines.find(l => l.text.includes('CNF（连续归一化流'))

  console.log('[deltas]', JSON.stringify({
    hash: { before: hashBefore?.top, after: hashAfter?.top, hb: hashBefore?.h, ha: hashAfter?.h },
    cnf: { before: cnfBefore?.top, after: cnfAfter?.top }
  }))

  check(
    '输入 # 后,新行没有下移(±1px)',
    newLineTop !== null && !!hashAfter && Math.abs(hashAfter.top - newLineTop) <= 1,
    JSON.stringify({ before: newLineTop, after: hashAfter?.top })
  )
  check(
    '输入 # 后,CNF 行没有下移(±1px)',
    !!cnfBefore && !!cnfAfter && Math.abs(cnfAfter.top - cnfBefore.top) <= 1,
    JSON.stringify({ before: cnfBefore?.top, after: cnfAfter?.top })
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
