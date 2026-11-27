/**
 * 复现:
 *   1. 第一行输入阿,回车
 *   2. 第二行点加号创建表格(表格后面没内容 → 自动补一行,光标在新行)
 *   3. 在新行输入阿
 *   4. 点表格的删除按钮删掉表格
 *   5. 光标移到第一行 —— 第二行(空行)消失,只剩两个阿
 *
 * 期望:删表后原表格位置留下一条可编辑的空行,两个阿仍是两段。
 *
 * 跑法:xvfb-run -a node verify/run.mjs table-delete-empty-line
 */
import { app, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { IPC } from '../src/shared/ipc-channels'
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
  lines: { text: string; cls: string; top: number; h: number }[]
  emptyCount: number
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
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1200, 900)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1600)
  await service.startup()
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const line = v.state.doc.lineAt(head)
        const lines = [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
          const r = el.getBoundingClientRect()
          return { text: el.textContent, cls: el.className, top: Math.round(r.top), h: Math.round(r.height) }
        })
        return {
          doc: v.state.doc.toString(),
          head,
          line: line.number,
          text: line.text,
          lines,
          emptyCount: document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph').length
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
    await sleep(350)
  }
  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(40)
    }
    await sleep(350)
  }

  await focusEditor()
  await type('阿')
  await key('Return')

  // 第二行点加号建表(3 行 2 列)
  await evalJs(`(() => { document.querySelector('.line-plus')?.click(); return true })()`)
  await sleep(300)
  await evalJs(`(() => {
    const el = [...document.querySelectorAll('.line-menu-item')].find(x => x.textContent.trim() === '表格')
    el?.click(); return true
  })()`)
  await sleep(300)
  await evalJs(`(() => {
    const ins = [...document.querySelectorAll('.line-dialog input[type=number]')]
    const put = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })) }
    put(ins[0], 3); put(ins[1], 2); return true
  })()`)
  await evalJs(`(() => { document.querySelector('.line-dialog-primary')?.click(); return true })()`)
  await sleep(1200)

  // 光标在表格后面的新行上,输入第三个阿
  await type('阿')
  const beforeDelete = await snap()
  console.log('\n【1】删表前 doc=', JSON.stringify(beforeDelete.doc))
  console.log('     caretLine=', beforeDelete.line, 'text=', JSON.stringify(beforeDelete.text))

  // 点删除整表按钮
  const clicked = await evalJs<boolean>(`(() => {
    const btn = document.querySelector('[data-act="delete-table"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  check('找到并点击了删除整表按钮', clicked)
  await sleep(800)
  const afterDelete = await snap()
  console.log('【2】删表后 doc=', JSON.stringify(afterDelete.doc))
  console.log('     caretLine=', afterDelete.line, 'text=', JSON.stringify(afterDelete.text), 'emptyCount=', afterDelete.emptyCount)
  console.log('     lines=', JSON.stringify(afterDelete.lines))

  // 光标移到第一行
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
    v.focus()
    return true
  })()`)
  await sleep(600)
  const afterMove = await snap()
  console.log('【3】光标到第一行后 doc=', JSON.stringify(afterMove.doc))
  console.log('     lines=', JSON.stringify(afterMove.lines), 'emptyCount=', afterMove.emptyCount)

  const atexts = afterMove.lines.filter(l => l.text.includes('阿'))
  check('删表后仍是两条「阿」', atexts.length === 2, JSON.stringify(afterMove.lines))
  check(
    '两条「阿」之间还有一条可编辑的空行',
    afterMove.emptyCount >= 1,
    JSON.stringify({ emptyCount: afterMove.emptyCount, lines: afterMove.lines })
  )
  check(
    '源码里两个阿之间留着分段的空行',
    /阿\n\n+阿/.test(afterMove.doc),
    JSON.stringify(afterMove.doc)
  )

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
