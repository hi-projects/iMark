/**
 * 公式开标记 `$$` 的「待定围栏」行为验收(与代码围栏一致)。
 *
 * 期望:
 *   1. 在空行上刚敲出 `$$` 时按普通文本显示 —— 没有源码块底色、没有 MathMark
 *      样式,也不渲染成公式;
 *   2. 在 `$$` 行尾按回车 → 自动补一条空行和收尾 `$$`,光标落在中间空行,
 *      整块变成真正的公式源码块(输入 TeX 时有实时预览,移出后渲染 KaTeX);
 *   3. 已有内容跟在 `$$` 后面(`$$x`)不触发自动补全 —— 那是用户在写公式,
 *      回车应该换行。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-pending
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
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

const DOC = '# 公式回车验收\n\n第一段。\n\n末尾段落。\n'

interface DomState {
  srcLines: number
  mathMarks: number
  widgets: number
  katex: number
  doc: string
  anchor: number
  empty: boolean
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
  const note = join(vault, '公式回车.md')
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

  /** 把文档重置回用例原文(上一步插入的公式块会影响偏移) */
  const resetDoc = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } })
      return true
    })()`)

  const dom = (): Promise<DomState> =>
    evalJs<DomState>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const r = v.state.selection.main
      return {
        srcLines: document.querySelectorAll('.cm-content .cm-line.cm-md-math-src-line').length,
        mathMarks: document.querySelectorAll('.cm-md-mathmark').length,
        widgets: document.querySelectorAll('.cm-md-math-display').length,
        katex: document.querySelectorAll('.cm-md-math-display .katex').length,
        doc: v.state.doc.toString(),
        anchor: r.from,
        empty: r.empty
      }
    })()`)

  /** 打字必须自检:窗口/编辑器失焦时合成输入会被静默丢掉 */
  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(300)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)})`)
    }
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(300)
  }

  const at = (s: string, extra = 0): number => {
    const i = DOC.indexOf(s)
    if (i < 0) throw new Error(`用例文档里找不到 ${JSON.stringify(s)}`)
    return i + extra
  }

  await focusEditor()

  // 光标放到「第一段。」和「末尾段落。」之间的空行行首(第 2 个 \n 之后)
  const blankPos = at('第一段。') + '第一段。'.length + 1

  console.log('\n【1】空行上刚敲出 $$:按普通文本显示')
  await setCursor(blankPos)
  await type('$$')
  await sleep(400)
  {
    const s = await dom()
    check('文档里确实有 $$', /^\$\$$/m.test(s.doc), JSON.stringify(s.doc))
    check('没有公式源码块底色', s.srcLines === 0, String(s.srcLines))
    check('$$ 没有 MathMark 样式', s.mathMarks === 0, String(s.mathMarks))
    check('没有渲染成公式', s.widgets === 0, String(s.widgets))
    // 行文本里会带上行菜单的「+」按钮(如 "+$$"),按包含匹配
    const lineInfo = await evalJs<{ bg: string; texts: string[] }>(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-content .cm-line'))
      const line = lines.find(l => (l.textContent ?? '').includes('$$'))
      return {
        bg: line ? getComputedStyle(line).backgroundColor : 'missing',
        texts: lines.map(l => l.textContent)
      }
    })()`)
    check('$$ 行没有块底色', lineInfo.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(lineInfo))
    const preview = await evalJs<string>(`(() => {
      const el = document.querySelector('.cm-md-math-preview')
      return el ? getComputedStyle(el).visibility : 'missing'
    })()`)
    check('没有把后面的正文当成公式预览', preview === 'hidden', preview)
  }

  console.log('\n【2】在 $$ 行尾回车:补全空行与收尾 $$,光标落在中间')
  await key('Return')
  await sleep(400)
  {
    const s = await dom()
    check('自动补上了收尾 $$', s.doc.includes('$$\n\n$$'), JSON.stringify(s.doc))
    check('光标落在中间空行', s.empty && s.anchor === s.doc.indexOf('$$\n\n$$') + 3, `${s.anchor}`)
    check('整块成为公式源码块(三行底色)', s.srcLines === 3, String(s.srcLines))
  }

  console.log('\n【3】输入公式并移出:渲染成 KaTeX')
  await type('E=mc^2')
  await sleep(300)
  {
    const s = await dom()
    check('公式体写进中间行', s.doc.includes('$$\nE=mc^2\n$$'), JSON.stringify(s.doc))
  }
  await setCursor(0)
  await sleep(800)
  {
    const s = await dom()
    check('移出公式后渲染成 widget', s.widgets === 1, String(s.widgets))
    check('widget 里是真正的 KaTeX', s.katex === 1, String(s.katex))
    check('渲染态没有源码行底色', s.srcLines === 0, String(s.srcLines))
  }

  console.log('\n【4】$$x(后面已有内容)按回车:不自动补全')
  {
    await resetDoc()
    await sleep(300)
    const pos = at('第一段。') + '第一段。'.length + 1
    await setCursor(pos)
    await type('$$x')
    await sleep(300)
    const before = await dom()
    check('$$x 已经写在空行上', before.doc.includes('$$x'), JSON.stringify(before.doc))
    await key('Return')
    await sleep(300)
    const after = await dom()
    check(
      '回车只是换行,没有补收尾 $$',
      !after.doc.includes('$$\n\n$$') && after.doc.includes('$$x\n'),
      JSON.stringify(after.doc)
    )
  }

  /*
   * 用户报的场景:新段里先敲一个 `$`、再敲第二个 —— 敲完 `$$` 时上方那条
   * 段间距空行突然恢复成整行高,光标行像往下跳了一格。
   */
  console.log('\n【5】新段里敲 $$:上方段间距保持不变')
  {
    await evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '1、\\n\\n' }, selection: { anchor: 4 }, userEvent: 'input' })
      return true
    })()`)
    await sleep(400)
    await focusEditor()
    const measure = (): Promise<{ h: number; cls: string; doc: string }> =>
      evalJs(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const el = document.querySelectorAll('.cm-content .cm-line')[1]
        const r = el.getBoundingClientRect()
        return { h: Math.round(r.height), cls: el.className, doc: v.state.doc.toString() }
      })()`)
    await type('$')
    await sleep(400)
    const one = await measure()
    check(
      '敲第一个 $:上方空行按段间距收紧',
      one.cls.includes('cm-md-block-gap-body'),
      JSON.stringify(one)
    )
    await type('$')
    await sleep(400)
    const two = await measure()
    check('$$ 仍按普通文本显示', two.doc === '1、\n\n$$', JSON.stringify(two.doc))
    check('敲第二个 $ 后上方空行仍是段间距', two.cls.includes('cm-md-block-gap-body'), JSON.stringify(two))
    check('敲第二个 $ 后行高不变', Math.abs(two.h - one.h) <= 1, `${one.h} → ${two.h}`)

    // 回车补全成真正的公式块之后,上方空行不能又跳回整行高
    await key('Return')
    await sleep(500)
    const three = await measure()
    check('回车补全成公式块', three.doc === '1、\n\n$$\n\n$$', JSON.stringify(three.doc))
    check('补全后上方空行高度不变', Math.abs(three.h - two.h) <= 1, `${two.h} → ${three.h}`)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
