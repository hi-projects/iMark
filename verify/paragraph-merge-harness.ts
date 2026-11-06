/**
 * 验收:新段里敲了字之后,行首退格一次就把这一段并回上一段。
 *
 * 用户报告:第一行输入文字后回车开新段,在新段里输入标题,光标移到标题前面按
 * Backspace,标题没有退回上一段,而是直接贴在上一段下面 —— 看着像段内换行。
 *
 * 期望(与「回车 = 新段」对称):
 *   · 标题行首退格一次:段落分隔和 `# ` 标记一起删掉,标题文字接在上一段行尾
 *     (源码 `阿\n\n# 阿\n` → `阿阿\n`),光标落在接缝处;
 *   · 普通正文段落行首退格同样一次并回上一段;
 *   · 紧贴着上一段的标题(没有空行分隔)也算分段,同样并回;
 *   · 同一段里的软换行、列表 / 引用 / 代码行首、文档开头、上一块是标题时
 *     不硬并,仍走默认退格。
 *
 * 跑法(仓库根目录,改过渲染层先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs paragraph-merge
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
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs paragraph-merge` 跑会自动带上)')
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

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const alias: Record<string, string> = {
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      ArrowUp: 'Up',
      ArrowDown: 'Down'
    }
    const code = alias[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(200)
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

  const caretInfo = (): Promise<{ line: number; text: string; head: number; to: number }> =>
    evalJs<{ line: number; text: string; head: number; to: number }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, text: line.text, head, to: line.to }
      })()`)

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => ({
        text: el.textContent ?? '',
        cls: el.className,
        height: Math.round(el.getBoundingClientRect().height)
      }))`)

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

  // ---------- 1. 用户报告:正文 → 回车新段 → 标题 → 标题行首退格 ----------

  console.log('\n【1】正文回车开新段,写成标题,行首退格一次并回上一段')
  await loadDoc('阿\n')
  await setCaret(1)
  await key('Enter')
  {
    const src = await docText()
    check('回车后源码是「正文 + 分隔空行 + 新段空行」', src === '阿\n\n\n', JSON.stringify(src))
  }
  await type('# 阿')
  {
    const src = await docText()
    check('新段写成了一级标题', src === '阿\n\n# 阿\n', JSON.stringify(src))
  }
  const headingPos = (await docText()).indexOf('#')
  await setCaret(headingPos)
  await key('Backspace')
  {
    const src = await docText()
    const caret = await caretInfo()
    const lines = await domLines()
    check('落盘:标题连同段落分隔一起并回上一段', src === '阿阿\n', JSON.stringify(src))
    check(
      '光标落在接缝处(继续退格就是正常删字)',
      caret.line === 1 && caret.text === '阿阿' && caret.head === 1,
      JSON.stringify(caret)
    )
    const body = lines.find(l => l.text === '阿阿')
    check('DOM:只剩一行正文,没有标题渲染', !!body && !/cm-md-h[1-6]/.test(body.cls), dump(lines))
  }
  await key('Backspace')
  {
    const src = await docText()
    check('再退格一次是正常删字,不会继续吞上一段', src === '阿\n', JSON.stringify(src))
  }

  // ---------- 2. 普通正文段落:一次并回上一段 ----------

  console.log('\n【2】普通正文段落行首退格:一次并回上一段')
  await loadDoc('阿\n\n乙\n')
  await setCaret(3) // 「乙」行首
  await key('Backspace')
  {
    const src = await docText()
    const caret = await caretInfo()
    check('落盘:两段并成一段', src === '阿乙\n', JSON.stringify(src))
    check('光标落在接缝处', caret.line === 1 && caret.head === 1, JSON.stringify(caret))
  }

  // ---------- 3. 文档中间的标题 ----------

  console.log('\n【3】文档中间的标题:并回它上面那一段,更上面的段不受影响')
  await loadDoc('甲\n\n正文\n\n# 标题\n')
  await setCaret((await docText()).indexOf('#'))
  await key('Backspace')
  {
    const src = await docText()
    const caret = await caretInfo()
    check('落盘:只并最近的一段', src === '甲\n\n正文标题\n', JSON.stringify(src))
    check('光标落在「正文」行尾', caret.line === 3 && caret.head === 5, JSON.stringify(caret))
  }

  // ---------- 4. 紧贴上一段的标题(没有空行)也并 ----------

  console.log('\n【4】标题紧贴上一段(没有空行分隔)时同样并回')
  await loadDoc('阿\n# 标题\n')
  await setCaret(2) // 「# 标题」行首
  await key('Backspace')
  {
    const src = await docText()
    check('落盘:标题标记和换行一起删掉', src === '阿标题\n', JSON.stringify(src))
  }

  // ---------- 5. 容器 / 特殊块不并 ----------

  console.log('\n【5】列表项行首不硬并(仍走默认退格)')
  await loadDoc('阿\n\n- 乙\n')
  await setCaret((await docText()).indexOf('-'))
  await key('Backspace')
  {
    const src = await docText()
    check('落盘:只删掉一条换行,列表标记还在', src === '阿\n- 乙\n', JSON.stringify(src))
  }

  console.log('\n【6】上一块是标题时不硬并(只删一条换行)')
  await loadDoc('# 甲\n\n乙\n')
  await setCaret(5) // 「乙」行首
  await key('Backspace')
  {
    const src = await docText()
    check('落盘:标题仍是标题,正文仍单独一行', src === '# 甲\n乙\n', JSON.stringify(src))
  }

  console.log('\n【7】文档开头的标题行首退格:不动')
  await loadDoc('# 标题\n')
  await setCaret(0)
  await key('Backspace')
  {
    const src = await docText()
    check('落盘:没有上一段可并,内容不变', src === '# 标题\n', JSON.stringify(src))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
