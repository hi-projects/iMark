/**
 * 块级公式源码块的外观与 Ctrl+A 行为验收。
 *
 * 两件事:
 *   1. 光标进入多行公式(源码态)时,整块每一行(含 `$$` 定界行)都有整行底色,
 *      而不是只把 MathContent 片段各自染成一条;
 *   2. 光标在块级公式里时 Ctrl+A 只选中公式源码(不含 `$$` 定界符),
 *      重复按也不扩到整篇;正文里的 Ctrl+A 仍是整篇。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-select-all
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
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
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

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

/** 多行公式:中间有一行以 `+` 开头(块解析器的关键用例) */
const BODY = [
  '\\begin{aligned}',
  'tr(R) &= r_{11} + r_{22} + r_{33}',
  '+ \\sqrt{1-\\bar\\alpha_{t-1}}',
  '\\end{aligned}'
]
const FORMULA = ['$$', ...BODY, '$$'].join('\n')
const BODY_TEXT = BODY.join('\n')
const DOC = `# 公式全选验收\n\n前置正文。\n\n${FORMULA}\n\n后置正文。\n`

interface Selection {
  from: number
  to: number
  text: string
  docLen: number
}

interface SourceLines {
  total: number
  /** 每行的 class、背景色与左留白宽度 */
  lines: Array<{ text: string; cls: string; bg: string; borderLeft: string }>
}

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
  const note = join(vault, '公式.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, DOC, 'utf8')
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
  const win = createMainWindow(settings)
  const wc = win.webContents
  wc.on('console-message', d => {
    if (d.level === 'error' || d.level === 'warning') console.log(`  [渲染层 ${d.level}] ${d.message}`)
  })
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1500)

  const evalJs = <T,>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  const setCursor = (pos: number): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.focus()
      v.dispatch({ selection: { anchor: ${pos} }, userEvent: 'select' })
      return true
    })()`)

  async function ctrlA(): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(250)
  }

  const selection = (): Promise<Selection> =>
    evalJs<Selection>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const r = v.state.selection.main
      return { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to), docLen: v.state.doc.length }
    })()`)

  const menuSelectAll = (): Promise<void> => {
    wc.send(IPC.MenuCommand, 'edit:select-all')
    return sleep(250)
  }

  /** 看 DOM 里每行的 class 与计算背景色 */
  const sourceLines = (): Promise<SourceLines> =>
    evalJs<SourceLines>(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-content .cm-line'))
      return {
        total: lines.length,
        lines: lines.map(el => ({
          text: el.textContent ?? '',
          cls: el.className,
          bg: getComputedStyle(el).backgroundColor,
          borderLeft: getComputedStyle(el).borderLeftWidth
        }))
      }
    })()`)

  const widgets = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-md-math-display').length`)

  const at = (s: string, extra = 0): number => {
    const i = DOC.indexOf(s)
    if (i < 0) throw new Error(`用例文档里找不到 ${JSON.stringify(s)}`)
    return i + extra
  }

  await focusEditor()

  console.log('\n【1】光标在公式内:整块源码(含 $$ 行)都有底色')
  await setCursor(at('tr(R)', 2))
  await sleep(400)
  {
    const src = await sourceLines()
    const formulaLines = src.lines.filter(l => /\\begin\{aligned\}|tr\(R\)|sqrt|end\{aligned\}|\$\$/.test(l.text))
    check('找得到公式源码行', formulaLines.length >= 6, JSON.stringify(formulaLines.map(l => l.text)))
    check(
      '每一行都挂了 cm-md-math-src-line(含两行 $$)',
      formulaLines.length >= 6 && formulaLines.every(l => l.cls.includes('cm-md-math-src-line')),
      JSON.stringify(formulaLines.map(l => l.cls))
    )
    check(
      '两行 $$ 也有底色',
      formulaLines.filter(l => l.text.trim() === '$$').every(l => l.bg !== 'rgba(0, 0, 0, 0)'),
      JSON.stringify(formulaLines.filter(l => l.text.trim() === '$$').map(l => l.bg))
    )
    check(
      '左侧留白与代码块一致(不顶格)',
      formulaLines.every(l => l.borderLeft !== '0px' && l.borderLeft !== ''),
      JSON.stringify(formulaLines.map(l => l.borderLeft))
    )
    check(
      '源码没有渲染成 widget',
      (await widgets()) === 0,
      String(await widgets())
    )
  }

  console.log('\n【2】光标移出后:恢复渲染,源码行底色消失')
  await setCursor(at('后置正文', 1))
  await sleep(700)
  {
    check('整块渲染成一个公式 widget', (await widgets()) === 1, String(await widgets()))
    const src = await sourceLines()
    check(
      '渲染态没有源码行底色',
      src.lines.every(l => !l.cls.includes('cm-md-math-src-line')),
      JSON.stringify(src.lines.map(l => l.cls).filter(c => c.includes('math-src-line')))
    )
  }

  console.log('\n【3】公式里 Ctrl+A:只选公式源码,不选整篇')
  await setCursor(at('tr(R)', 2))
  await sleep(300)
  await ctrlA()
  {
    const sel = await selection()
    check('选中的是公式体', sel.text === BODY_TEXT, JSON.stringify(sel.text))
    check('不含 $$ 定界符', !sel.text.includes('$$'), JSON.stringify(sel.text))
    check('没有选到整篇', sel.to - sel.from < sel.docLen, `${sel.from}..${sel.to}/${sel.docLen}`)
  }

  console.log('\n【4】再按一次 Ctrl+A:仍是这一块,不扩到整篇')
  await ctrlA()
  {
    const sel = await selection()
    check('第二次按仍只选公式体', sel.text === BODY_TEXT, JSON.stringify(sel.text))
    check('范围没有变成整篇', sel.from !== 0 || sel.to !== sel.docLen, `${sel.from}..${sel.to}/${sel.docLen}`)
  }

  console.log('\n【5】光标停在开头的 $$ 行上 Ctrl+A:仍选公式体')
  await setCursor(at('$$\n\\begin', 1))
  await ctrlA()
  {
    const sel = await selection()
    check('定界行上也是选公式体', sel.text === BODY_TEXT, JSON.stringify(sel.text))
  }

  console.log('\n【6】正文段落里 Ctrl+A:仍是整篇(普通全选不受影响)')
  await setCursor(at('前置正文', 1))
  await ctrlA()
  {
    const sel = await selection()
    check('段落里全选整篇', sel.from === 0 && sel.to === sel.docLen, `${sel.from}..${sel.to}`)
  }

  console.log('\n【7】菜单「全选」在公式里也走同一规则')
  await setCursor(at('tr(R)', 2))
  await menuSelectAll()
  {
    const sel = await selection()
    check('菜单命令在公式里也只选公式体', sel.text === BODY_TEXT, JSON.stringify(sel.text))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
