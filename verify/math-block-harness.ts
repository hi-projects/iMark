/**
 * 块级公式(行首 `$$...$$`)端到端验证。
 *
 * 回归的是这样一类文档:公式体里某一行以 `+` / `-` / `>` 开头(多行推导式很常见),
 * 而 Lezer 先做块解析再做行内解析 —— 只要 `$$` 只由行内解析器负责,这一行就会
 * 被读成列表,`$$...$$` 再也配不上对(现象:公式没渲染,`+` 变成圆点)。
 *
 * 验三件事:
 *   1. 光标在公式内(源码态):`+` 行还是普通正文,没有 ListMark 圆点;
 *   2. 光标移出后:整块渲染成一个 KaTeX widget,源码行折叠,仍然没有圆点;
 *   3. 光标再进入:恢复源码态,公式体一行不少。
 *
 * 跑法(仓库根目录,先 `npx electron-vite build`):
 *   node verify/run.mjs math-block
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
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
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 用户报告的公式:第四行以 `+` 开头 */
const FORMULA_BODY = [
  'q_\\sigma(x_{t-1}\\mid x_t, x_0)',
  '= \\mathcal{N}\\left(',
  '\\sqrt{\\bar\\alpha_{t-1}}\\,x_0',
  '+ \\sqrt{1-\\bar\\alpha_{t-1}-\\sigma_t^2}\\cdot',
  '\\frac{x_t-\\sqrt{\\bar\\alpha_t}x_0}{\\sqrt{1-\\bar\\alpha_t}},',
  '\\ \\sigma_t^2 I',
  '\\right)'
]
const FORMULA = ['$$', ...FORMULA_BODY, '$$'].join('\n')
/** AI 模型更常用的另一种写法,必须与 $$ 一样整块解析 */
const BRACKET_FORMULA = ['\\[', ...FORMULA_BODY, '\\]'].join('\n')

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <name>` 跑会自动带上)')
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
  const note = join(vault, '笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })

  // 公式后面留空行 + 正文:光标可以停在公式外,整块才会渲染
  await writeFile(note, `${FORMULA}\n\n末尾\n`, 'utf8')
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
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

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

  interface State {
    lines: number
    bullets: number
    widgets: number
    katex: number
    voidLines: number
    srcMarks: number
    text: string
  }

  const state = (): Promise<State> =>
    evalJs(`
      (() => {
        const content = document.querySelector('.cm-content')
        return {
          lines: document.querySelectorAll('.cm-content .cm-line').length,
          bullets: document.querySelectorAll('.cm-md-listmark-bullet').length,
          widgets: document.querySelectorAll('.cm-md-math-display').length,
          katex: document.querySelectorAll('.cm-md-math-display .katex').length,
          voidLines: document.querySelectorAll('.cm-content .cm-line.cm-md-math-void').length,
          srcMarks: document.querySelectorAll('.cm-md-math-src').length,
          text: content ? content.textContent : ''
        }
      })()`)

  await focusEditor()
  // 打开文件时光标在文首 —— 正好落在开头的 `$$` 里(源码态)
  await key('Home', ['control'])
  await sleep(600)

  console.log('\n【1】光标在公式内(源码态)')
  const src = await state()
  check('公式体里的 `+` 行没有被读成列表(无圆点)', src.bullets === 0, JSON.stringify(src.bullets))
  check(
    '源码态能看到公式体(含 `+ \\\\sqrt` 那一行)',
    src.text.includes('+ \\sqrt{1-\\bar\\alpha_{t-1}-\\sigma_t^2}'),
    JSON.stringify(src.text.slice(0, 160))
  )
  check('源码态没有渲染 widget', src.widgets === 0, JSON.stringify(src.widgets))
  check('公式源码有底色标记', src.srcMarks > 0, String(src.srcMarks))

  console.log('\n【2】光标移到文末(渲染态)')
  await key('End', ['control'])
  await sleep(800)
  const rendered = await state()
  check('整块渲染成一个公式 widget', rendered.widgets === 1, JSON.stringify(rendered.widgets))
  check('widget 里是真正的 KaTeX 输出', rendered.katex === 1, JSON.stringify(rendered.katex))
  check('渲染态也没有列表圆点', rendered.bullets === 0, JSON.stringify(rendered.bullets))
  check(
    '公式源码行被折叠(9 行公式 → 8 行 cm-md-math-void)',
    rendered.voidLines === 8,
    JSON.stringify(rendered.voidLines)
  )
  check(
    '渲染态看不到 `+ \\\\sqrt` 源码',
    !rendered.text.includes('\\sqrt'),
    JSON.stringify(rendered.text.slice(0, 160))
  )

  console.log('\n【3】光标再回到公式内')
  await key('Home', ['control'])
  await sleep(800)
  const back = await state()
  check('恢复源码态(没有 widget)', back.widgets === 0, JSON.stringify(back.widgets))
  check('公式体一行不少', back.text.includes('\\right)') && back.text.includes('q_\\sigma'), JSON.stringify(back.text.slice(0, 160)))
  check('依旧没有列表圆点', back.bullets === 0, JSON.stringify(back.bullets))

  /** 写盘 + 重载:拿到一个光标在文首的干净编辑器(光标在公式外 → 渲染态) */
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
  }

  /*
   * 容器里的块级公式:MathBlock 的每行内容是一个独立的 MathContent
   * (行首的 `> ` / 缩进不进入 TeX)。这里只验「能整体渲染、不报错」。
   */
  const inContainer = async (label: string, content: string): Promise<void> => {
    console.log(`\n【4】${label}`)
    await loadDoc(content)
    const info = await state()
    check('整块渲染成一个公式 widget', info.widgets === 1, JSON.stringify(info.widgets))
    check('widget 里是真正的 KaTeX 输出', info.katex === 1, JSON.stringify(info.katex))
    check('渲染态看不到公式源码', !info.text.includes('\\sqrt'), JSON.stringify(info.text.slice(0, 160)))
  }

  await inContainer('列表项里的块级公式', `- $$\n  a\n  + b\n  $$\n\n末尾\n`)
  await inContainer('引用块里的块级公式', `> $$\n> a\n> + b\n> $$\n\n末尾\n`)

  console.log('\n【4b】\\[...\\] 写法:公式体里的 `+` 行同样不会被读成列表')
  await loadDoc(`开头\n\n${BRACKET_FORMULA}\n\n末尾\n`)
  const bracket = await state()
  check('整块渲染成一个公式 widget', bracket.widgets === 1, JSON.stringify(bracket.widgets))
  check('widget 里是真正的 KaTeX 输出', bracket.katex === 1, JSON.stringify(bracket.katex))
  check('渲染态没有列表圆点', bracket.bullets === 0, JSON.stringify(bracket.bullets))
  check(
    '渲染态看不到公式源码',
    !bracket.text.includes('\\sqrt'),
    JSON.stringify(bracket.text.slice(0, 160))
  )

  console.log('\n【5】滚动穿过比视口还高的公式:任何位置都不会留下空白')
  // 与表格同一条不变式:折叠行只可能在 widget 已经画出来的前提下存在。
  // 一旦出现「行被清空、widget 却没画出来」,屏幕上就是一块空白。
  const longMath = ['$$', ...Array.from({ length: 60 }, (_, i) => `+ \\sqrt{x_{${i}}}`), '$$', '', '末尾'].join('\n')
  await loadDoc(`${longMath}\n`)
  // 先把光标移出公式,进入渲染态
  await key('End', ['control'])
  await sleep(600)
  const scrollHeight = await evalJs<number>(`document.querySelector('.cm-scroller').scrollHeight`)
  const seen: string[] = []
  let blank = 0
  for (let step = 0; step <= 8; step++) {
    await evalJs(
      `(() => { document.querySelector('.cm-scroller').scrollTop = ${Math.round((scrollHeight * step) / 8)}; return true })()`
    )
    await sleep(260)
    const [widgets, voids] = await evalJs<[number, number]>(`
      (() => [
        document.querySelectorAll('.cm-md-math-display').length,
        document.querySelectorAll('.cm-content .cm-line.cm-md-math-void').length
      ])()`)
    seen.push(`${step}: ${widgets} widget / ${voids} 折叠`)
    if (widgets === 0 && voids > 0) blank += 1
  }
  check('9 个滚动位置都没出现「清空了却没画公式」', blank === 0, seen.join('; '))
  await evalJs(`(() => { document.querySelector('.cm-scroller').scrollTop = 0; return true })()`)
  await sleep(500)
  const top = await state()
  check('滚回顶部后公式重新渲染出来', top.widgets === 1, JSON.stringify(top.widgets))

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
