/**
 * 验收:打开文件时的初始光标不落在被收紧的结构空行上。
 *
 * 用户报告:文件开头不是正文,而是代码块 / 公式块(前面还留着一条空行)时,
 * 打开后光标停在开头那条空行上;这条空行平时只占一档间距,光标一落上去就
 * 撑成整行,第一次点击别处又缩回去 —— 看着像凭空多出一行,文章整体往上挪。
 *
 * 验收(实现见 src/renderer/src/editor/setup.ts 的 initialCaret):
 *  · 打开开头连着空行的文件,初始光标落在第一条有内容的行上;
 *  · 那条空行保持收紧后的高度,光标挪到正文时行高、正文顶边都不变;
 *  · 开头没有空行的普通文件、空文档,光标仍在开头(原来就停得住)。
 *
 * 跑法(仓库根目录,改过渲染层先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs open-caret
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

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface LineInfo {
  text: string
  cls: string
  height: number
  top: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs open-caret` 跑会自动带上)')
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

  const docText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)

  const caretInfo = (): Promise<{ line: number; text: string; head: number }> =>
    evalJs<{ line: number; text: string; head: number }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, text: line.text, head }
      })()`)

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const r = el.getBoundingClientRect()
        return { text: el.textContent ?? '', cls: el.className, height: Math.round(r.height), top: Math.round(r.top) }
      })`)

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
    await focusEditor()
  }

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(150)
  }

  const dump = (lines: LineInfo[]): string =>
    JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}:${l.height}[${l.cls}]`))

  // ---------- 1. 开头留一条空行的代码块 ----------

  console.log('\n【1】文件开头留空行 + 代码块:光标不落在空行上,点别处文章不动')
  await loadDoc('\n```js\nconst a = 1\n```\n\n阿\n\n阿\n')
  {
    const caret = await caretInfo()
    check('初始光标落在代码块那一行,不在开头的空行上', caret.line === 2 && caret.text === '```js', JSON.stringify(caret))
    const lines = await domLines()
    check(
      '开头那条空行仍按结构空行收紧',
      !!lines[0] && lines[0].text === '' && /cm-md-block-gap/.test(lines[0].cls) && lines[0].height < 36,
      dump(lines)
    )
  }
  const before = await domLines()
  const bodyBefore = before.find(l => l.text === '阿')
  await setCaret((await docText()).indexOf('阿'))
  {
    const after = await domLines()
    const bodyAfter = after.find(l => l.text === '阿')
    check(
      '光标挪到正文后,开头空行没有缩回去(行数/行高不变)',
      after.length === before.length &&
        after[0]?.height === before[0]?.height &&
        after[0]?.top === before[0]?.top,
      `${dump(before)}\n    → ${dump(after)}`
    )
    check(
      '正文没有往上挪',
      bodyAfter?.top === bodyBefore?.top,
      `${bodyBefore?.top} → ${bodyAfter?.top}`
    )
  }

  // ---------- 2. 开头留空行的公式块 ----------

  console.log('\n【2】文件开头留空行 + 公式块:同样不落在空行上')
  await loadDoc('\n$$\nE = mc^2\n$$\n\n阿\n\n阿\n')
  {
    const caret = await caretInfo()
    check('初始光标落在公式块那一行,不在开头的空行上', caret.line === 2 && caret.text === '$$', JSON.stringify(caret))
    const lines = await domLines()
    check(
      '开头那条空行没有被撑成整行',
      !!lines[0] && lines[0].text === '' && lines[0].height < 54,
      dump(lines)
    )
  }
  const mathBefore = await domLines()
  await setCaret((await docText()).indexOf('阿'))
  {
    const after = await domLines()
    // 公式块自己会从源码态换回渲染卡片(光标在块内 / 块外的正常切换),高度本来
    // 就会变一点;这里只认「开头那条空行不能撑开又缩回」——用户看到的多出一行、
    // 文章往上挪是它造成的。
    check(
      '光标挪到正文后,开头空行高度不变',
      after[0]?.height === mathBefore[0]?.height,
      `${mathBefore[0]?.height} → ${after[0]?.height}`
    )
  }

  // ---------- 3. 原来就停在开头的情况不受影响 ----------

  console.log('\n【3】开头就是正文 / 空文档:光标照旧停在第一行')
  await loadDoc('阿\n\n乙\n')
  {
    const caret = await caretInfo()
    check('普通文件光标在第一行', caret.line === 1 && caret.head === 0, JSON.stringify(caret))
  }
  await loadDoc('')
  {
    const caret = await caretInfo()
    check('空文档光标在开头', caret.line === 1 && caret.head === 0, JSON.stringify(caret))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
