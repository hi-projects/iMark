/**
 * 删空公式块的 `$$` / `\[` 定界符时,整个公式块一起删。
 *
 * 用户报告的路径:敲 `$$` + 回车 → 补全成「$$ / 空行 / $$」,然后删定界符。
 * 只删一个字符的话:开标记行剩下 `$` 残余,另一行 `$$` 变成一条**未闭合**
 * 开标记(块解析器会从它开始把后面的正文全吞进公式),要删好几次才能删干净。
 * 用户要求「删一个后,自动删除全部 $」。
 *
 * 验收(实现见 src/renderer/src/editor/fenceCleanup.ts 的 emptyMathBlockDeleteFilter):
 *  · 按一次退格删开标记,整个块就没了,只剩块位置上的那一条空段落;
 *  · 删收标记同样一次删干净;
 *  · 块里有公式内容时只删定界符,内容行原样保留;
 *  · `\[ ... \]` 同样适用;
 *  · 清理和原删除合成一个事务,一次撤销就把整个块恢复。
 *
 * 跑法(仓库根目录,改过渲染层先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-delete
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
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs math-delete` 跑会自动带上)')
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
  const note = join(vault, '公式删除.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '\n', 'utf8')
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

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never })
    await sleep(220)
  }

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(25)
      }
      await sleep(260)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)})`)
    }
  }

  const docText = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)

  const caretInfo = (): Promise<{ line: number; head: number }> =>
    evalJs<{ line: number; head: number }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const head = view.state.selection.main.head
        return { line: view.state.doc.lineAt(head).number, head }
      })()`)

  /** 公式源码块 = 打了公式底色样式的行 */
  const mathLines = (): Promise<string[]> =>
    evalJs<string[]>(`
      [...document.querySelectorAll('.cm-content .cm-line.cm-md-math-src-line')].map(el => el.textContent)`)

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(120)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
    await focusEditor()
  }

  // ---------- 1. 回车补全 → 删开标记 ----------

  console.log('\n【1】敲 $$ + 回车补全,在开标记行尾退格删掉一个 $')
  await loadDoc('\n')
  await type('$$')
  await key('Enter')
  const auto = await docText()
  check('回车补全成「$$ / 空行 / $$」', auto === '$$\n\n$$\n', JSON.stringify(auto))
  const mid = await caretInfo()
  check('补全后光标落在块中间的空行上', mid.line === 2 && mid.head === 3, JSON.stringify(mid))
  check('补全后整块是公式源码块', (await mathLines()).length === 3, JSON.stringify(await mathLines()))

  await setCaret(2) // 开标记行尾
  await key('Backspace')
  const doc1 = await docText()
  check('按一次退格整块消失,没有 $ 残余', doc1 === '\n', JSON.stringify(doc1))
  check('不再有公式源码块', (await mathLines()).length === 0, JSON.stringify(await mathLines()))
  const caret1 = await caretInfo()
  check('光标停在原来那条空段落上', caret1.line === 1 && caret1.head === 0, JSON.stringify(caret1))

  // ---------- 2. 一次撤销 ----------

  console.log('\n【2】撤销:整块公式一起回来(清理合在同一个事务里)')
  await key('Z', ['control'])
  const undone = await docText()
  check('一次撤销恢复完整公式块', undone === '$$\n\n$$\n', JSON.stringify(undone))
  check('撤销后公式源码块回来', (await mathLines()).length === 3, JSON.stringify(await mathLines()))

  // ---------- 3. 删收标记 ----------

  console.log('\n【3】删收标记的一个 $:整块同样一起删')
  await loadDoc('$$\n\n$$\n')
  await setCaret(6) // 收标记行尾(文档末尾还有一个换行,位置 7 是它之后)
  await key('Backspace')
  const doc3 = await docText()
  check('按一次退格整块消失', doc3 === '\n', JSON.stringify(doc3))

  // ---------- 4. 块里有公式内容 ----------

  console.log('\n【4】块里有公式内容:只删定界符,不替用户删内容行')
  await loadDoc('$$\nx\n$$\n')
  await setCaret(2)
  await key('Backspace')
  const doc4 = await docText()
  check('开标记只剩一个 $,内容与收标记原样保留', doc4 === '$\nx\n$$\n', JSON.stringify(doc4))

  await loadDoc('$$\nx\n$$\n')
  await setCaret(7)
  await key('Backspace')
  const doc5 = await docText()
  check('删收标记同样不动内容', doc5 === '$$\nx\n$\n', JSON.stringify(doc5))

  // ---------- 5. \[ ... \] ----------

  console.log('\n【5】\\[ ... \\] 写法同样适用')
  await loadDoc('\\[\n\n\\]\n')
  await setCaret(2)
  await key('Backspace')
  const doc6 = await docText()
  check('删掉一个字符整块消失', doc6 === '\n', JSON.stringify(doc6))

  // ---------- 6. 未闭合的公式不清理 ----------

  console.log('\n【6】只有开标记(未闭合):删一个字符不清理')
  await loadDoc('$$\n')
  await setCaret(2)
  await key('Backspace')
  const doc7 = await docText()
  check('只删掉那个字符', doc7 === '$\n', JSON.stringify(doc7))

  // ---------- 7. 普通正文不受影响 ----------

  console.log('\n【7】普通正文里的退格不会被公式清理误伤')
  await loadDoc('第一段\n\n第二段\n')
  await setCaret(8)
  await key('Backspace')
  const doc8 = await docText()
  check('只删掉一个字', doc8 === '第一段\n\n第二\n', JSON.stringify(doc8))

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
