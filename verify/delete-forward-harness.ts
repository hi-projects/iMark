/**
 * 验收:正文行尾按 Delete 收回下一段(与行首退格对称)。
 *
 * 用户报告:第一行输入「阿」回车建新段,光标移到第一行行尾按 Delete,新段没有
 * 被删除,只少了一条换行 —— 段落分隔没了,空段落还贴着上一段,看起来像把分段
 * 变成了段内换行。期望与「光标移到新段行首按退格」一致:整个新段收回,光标留在
 * 上一段行尾。
 *
 * 期望:
 *   · 回车建出的空段落:Delete 一次整段收回(源码回到 `阿\n`);
 *   · 新段已经敲了字 / 是标题:文字接上来,标题的 `# ` 一起删掉;
 *   · 连续回车建出多条空段落时,一次收回一段;
 *   · 列表、段内软换行、文件里手写的结尾空行仍走默认 Delete;
 *   · 光标不在行尾 / 当前行是标题时不接管。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs delete-forward
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
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs delete-forward` 跑会自动带上)')
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
    await sleep(220)
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

  const caretInfo = (): Promise<{ line: number; head: number; text: string }> =>
    evalJs<{ line: number; head: number; text: string }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        return { line: line.number, head: view.state.selection.main.head, text: line.text }
      })()`)

  const domLines = (): Promise<LineInfo[]> =>
    evalJs<LineInfo[]>(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => ({
        text: el.textContent ?? '',
        cls: el.className
      }))`)

  const emptyParagraphLines = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-empty-paragraph').length`)

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
    JSON.stringify(lines.map(l => `${JSON.stringify(l.text)}[${l.cls}]`))

  // ---------- 1. 用户报告:回车建新段,回到第一行行尾按 Delete ----------

  console.log('\n【1】回车建新段后,光标回到第一行行尾按 Delete:新段整段收回')
  await loadDoc('阿\n')
  await setCaret(1)
  await key('Enter')
  {
    const src = await docText()
    check('回车后的源码是「正文 + 分隔空行 + 新段空行」', src === '阿\n\n\n', JSON.stringify(src))
  }
  await setCaret(1) // 第一行行尾
  await key('Delete')
  {
    const src = await docText()
    const caret = await caretInfo()
    const empties = await emptyParagraphLines()
    check('落盘:新段连同段落分隔一起收回', src === '阿\n', JSON.stringify(src))
    check(
      '光标留在第一行行尾',
      caret.line === 1 && caret.head === 1 && caret.text === '阿',
      JSON.stringify(caret)
    )
    check('屏幕上不再有空段落行', empties === 0, `cm-md-empty-paragraph × ${empties}`)
    const lines = await domLines()
    check('正文没有变成段内换行', lines.filter(l => l.text === '阿').length === 1, dump(lines))
  }

  // ---------- 2. 新段已经敲了字 ----------

  console.log('\n【2】下一段已经敲了字:Delete 把文字接上来')
  await loadDoc('阿\n\n乙\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    const caret = await caretInfo()
    check('落盘:两段并成一段', src === '阿乙\n', JSON.stringify(src))
    check('光标落在接缝处', caret.line === 1 && caret.head === 1, JSON.stringify(caret))
  }

  // ---------- 3. 下一段是标题 ----------

  console.log('\n【3】下一块是标题:Delete 连同 `# ` 一起并上来(与行首退格对称)')
  await loadDoc('阿\n\n# 标题\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('落盘:标题标记删掉,文字接在上一段后面', src === '阿标题\n', JSON.stringify(src))
  }

  console.log('\n【4】标题紧贴上一段(没有空行)时同样并')
  await loadDoc('阿\n# 标题\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('落盘:标题标记删掉,两行接回一段', src === '阿标题\n', JSON.stringify(src))
  }

  // ---------- 5. 不接管的情况 ----------

  console.log('\n【5】段内软换行仍走默认 Delete(只删换行)')
  await loadDoc('阿\n乙\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('落盘:两行接起来(同一段内的换行)', src === '阿乙\n', JSON.stringify(src))
  }

  console.log('\n【6】下一块是列表:默认 Delete 只删换行,列表标记留着')
  await loadDoc('阿\n\n- 乙\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('落盘:只删掉一条换行', src === '阿\n- 乙\n', JSON.stringify(src))
  }

  console.log('\n【7】文件里手写的结尾空行不当成「新段」')
  await loadDoc('阿\n\n\n')
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('落盘:默认命令只删一条换行', src === '阿\n\n', JSON.stringify(src))
  }

  console.log('\n【8】当前行是标题时不接管')
  await loadDoc('# 标题\n\n乙\n')
  await setCaret(4) // 标题行行尾
  await key('Delete')
  {
    const src = await docText()
    check('落盘:标题后面的换行被删掉,标题本身不变', src === '# 标题\n乙\n', JSON.stringify(src))
  }

  // ---------- 9. 连续回车:一次收回一段 ----------

  console.log('\n【9】连续回车建出两条空段落:Delete 一次收回一段')
  await loadDoc('阿\n')
  await setCaret(1)
  await key('Enter')
  await key('Enter')
  {
    const src = await docText()
    check('两次回车后有两条空段落', src === '阿\n\n\n\n\n', JSON.stringify(src))
  }
  await setCaret(1)
  await key('Delete')
  {
    const src = await docText()
    check('第一次 Delete:收回一段', src === '阿\n\n\n', JSON.stringify(src))
  }
  await key('Delete')
  {
    const src = await docText()
    check('第二次 Delete:再收回一段', src === '阿\n', JSON.stringify(src))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
