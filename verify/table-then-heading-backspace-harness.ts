/**
 * 复现:
 *   1. 空文档点第一行的「+」创建表格(表格是最后内容 → 自动补一段,光标在新段)
 *   2. 回车,再输入 `## 阿` 创建标题
 *   3. 光标移到标题行首,按一次 Backspace 应该删掉前面的空行
 *
 * 先打印每步源码与空段落记录,便于看结构。
 *
 * 跑法:xvfb-run -a node verify/run.mjs table-then-heading-backspace
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

interface State {
  doc: string
  head: number
  line: number
  text: string
  emptyParas: number[]
  emptyCount: number
  headingTop: number | null
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
  const state = (): Promise<State> =>
    evalJs<State>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const head = v.state.selection.main.head
        const line = v.state.doc.lineAt(head)
        const kept = []
        // 从编辑器模块拿不到 field 的值,这里用 DOM 里的空段落行近似记录位置
        const headingEl = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => el.classList.contains('cm-md-h2'))
        return {
          doc: v.state.doc.toString(),
          head,
          line: line.number,
          text: line.text,
          emptyParas: [...document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph')]
            .map(el => el.getBoundingClientRect().top),
          emptyCount: document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph').length,
          headingTop: headingEl ? Math.round(headingEl.getBoundingClientRect().top * 10) / 10 : null
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
      await sleep(40)
    }
    await sleep(400)
  }

  await focusEditor()
  const lines = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.cm-content .cm-line')].map(el => el.textContent)`)

  // 1) 点第一行的「+」→ 菜单「表格」→ 3 行 2 列 → 插入
  const plusOk = await evalJs<boolean>(`(() => !!document.querySelector('.line-plus'))()`)
  check('第一行出现「+」', plusOk)
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
  const afterTable = await state()
  console.log('\n【1】插入表格后 doc=', JSON.stringify(afterTable.doc), 'caretLine=', afterTable.line)
  console.log('     lines=', JSON.stringify(await lines()))

  // 2) 回车,输入 ## 阿
  await key('Return')
  const afterEnter = await state()
  console.log('【2】回车后 doc=', JSON.stringify(afterEnter.doc), 'caretLine=', afterEnter.line)
  console.log('     lines=', JSON.stringify(await lines()))
  await type('## 阿')
  const heading = await state()
  console.log('【3】输入 ## 阿 后 doc=', JSON.stringify(heading.doc), 'caretLine=', heading.line, 'text=', JSON.stringify(heading.text))
  console.log('     lines=', JSON.stringify(await lines()))

  // 3) 光标移到标题行首,按一次 Backspace
  const headingFrom = await evalJs<number>(`
    (() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const doc = v.state.doc.toString()
      const pos = doc.indexOf('## 阿')
      if (pos < 0) return -1
      const line = v.state.doc.lineAt(pos)
      v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      v.focus()
      return line.from
    })()`)
  await sleep(250)
  const beforeBackspace = await state()
  console.log('【4】光标到标题行首 head=', headingFrom, 'doc=', JSON.stringify(beforeBackspace.doc))

  await key('Backspace')
  const afterOne = await state()
  console.log('【5】一次 Backspace 后 doc=', JSON.stringify(afterOne.doc), 'caretLine=', afterOne.line, 'text=', JSON.stringify(afterOne.text))

  // 期望:一次退格后标题上方的空段落消失,标题上方不再有可见空行(源码里分隔空行可以保留)
  const beforeLines = beforeBackspace.doc.split('\n')
  const afterLines = afterOne.doc.split('\n')
  console.log('[before line count]', beforeLines.length, '[after]', afterLines.length)
  check(
    '一次 Backspace 后标题前不再有可见空行',
    afterOne.emptyCount === 0,
    JSON.stringify({ before: beforeBackspace.emptyCount, after: afterOne.emptyCount })
  )
  check(
    '标题随空段落一起向上移动(至少 10px)',
    beforeBackspace.headingTop !== null &&
      afterOne.headingTop !== null &&
      afterOne.headingTop <= beforeBackspace.headingTop - 10,
    JSON.stringify({ before: beforeBackspace.headingTop, after: afterOne.headingTop })
  )
  // 再按一次看是否会多删
  await key('Backspace')
  const afterTwo = await state()
  console.log('【6】第二次 Backspace 后 doc=', JSON.stringify(afterTwo.doc))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
