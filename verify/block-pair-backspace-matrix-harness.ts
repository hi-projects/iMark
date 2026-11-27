/**
 * 矩阵验收:九类正文块作为「上一块」,做同一套操作:
 *
 *   块 A 是文档最后的内容 → 在末尾空行回车 → 输入 `## 阿`(标题)或 `阿`(正文)
 *   → 光标回到新行行首 → 一次 Backspace 应该删掉上面的可见空段落。
 *
 * 也就是「表格后新段 → 标题 → 行首退格」那个问题在 A = 正文/标题/代码/列表/
 * 引用/图片/表格/公式/图表 时的通用性。
 *
 * 跑法:xvfb-run -a node verify/run.mjs block-pair-backspace-matrix
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

const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const BLOCKS: { kind: string; source: string }[] = [
  { kind: '正文', source: '正文\n' },
  { kind: '标题', source: '# 标题\n' },
  { kind: '代码', source: '```\nx\n```\n' },
  { kind: '列表', source: '- 项\n' },
  { kind: '引用', source: '> 引用\n' },
  { kind: '图片', source: `![图](${IMG})\n` },
  { kind: '表格', source: '| a | b |\n| --- | --- |\n| 1 | 2 |\n' },
  { kind: '公式', source: '$$\nx\n$$\n' },
  { kind: '图表', source: '```mermaid\nflowchart LR\nA-->B\n```\n' }
]

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
  win.setContentSize(1300, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1400)
  if (!win.isVisible()) win.show()
  win.focus()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(60)
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
      await sleep(35)
    }
    await sleep(300)
  }
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
  }

  interface Snap {
    emptyCount: number
    caretTop: number | null
    doc: string
  }
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const c = v.coordsAtPos(v.state.selection.main.head)
        return {
          emptyCount: document.querySelectorAll('.cm-content .cm-line.cm-md-empty-paragraph').length,
          caretTop: c ? Math.round(c.top * 10) / 10 : null,
          doc: v.state.doc.toString()
        }
      })()`)

  const lowerKinds: { label: string; text: string }[] = [
    { label: '标题', text: '## 阿' },
    { label: '正文', text: '阿' }
  ]

  for (const block of BLOCKS) {
    for (const lower of lowerKinds) {
      const tag = `${block.kind} → ${lower.label}`
      await loadDoc(block.source)
      // 光标放到文档最后那条空行(块的下面)
      await evalJs(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true })
        v.focus()
        return true
      })()`)
      await sleep(150)
      await key('Return')
      await type(lower.text)
      // 光标回到新行行首
      await evalJs(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const line = v.state.doc.lineAt(v.state.selection.main.head)
        v.dispatch({ selection: { anchor: line.from } })
        v.focus()
        return true
      })()`)
      await sleep(250)
      const before = await snap()
      await key('Backspace')
      const after = await snap()
      const movedUp =
        before.caretTop !== null && after.caretTop !== null && after.caretTop <= before.caretTop - 10
      console.log(
        `[${tag}] 空段落 ${before.emptyCount} → ${after.emptyCount}, 光标 top ` +
          `${before.caretTop} → ${after.caretTop}`
      )
      check(`${tag}:回车后有一条可见空段落`, before.emptyCount >= 1, JSON.stringify(before.emptyCount))
      check(`${tag}:一次 Backspace 后可见空段落消失`, after.emptyCount === 0, JSON.stringify(after.emptyCount))
      check(`${tag}:下面那行随之上移`, movedUp, JSON.stringify({ before: before.caretTop, after: after.caretTop }))
    }
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
