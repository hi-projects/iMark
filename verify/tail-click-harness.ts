/**
 * 「点击最后一行下方」的端到端验证。
 *
 * 行为(见 build.ts 的 clickBelowDocEnd / endOfLastText):
 *   - 点在最后一行下方的空白:不改源码,光标直接落到最后一个非空白字符后面;
 *   - 文末本来就有空行时也一样,光标不会停在空行上;
 *   - 接着输入就接在最后一行末尾,不会多出新行;
 *   - 点击 / 失焦都不产生任何文档变更。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs tail-click
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
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

/** 用户实际文件的样子:两组代码块(中间隔空行,不合并),文末没有换行 */
const USER_DOC = '\n\n\n\n```js title="a.js"\na \n```\n\n```xml\na \n```'

async function main(): Promise<void> {
  await app.whenReady()
  ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
    canceled: true,
    filePath: undefined
  })
  ;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => 1
  ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 1 })

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, USER_DOC, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSave: false
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
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const VIEW = `document.querySelector('.cm-content')?.cmTile?.root?.view`

  const docText = (): Promise<string> => evalJs<string>(`${VIEW}.state.doc.toString()`)

  const caretInfo = (): Promise<{ line: number; text: string; head: number }> =>
    evalJs<{ line: number; text: string; head: number }>(`
      (() => {
        const view = ${VIEW}
        const head = view.state.selection.main.head
        const line = view.state.doc.lineAt(head)
        return { line: line.number, text: line.text, head }
      })()`)

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(600)
    // 等编辑器真的打开这份文件再往下点(重载后选文件是异步的,固定 sleep 偶尔
    // 会在上个文档还没换掉时就点下去 —— 曾经让 2/3 段偶发失败)
    for (let i = 0; i < 30; i++) {
      const text = await docText().catch(() => null)
      if (text === content) break
      await sleep(100)
    }
    await focusEditor()
  }

  /** 重载后编辑器里的文档;和期望不一致时把它打出来,别让后面的检查背锅 */
  async function checkLoaded(label: string, content: string): Promise<void> {
    const text = await docText()
    check(label, text === content, JSON.stringify(text))
  }

  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(20)
    }
    await sleep(260)
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(280)
  }

  /** 真鼠标点一下页面坐标(wc.sendInputEvent 的坐标就是视口坐标) */
  async function clickAt(x: number, y: number): Promise<void> {
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await sleep(320)
  }

  /** 点在最后一行下方的空白里 */
  let lastSpot: { x: number; y: number; h: number } | null = null
  async function clickBelowLastLine(offset = 40): Promise<boolean> {
    lastSpot = await evalJs<{ x: number; y: number; h: number } | null>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const last = lines[lines.length - 1]
        if (!last) return null
        const r = last.getBoundingClientRect()
        return { x: Math.round(r.left + 40), y: Math.round(r.bottom + ${offset}), h: window.innerHeight }
      })()`)
    if (!lastSpot) return false
    await clickAt(lastSpot.x, lastSpot.y)
    return true
  }

  /** 点某一行(按 DOM 顺序),用于「点回正文」 */
  async function clickDomLine(index: number): Promise<boolean> {
    const spot = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const el = [...document.querySelectorAll('.cm-content .cm-line')][${index}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!spot) return false
    await clickAt(spot.x, spot.y)
    return true
  }

  // ---------- 1. 点文末空白:不改源码,光标落到最后一个字后面 ----------

  console.log('\n【1】点最后一行下方:不改源码,光标落到最后一个字后面')
  await loadDoc(USER_DOC)
  check('起始文档与用户文件一致', (await docText()) === USER_DOC)
  check('真鼠标点到文末空白', await clickBelowLastLine())
  {
    const text = await docText()
    check('源码一个字都没变', text === USER_DOC, `${JSON.stringify(text.slice(-16))}  spot=${JSON.stringify(lastSpot)}`)
    const caret = await caretInfo()
    check('光标在最后一个非空白字符后面', caret.head === USER_DOC.length, JSON.stringify(caret))
  }
  await type('续写')
  {
    const text = await docText()
    check('输入接在最后一行末尾,没有多出新行', text === USER_DOC + '续写', JSON.stringify(text.slice(-10)))
  }
  await clickDomLine(0)
  await sleep(300)
  check('点走也不改动文档', (await docText()) === USER_DOC + '续写')

  // ---------- 2. 文末有空行:光标也不会停在空行上 ----------

  console.log('\n【2】文末本来就有空行:光标仍落在最后一个字后面')
  const TAIL_SPACED = '第一段\n\n'
  await loadDoc(TAIL_SPACED)
  await checkLoaded('重载后是「第一段 + 空行」', TAIL_SPACED)
  await clickBelowLastLine()
  {
    const text = await docText()
    check('源码没有多出换行', text === TAIL_SPACED, `${JSON.stringify(text)}  spot=${JSON.stringify(lastSpot)}`)
    const caret = await caretInfo()
    check('光标在「第一段」后面,不在空行上', caret.head === 3 && caret.line === 1, JSON.stringify(caret))
  }
  await type('x')
  check('输入接在正文末尾', (await docText()) === '第一段x\n\n', JSON.stringify(await docText()))
  await clickDomLine(0)
  await sleep(300)
  check('点走也不改文档', (await docText()) === '第一段x\n\n')

  // ---------- 3. 点在最后一行本身上:文档不变 ----------

  console.log('\n【3】点在最后一行上(不是下方):不改文档')
  const PLAIN_TAIL = '第一段\n\n最后一行'
  await loadDoc(PLAIN_TAIL)
  await clickDomLine(2)
  await sleep(300)
  {
    const caret = await caretInfo()
    check('文档没有变化', (await docText()) === PLAIN_TAIL, JSON.stringify(await docText()))
    check('光标落在最后一行里', caret.line === 3, JSON.stringify(caret))
  }

  // ---------- 4. 点击后失焦:没有临时草稿,文档不变 ----------

  console.log('\n【4】点文末空白后切走焦点:文档不变')
  await loadDoc(USER_DOC)
  await clickBelowLastLine()
  check('点击后文档不变', (await docText()) === USER_DOC)
  await evalJs(`(() => { document.querySelector('.cm-content')?.blur(); return true })()`)
  await sleep(400)
  check('失焦后仍是原样', (await docText()) === USER_DOC, JSON.stringify((await docText()).slice(-12)))

  // ---------- 5. 手动回车创建空段:点文末要回到这个空段 ----------

  console.log('\n【5】手动回车创建空段后点文末空白:光标回到这个空段上')
  await loadDoc('第一段')
  await evalJs(`(() => {
    const v = ${VIEW}
    v.focus()
    v.dispatch({ selection: { anchor: v.state.doc.length } })
    return true
  })()`)
  await sleep(150)
  await key('Return')
  await sleep(300)
  check('回车创建了空段', (await docText()) === '第一段\n\n', JSON.stringify(await docText()))
  await clickBelowLastLine()
  {
    const text = await docText()
    const caret = await caretInfo()
    check('点击不改文档', text === '第一段\n\n', JSON.stringify(text))
    check(
      '光标落在新建的空段上(不是上一段正文)',
      caret.head === text.length && caret.line === 3,
      JSON.stringify(caret)
    )
  }
  await type('续')
  check('输入接在空段里', (await docText()) === '第一段\n\n续', JSON.stringify(await docText()))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
