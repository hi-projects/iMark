/**
 * 删空代码块的开围栏时,回车补出来的收围栏要跟着删。
 *
 * 用户报告的路径:敲 ``` + 回车 → 补全成「开围栏 / 空行 / 收围栏」,
 * 然后删掉开围栏那几个反引号。只删一个字符的话:开围栏行剩下 ` `` ` 残余,
 * 收围栏变成一条**未闭合围栏**,渲染层从它开始画代码卡片、把后面正文全吞进去
 * —— 看起来像凭空冒出一个代码块。用户要求「按一次就把整个都删掉」。
 *
 * 验收(实现见 src/renderer/src/editor/fenceCleanup.ts):
 *  · 按一次退格删开围栏,整个块就没了,只剩块位置上的那一条空段落;
 *  · 选中开围栏删除 / 在行首退格把开围栏并进上一行,同样一次删干净;
 *  · 块里有内容时只删围栏,内容行原样保留;
 *  · 删完仍然合法的围栏(四个反引号删成三个)整块不动;
 *  · 清理和原删除合成一个事务,一次撤销就把整个块恢复。
 *
 * 跑法(仓库根目录,改过渲染层先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs fence-delete
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
const REPO = join(__dirname, '..', '..')

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs fence-delete` 跑会自动带上)')
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
  const note = join(vault, '围栏.md')
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

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(200)
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

  /** 代码卡片 = 打了代码样式的行(打开围栏、正文、收围栏都算) */
  const codeLines = (): Promise<string[]> =>
    evalJs<string[]>(`
      [...document.querySelectorAll('.cm-content .cm-line.cm-md-code')].map(el => el.textContent)`)

  const copyButtons = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-code-copy').length`)

  /** 直接把光标放到绝对位置(合成按键只负责触发事务,落点必须是确定的) */
  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(120)
  }

  /** 选中 [from, to) 再按删除,模拟「拖选开围栏再删」 */
  async function selectRange(from: number, to: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${from}, head: ${to} }, scrollIntoView: true })
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

  // ---------- 1. 回车补全 → 删开围栏 ----------

  console.log('\n【1】敲 ``` + 回车补全,删掉开围栏一个反引号')
  await loadDoc('\n')
  await type('```')
  await key('Enter')
  const auto = await docText()
  check('回车补全成「开围栏 / 空行 / 收围栏」', auto === '```\n\n```\n', JSON.stringify(auto))
  const mid = await caretInfo()
  check('补全后光标落在块中间的空行上', mid.line === 2 && mid.head === 4, JSON.stringify(mid))
  check('补全后有一个代码卡片', (await codeLines()).length === 3, JSON.stringify(await codeLines()))

  await setCaret(3) // 开围栏行尾
  await key('Backspace')
  const doc1 = await docText()
  // 一次退格删掉整个块,只留块位置上的那条空段落(收围栏后面那条换行)
  check('按一次退格整块消失,没有 ` 残余', doc1 === '\n', JSON.stringify(doc1))
  check('不再有代码卡片', (await codeLines()).length === 0, JSON.stringify(await codeLines()))
  check('复制按钮也一起消失', (await copyButtons()) === 0)
  const caret1 = await caretInfo()
  check('光标停在原来那条空段落上', caret1.line === 1 && caret1.head === 0, JSON.stringify(caret1))

  // ---------- 2. 一次撤销 ----------

  console.log('\n【2】撤销:两条围栏一起回来(清理合在同一个事务里)')
  await key('Z', ['control'])
  const undone = await docText()
  check('一次撤销恢复完整代码块', undone === '```\n\n```\n', JSON.stringify(undone))
  check('撤销后代码卡片回来', (await codeLines()).length === 3, JSON.stringify(await codeLines()))

  // ---------- 3. 块里有内容 ----------

  console.log('\n【3】块里有内容:只删围栏,不替用户删内容行')
  await loadDoc('```\ncode\n```\n')
  await setCaret(3)
  await key('Backspace')
  const doc3 = await docText()
  check('收围栏原样保留', doc3 === '``\ncode\n```\n', JSON.stringify(doc3))

  // ---------- 4. 删完仍是合法围栏 ----------

  console.log('\n【4】四个反引号删成三个,块仍然成立:不清理')
  await loadDoc('````\n\n````\n')
  await setCaret(4)
  await key('Backspace')
  const doc4 = await docText()
  check('收围栏保留', doc4 === '```\n\n````\n', JSON.stringify(doc4))

  // ---------- 5. 开围栏并进上一行 ----------

  console.log('\n【5】开围栏行首退格,和上一行接起来:围栏残迹和收围栏一起删')
  await loadDoc('正文\n```\n\n```\n')
  await setCaret(3)
  await key('Backspace')
  const doc5 = await docText()
  check('正文保留,围栏残迹和收围栏都删掉', doc5 === '正文\n', JSON.stringify(doc5))
  check('不再有代码卡片', (await codeLines()).length === 0, JSON.stringify(await codeLines()))

  // ---------- 6. 拖选开围栏再删 ----------

  console.log('\n【6】选中整段开围栏再删除')
  await loadDoc('```\n\n```')
  await selectRange(0, 3)
  await key('Backspace')
  const doc6 = await docText()
  check('整块消失,文档变空', doc6 === '', JSON.stringify(doc6))
  check('不再有代码卡片', (await codeLines()).length === 0, JSON.stringify(await codeLines()))

  // ---------- 7. 普通删除不受影响 ----------

  console.log('\n【7】普通正文里的退格不会被围栏清理误伤')
  await loadDoc('第一段\n\n第二段\n')
  await setCaret(8) // 「第二段」行尾
  await key('Backspace')
  const doc7 = await docText()
  check('只删掉一个字', doc7 === '第一段\n\n第二\n', JSON.stringify(doc7))

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
