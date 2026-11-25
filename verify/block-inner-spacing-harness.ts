/**
 * 验收:「块内间距」——代码块 / 公式块内部的行距与正文「行间距」互不影响。
 *
 * 用户报告:
 *   1. 块级公式源码写了两行,渲染出来只有一行;
 *   2. 调正文行间距会把公式块里每行一起拉开;
 *   3. 外观里的「间距」要改叫「块间间距」,并新增「块内间距」模块
 *      (代码块行距 + 公式块行距)。
 *
 * 断言:
 *   A 普通多行公式按源码行数渲染(两个 .katex-base);
 *   B 调正文行距只改变正文段内行距,代码块 / 公式块行距不动;
 *   C 调代码块行距只改变代码行距;调公式块行距只改变公式行距;
 *   D 公式源码态的行距走「公式块行距」,同样不受正文行距影响;
 *   E 设置面板有「块间间距」「块内间距」两节,两根滑块能写根变量并落盘;
 *   F 正文 ↔ 公式块:上下两侧（文字与公式底色块）的距离一致 —— 间距做在
 *     上一块末行的 padding-bottom 上,不撑开公式块的底色;
 *   G 公式块源码态与渲染态占用同一高度,切换时光标下方正文不跳。
 *
 * 跑法(改了 src/renderer/** 之后先 `npm run build`,再在仓库根目录):
 *   xvfb-run -a node verify/run.mjs block-inner-spacing
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const BODY = 15

const DOC = [
  '正文甲第一行',
  '正文甲第二行',
  '',
  '```ts',
  'const a = 1',
  'const b = 2',
  'const c = 3',
  '```',
  '',
  '$$',
  'a = b',
  'c = d',
  '$$',
  '',
  '- 列表甲',
  '- 列表乙',
  '- 列表丙',
  '',
  '> 引用甲',
  '> 引用乙',
  '> 引用丙',
  '',
  '正文乙。',
  ''
].join('\n')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface Metrics {
  /** 同一段里两行正文的行距 */
  bodyPitch: number
  /** 代码块里两行代码的行距 */
  codePitch: number
  /** 渲染后多行公式中相邻两行的行距 */
  mathPitch: number
  /** 列表项之间 / 引用行之间的行距 */
  listPitch: number
  quotePitch: number
  /** 公式渲染成几行(.katex-base 数量) */
  mathLines: number
  /** 编辑器里找到的代码行数 */
  codeLines: number
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error(
      '拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs block-inner-spacing` 跑会自动带上)'
    )
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
  const note = join(vault, '块内间距.md')
  const settingsFile = join(ud, 'settings.json')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, DOC, 'utf8')
  await writeFile(
    settingsFile,
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: note,
        marketUrl: '',
        autoSaveMode: 'off',
        lineWrapping: true,
        editorFontSize: BODY,
        editorFontSizeVersion: 2,
        lineSpace: 1,
        codeLineSpace: 1,
        mathLineSpace: 1
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
  win.setContentSize(1100, 900)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  const ready = await waitFor(
    `document.querySelectorAll('.cm-md-math-display .katex-html > .katex-base').length >= 2`
  )
  check('编辑器渲染出两行公式', ready)

  const metrics = (): Promise<Metrics> =>
    evalJs<Metrics>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const bodyLines = lines.filter(el => /^正文甲第/.test(el.textContent || ''))
        const codeLines = lines.filter(el => /^const [abc]/.test(el.textContent || ''))
        const listLines = lines.filter(
          el => el.classList.contains('cm-md-list-line') && (el.textContent || '').trim()
        )
        const quoteLines = lines.filter(
          el => el.classList.contains('cm-md-quote') && (el.textContent || '').trim()
        )
        const top = el => el.getBoundingClientRect().top
        const pitch = els => {
          if (els.length < 2) return 0
          return Math.round(((top(els[els.length - 1]) - top(els[0])) / (els.length - 1)) * 100) / 100
        }
        /*
         * KaTeX 把一行里的公式拆成多个 .katex-base(inline-block),
         * 行与行之间用 .katex-newline(display:block)断开。按 newline 分组
         * 取每行第一个 base 的顶边,才是真正的「公式行距」。
         */
        const html = document.querySelector('.cm-md-math-display .katex-html')
        const lineTops = []
        let current = null
        if (html) {
          for (const el of html.children) {
            if (el.classList.contains('katex-newline')) {
              current = null
            } else if (el.classList.contains('katex-base')) {
              if (current === null) {
                current = Math.round(el.getBoundingClientRect().top * 100) / 100
                lineTops.push(current)
              }
            }
          }
        }
        return {
          bodyPitch: pitch(bodyLines),
          codePitch: pitch(codeLines),
          mathPitch: lineTops.length > 1 ? lineTops[1] - lineTops[0] : 0,
          listPitch: pitch(listLines),
          quotePitch: pitch(quoteLines),
          mathLines: lineTops.length,
          codeLines: codeLines.length
        }
      })()`)

  async function setVar(name: string, value: string): Promise<void> {
    await evalJs(`(() => {
      document.documentElement.style.setProperty('${name}', '${value}')
      return true
    })()`)
    await sleep(300)
  }

  const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol
  const fmt = (m: Metrics): string => JSON.stringify(m)

  console.log('\n【A / B】正文行距 vs 代码块 / 公式块行距')
  const base = await metrics()
  console.log(`     [1 / 1 / 1 档] ${fmt(base)}`)
  check('公式按源码的两行渲染', base.mathLines === 2, fmt(base))
  check('找到三行代码', base.codeLines === 3, fmt(base))
  check('正文段内行距 > 0', base.bodyPitch > 0, fmt(base))

  await setVar('--editor-line-space', '0.5')
  const bodySmall = await metrics()
  await setVar('--editor-line-space', '2')
  const bodyLarge = await metrics()
  console.log(`     [正文 0.5] ${fmt(bodySmall)}\n     [正文 2.0] ${fmt(bodyLarge)}`)
  check(
    '调正文行距:正文段内行距变小 / 变大',
    bodySmall.bodyPitch < base.bodyPitch - 2 && bodyLarge.bodyPitch > base.bodyPitch + 2,
    JSON.stringify({ base: base.bodyPitch, small: bodySmall.bodyPitch, large: bodyLarge.bodyPitch })
  )
  check(
    '调正文行距:代码块行距不动',
    near(bodySmall.codePitch, base.codePitch) && near(bodyLarge.codePitch, base.codePitch),
    JSON.stringify({ base: base.codePitch, small: bodySmall.codePitch, large: bodyLarge.codePitch })
  )
  check(
    '调正文行距:公式块行距不动',
    near(bodySmall.mathPitch, base.mathPitch) && near(bodyLarge.mathPitch, base.mathPitch),
    JSON.stringify({ base: base.mathPitch, small: bodySmall.mathPitch, large: bodyLarge.mathPitch })
  )
  check(
    '调正文行距:列表 / 引用行距不动',
    near(bodySmall.listPitch, base.listPitch) &&
      near(bodyLarge.listPitch, base.listPitch) &&
      near(bodySmall.quotePitch, base.quotePitch) &&
      near(bodyLarge.quotePitch, base.quotePitch),
    JSON.stringify({
      list: [base.listPitch, bodySmall.listPitch, bodyLarge.listPitch],
      quote: [base.quotePitch, bodySmall.quotePitch, bodyLarge.quotePitch]
    })
  )

  console.log('\n【C】代码块行距 / 公式块行距各管各的')
  await setVar('--editor-line-space', '1')
  await setVar('--editor-code-line-space', '0.2')
  const codeTight = await metrics()
  console.log(`     [代码 0.2] ${fmt(codeTight)}`)
  check(
    '调代码块行距:代码行距变小',
    codeTight.codePitch < base.codePitch - 4,
    JSON.stringify({ base: base.codePitch, tight: codeTight.codePitch })
  )
  check(
    '调代码块行距:正文 / 公式 / 列表 / 引用行距不动',
    near(codeTight.bodyPitch, base.bodyPitch) &&
      near(codeTight.mathPitch, base.mathPitch) &&
      near(codeTight.listPitch, base.listPitch) &&
      near(codeTight.quotePitch, base.quotePitch),
    JSON.stringify({
      body: [base.bodyPitch, codeTight.bodyPitch],
      math: [base.mathPitch, codeTight.mathPitch],
      list: [base.listPitch, codeTight.listPitch],
      quote: [base.quotePitch, codeTight.quotePitch]
    })
  )

  await setVar('--editor-code-line-space', '2.5')
  const codeLoose = await metrics()
  console.log(`     [代码 2.5] ${fmt(codeLoose)}`)
  check(
    '调代码块行距:代码行距变大',
    codeLoose.codePitch > base.codePitch + 8,
    JSON.stringify({ base: base.codePitch, loose: codeLoose.codePitch })
  )

  await setVar('--editor-code-line-space', '1')
  await setVar('--editor-math-line-space', '2.5')
  const mathLoose = await metrics()
  console.log(`     [公式 2.5] ${fmt(mathLoose)}`)
  check(
    '调公式块行距:公式行距变大',
    mathLoose.mathPitch > base.mathPitch + 8,
    JSON.stringify({ base: base.mathPitch, loose: mathLoose.mathPitch })
  )
  check(
    '调公式块行距:正文 / 代码 / 列表 / 引用行距不动',
    near(mathLoose.bodyPitch, base.bodyPitch) &&
      near(mathLoose.codePitch, base.codePitch) &&
      near(mathLoose.listPitch, base.listPitch) &&
      near(mathLoose.quotePitch, base.quotePitch),
    JSON.stringify({
      body: [base.bodyPitch, mathLoose.bodyPitch],
      code: [base.codePitch, mathLoose.codePitch],
      list: [base.listPitch, mathLoose.listPitch],
      quote: [base.quotePitch, mathLoose.quotePitch]
    })
  )
  await setVar('--editor-math-line-space', '0')
  const mathTight = await metrics()
  console.log(`     [公式 0] ${fmt(mathTight)}`)
  check(
    '调公式块行距:公式行距变小',
    mathTight.mathPitch < base.mathPitch - 2,
    JSON.stringify({ base: base.mathPitch, tight: mathTight.mathPitch })
  )

  console.log('\n【C2】列表 / 引用行距')
  await setVar('--editor-math-line-space', '1')
  await setVar('--editor-list-line-space', '2.5')
  const listLoose = await metrics()
  console.log(`     [列表 2.5] ${fmt(listLoose)}`)
  check(
    '调列表行距:列表行距变大',
    listLoose.listPitch > base.listPitch + 8,
    JSON.stringify({ base: base.listPitch, loose: listLoose.listPitch })
  )
  check(
    '调列表行距:正文 / 代码 / 公式 / 引用不动',
    near(listLoose.bodyPitch, base.bodyPitch) &&
      near(listLoose.codePitch, base.codePitch) &&
      near(listLoose.mathPitch, base.mathPitch) &&
      near(listLoose.quotePitch, base.quotePitch),
    JSON.stringify({
      body: [base.bodyPitch, listLoose.bodyPitch],
      code: [base.codePitch, listLoose.codePitch],
      math: [base.mathPitch, listLoose.mathPitch],
      quote: [base.quotePitch, listLoose.quotePitch]
    })
  )
  await setVar('--editor-list-line-space', '1')
  await setVar('--editor-quote-line-space', '0')
  const quoteTight = await metrics()
  console.log(`     [引用 0] ${fmt(quoteTight)}`)
  check(
    '调引用行距:引用行距变小',
    quoteTight.quotePitch < base.quotePitch - 2,
    JSON.stringify({ base: base.quotePitch, tight: quoteTight.quotePitch })
  )
  check(
    '调引用行距:正文 / 代码 / 公式 / 列表不动',
    near(quoteTight.bodyPitch, base.bodyPitch) &&
      near(quoteTight.codePitch, base.codePitch) &&
      near(quoteTight.mathPitch, base.mathPitch) &&
      near(quoteTight.listPitch, base.listPitch),
    JSON.stringify({
      body: [base.bodyPitch, quoteTight.bodyPitch],
      code: [base.codePitch, quoteTight.codePitch],
      math: [base.mathPitch, quoteTight.mathPitch],
      list: [base.listPitch, quoteTight.listPitch]
    })
  )
  await setVar('--editor-quote-line-space', '1')

  console.log('\n【D】公式源码态的行距走公式块行距')
  await setVar('--editor-math-line-space', '1')
  await setVar('--editor-line-space', '1')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const pos = view.state.doc.toString().indexOf('a = b')
    view.dispatch({ selection: { anchor: pos + 2 } })
    view.focus()
    return true
  })()`)
  const srcReady = await waitFor(`document.querySelectorAll('.cm-line.cm-md-math-src-line').length >= 4`)
  check('光标进入公式后翻回源码态', srcReady)

  const sourcePitch = (): Promise<number> =>
    evalJs<number>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-line.cm-md-math-src-line')]
        if (lines.length < 3) return 0
        const a = lines[1].getBoundingClientRect().top
        const b = lines[2].getBoundingClientRect().top
        return Math.round((b - a) * 100) / 100
      })()`)

  // 用中间两条内容行量:首行 `$$` 还带着块间距的 padding-top
  const srcBase = await sourcePitch()
  await setVar('--editor-math-line-space', '2')
  const srcLoose = await sourcePitch()
  await setVar('--editor-math-line-space', '1')
  await setVar('--editor-line-space', '0.2')
  const srcBodyChanged = await sourcePitch()
  await setVar('--editor-line-space', '1')
  console.log(
    `     [源码 1 档] ${srcBase} | [公式 2 档] ${srcLoose} | [正文 0.2 档] ${srcBodyChanged}`
  )
  check('公式源码行距随「公式块行距」变大', srcLoose > srcBase + 4, JSON.stringify({ srcBase, srcLoose }))
  check('正文行距不改变公式源码行距', near(srcBodyChanged, srcBase), JSON.stringify({ srcBase, srcBodyChanged }))

  console.log('\n【F】正文 ↔ 公式块:前后两侧的距离一致')
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
  }

  const GAP_DOC = ['上方正文。', '', '$$', 'E = mc^2', '$$', '', '下方正文。', ''].join('\n')
  await loadDoc(GAP_DOC)
  await waitFor(`document.querySelector('.cm-md-math-display .katex')`)

  const gapMetrics = (): Promise<Record<string, number>> =>
    evalJs<Record<string, number>>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const above = lines.find(el => (el.textContent || '').includes('上方正文'))
        const below = lines.find(el => (el.textContent || '').includes('下方正文'))
        const range = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect()
        }
        const sourceLines = [...document.querySelectorAll('.cm-md-math-src-line')]
        if (sourceLines.length > 0) {
          if (!above || !below) return {}
          const first = sourceLines[0]
          const last = sourceLines[sourceLines.length - 1]
          const a = range(above).bottom
          const b = range(below).top
          return {
            textAbove: Math.round((range(first).top - a) * 100) / 100,
            textBelow: Math.round((b - range(last).bottom) * 100) / 100,
            boxAbove: Math.round((first.getBoundingClientRect().top - a) * 100) / 100,
            boxBelow: Math.round((b - last.getBoundingClientRect().bottom) * 100) / 100
          }
        }
        const katex = document.querySelector('.cm-md-math-display .katex')
        if (!above || !below || !katex) return {}
        const a = range(above).bottom
        const b = range(below).top
        const k = katex.getBoundingClientRect()
        return {
          textAbove: Math.round((k.top - a) * 100) / 100,
          textBelow: Math.round((b - k.bottom) * 100) / 100,
          boxAbove: Math.round((k.top - a) * 100) / 100,
          boxBelow: Math.round((b - k.bottom) * 100) / 100
        }
      })()`)

  const rendered = await gapMetrics()
  console.log(`     [渲染态] ${JSON.stringify(rendered)}`)
  check(
    '渲染态:公式上下到正文的距离一致',
    !!rendered.textAbove && near(rendered.textAbove, rendered.textBelow ?? 0, 3),
    JSON.stringify(rendered)
  )

  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const pos = view.state.doc.toString().indexOf('E = mc^2')
    view.dispatch({ selection: { anchor: pos + 2 } })
    view.focus()
    return true
  })()`)
  await waitFor(`document.querySelectorAll('.cm-md-math-src-line').length >= 3`)
  const sourced = await gapMetrics()
  console.log(`     [源码态] ${JSON.stringify(sourced)}`)
  check(
    '源码态:文字到前后正文的距离一致',
    !!sourced.textAbove && near(sourced.textAbove, sourced.textBelow ?? 0, 3),
    JSON.stringify(sourced)
  )
  check(
    '源码态:公式块的背景上下留白一致',
    !!sourced.boxAbove && near(sourced.boxAbove, sourced.boxBelow ?? 0, 3),
    JSON.stringify(sourced)
  )

  console.log('\n【G】公式块:源码态与渲染态占用的高度一致')
  const SWAP_DOC = ['上方', '', '$$', 'aaaa', 'bbbb', '$$', '', '下方', ''].join('\n')
  await loadDoc(SWAP_DOC)
  await waitFor(`document.querySelector('.cm-md-math-display .katex')`)

  const modeMetrics = (): Promise<Record<string, number | string> | null> =>
    evalJs<Record<string, number | string> | null>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const above = lines.find(el => (el.textContent || '').trim() === '上方')
        const below = lines.find(el => (el.textContent || '').trim() === '下方')
        const range = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect()
        }
        if (!above || !below) return null
        const srcLines = [...document.querySelectorAll('.cm-md-math-src-line')]
        if (srcLines.length) {
          const first = srcLines[0].getBoundingClientRect()
          const last = srcLines[srcLines.length - 1].getBoundingClientRect()
          return {
            mode: 'source',
            aboveBottom: Math.round(range(above).bottom * 100) / 100,
            belowTop: Math.round(range(below).top * 100) / 100,
            blockTop: Math.round(first.top * 100) / 100,
            blockBottom: Math.round(last.bottom * 100) / 100,
            blockHeight: Math.round((last.bottom - first.top) * 100) / 100,
            span: Math.round((range(below).top - range(above).bottom) * 100) / 100
          }
        }
        const widget = document.querySelector('.cm-md-math-display')
        const widgetLine = widget?.closest('.cm-line')
        if (!widget || !widgetLine) return null
        const w = widget.getBoundingClientRect()
        const l = widgetLine.getBoundingClientRect()
        return {
          mode: 'rendered',
          aboveBottom: Math.round(range(above).bottom * 100) / 100,
          belowTop: Math.round(range(below).top * 100) / 100,
          blockTop: Math.round(l.top * 100) / 100,
          blockBottom: Math.round(l.bottom * 100) / 100,
          blockHeight: Math.round((l.bottom - l.top) * 100) / 100,
          widgetHeight: Math.round(w.height * 100) / 100,
          span: Math.round((range(below).top - range(above).bottom) * 100) / 100
        }
      })()`)

  const renderedMode = await modeMetrics()
  console.log(`     [渲染态] ${JSON.stringify(renderedMode)}`)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const pos = view.state.doc.toString().indexOf('aaaa')
    view.dispatch({ selection: { anchor: pos + 1 } })
    view.focus()
    return true
  })()`)
  await waitFor(`document.querySelectorAll('.cm-md-math-src-line').length >= 4`)
  const sourceMode = await modeMetrics()
  console.log(`     [源码态] ${JSON.stringify(sourceMode)}`)
  if (renderedMode && sourceMode) {
    check(
      '切换源码态 / 渲染态时下方正文不上下跳',
      near(Number(renderedMode.belowTop), Number(sourceMode.belowTop), 2),
      JSON.stringify({ rendered: renderedMode.belowTop, source: sourceMode.belowTop })
    )
    check(
      '公式块占用的高度一致',
      near(Number(renderedMode.blockHeight), Number(sourceMode.blockHeight), 2),
      JSON.stringify({ rendered: renderedMode.blockHeight, source: sourceMode.blockHeight })
    )
  } else {
    check('两种状态都能量到高度', false, JSON.stringify({ renderedMode, sourceMode }))
  }

  console.log('\n【H】列表行距只管列表内部,不影响列表 ↔ 正文的块间距离')
  const LIST_DOC = ['上方正文。', '', '- 列表甲', '- 列表乙', '- 列表丙', '', '下方正文。', ''].join(
    '\n'
  )
  await loadDoc(LIST_DOC)
  await waitFor(`document.querySelector('.cm-md-list-line')`)

  const listMetrics = (): Promise<Record<string, number> | null> =>
    evalJs<Record<string, number> | null>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const range = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect()
        }
        const above = lines.find(el => (el.textContent || '').includes('上方正文'))
        const below = lines.find(el => (el.textContent || '').includes('下方正文'))
        const list = lines.filter(
          el => el.classList.contains('cm-md-list-line') && (el.textContent || '').trim()
        )
        if (!above || !below || list.length < 2) return null
        const first = range(list[0])
        const last = range(list[list.length - 1])
        const tops = list.map(el => el.getBoundingClientRect().top)
        return {
          aboveGap: Math.round((first.top - range(above).bottom) * 100) / 100,
          belowGap: Math.round((range(below).top - last.bottom) * 100) / 100,
          listPitch: Math.round(((tops[tops.length - 1] - tops[0]) / (tops.length - 1)) * 100) / 100
        }
      })()`)

  const listBase = await listMetrics()
  await setVar('--editor-list-line-space', '2.5')
  const listLooseGap = await listMetrics()
  await setVar('--editor-list-line-space', '1')
  console.log(`     [列表 1] ${JSON.stringify(listBase)}\n     [列表 2.5] ${JSON.stringify(listLooseGap)}`)
  check(
    '调列表行距:列表内部行距变大',
    !!listBase &&
      !!listLooseGap &&
      listLooseGap.listPitch > listBase.listPitch + 8,
    JSON.stringify({ base: listBase, loose: listLooseGap })
  )
  check(
    '调列表行距:列表与上下正文的距离不变',
    !!listBase &&
      !!listLooseGap &&
      near(listLooseGap.aboveGap, listBase.aboveGap) &&
      near(listLooseGap.belowGap, listBase.belowGap),
    JSON.stringify({ base: listBase, loose: listLooseGap })
  )

  console.log('\n【H2】列表后面紧跟正文(懒续行):列表行距不影响这条缝')
  const LAZY_DOC = [
    '上方正文。',
    '',
    '- 列表甲',
    '- 列表乙',
    '- 列表丙',
    '紧跟列表的正文。',
    '',
    '下方正文。',
    ''
  ].join('\n')
  await loadDoc(LAZY_DOC)
  await waitFor(`document.querySelector('.cm-md-list-line')`)

  const lazyMetrics = (): Promise<Record<string, number> | null> =>
    evalJs<Record<string, number> | null>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const range = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect()
        }
        const above = lines.find(el => (el.textContent || '').includes('上方正文'))
        const lazy = lines.find(el => (el.textContent || '').includes('紧跟列表的正文'))
        const list = lines.filter(
          el => el.classList.contains('cm-md-list-line') && (el.textContent || '').trim()
        )
        if (!above || !lazy || list.length < 2) return null
        const first = range(list[0])
        const last = range(list[list.length - 1])
        const tops = list.map(el => el.getBoundingClientRect().top)
        return {
          aboveGap: Math.round((first.top - range(above).bottom) * 100) / 100,
          lazyGap: Math.round((range(lazy).top - last.bottom) * 100) / 100,
          listPitch: Math.round(((tops[tops.length - 1] - tops[0]) / (tops.length - 1)) * 100) / 100
        }
      })()`)

  const lazyBase = await lazyMetrics()
  await setVar('--editor-list-line-space', '2.5')
  const lazyLoose = await lazyMetrics()
  await setVar('--editor-list-line-space', '1')
  console.log(`     [懒续行 1] ${JSON.stringify(lazyBase)}\n     [懒续行 2.5] ${JSON.stringify(lazyLoose)}`)
  check(
    '懒续行:列表行距只改列表内部',
    !!lazyBase &&
      !!lazyLoose &&
      lazyLoose.listPitch > lazyBase.listPitch + 8 &&
      near(lazyLoose.aboveGap, lazyBase.aboveGap) &&
      near(lazyLoose.lazyGap, lazyBase.lazyGap),
    JSON.stringify({ base: lazyBase, loose: lazyLoose })
  )

  console.log('\n【E】设置面板:样式 = 间距 / 块间间距 / 块内间距 / 自定义样式')
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '样式')
      ?.click()`)
  await waitFor(`document.querySelector('[data-spacing-ring]')`)
  interface StyleLayout {
    pageTitle: string
    sections: string[]
    subsections: number
    hasRing: boolean
    hasCode: boolean
    hasMath: boolean
    hasList: boolean
    hasQuote: boolean
    hasFont: boolean
    hasLine: boolean
    globalResetInSpace: boolean
    globalResetInBetween: boolean
    firstRow: string
    hasUserStyle: boolean
    ringOrder: string
    ringCodeLabel: string
    selectionResetLabel: string
    blockResetLabel: string
    selectionResetDisabled: boolean
    blockResetDisabled: boolean
    globalResetDisabled: boolean
  }
  const layout = await evalJs<StyleLayout | null>(`
    (() => {
      const title = document.querySelector('.settings-dialog h1')?.textContent.trim() ?? ''
      const sections = [...document.querySelectorAll('.settings-section')]
      const byTitle = name =>
        sections.find(s => s.querySelector('.settings-section-title')?.textContent.trim() === name)
      const space = byTitle('间距')
      const between = byTitle('块间间距')
      const inner = byTitle('块内间距')
      const custom = byTitle('自定义样式')
      if (!space || !between || !inner || !custom) return null
      const firstCard = space.querySelector('.settings-card')
      return {
        pageTitle: title,
        sections: sections.map(s => s.querySelector('.settings-section-title')?.textContent.trim() ?? ''),
        subsections: document.querySelectorAll('.settings-subsection-title').length,
        hasRing: !!between.querySelector('[data-spacing-ring]'),
        hasCode: !!inner.querySelector('input[data-code-line-space]'),
        hasMath: !!inner.querySelector('input[data-math-line-space]'),
        hasList: !!inner.querySelector('input[data-list-line-space]'),
        hasQuote: !!inner.querySelector('input[data-quote-line-space]'),
        hasFont: [...space.querySelectorAll('.settings-row-title')]
          .some(el => el.textContent.trim() === '正文字号'),
        hasLine: !!space.querySelector('input[data-line-space="lineSpace"]'),
        globalResetInSpace: !!space.querySelector('[data-spacing-reset="all"]'),
        globalResetInBetween: !!between.querySelector('[data-spacing-reset="all"]'),
        firstRow: firstCard?.querySelector('.settings-row-title')?.textContent.trim() ?? '',
        hasUserStyle: !!custom,
        ringOrder: [...document.querySelectorAll('.spacing-ring-node')]
          .map(el => el.getAttribute('data-block-node') ?? '')
          .join(','),
        ringCodeLabel:
          document.querySelector('[data-block-node="code"] .spacing-ring-label')
            ?.textContent.trim() ?? '',
        selectionResetLabel:
          between.querySelector('[data-spacing-reset="selection"]')?.textContent.trim() ?? '',
        blockResetLabel: inner.querySelector('.settings-reset')?.textContent.trim() ?? '',
        selectionResetDisabled:
          between.querySelector('[data-spacing-reset="selection"]')?.disabled ?? false,
        blockResetDisabled: inner.querySelector('.settings-reset')?.disabled ?? false,
        globalResetDisabled: space.querySelector('[data-spacing-reset="all"]')?.disabled ?? false
      }
    })()`)
  console.log(`     [页面] ${JSON.stringify(layout)}`)
  check('「样式」是和「外观」同级的左栏页面', layout?.pageTitle === '样式', JSON.stringify(layout))
  check(
    '样式页依次是 间距 / 块间间距 / 块内间距 / 自定义样式',
    JSON.stringify(layout?.sections) ===
      JSON.stringify(['间距', '块间间距', '块内间距', '自定义样式']),
    JSON.stringify(layout?.sections)
  )
  check('块间 / 块内各自是页内顶级节', layout?.subsections === 0, JSON.stringify(layout))
  check('正文字号在「间距」节里', layout?.hasFont === true, JSON.stringify(layout))
  check('「间距」节里没有行间距滑块', layout?.hasLine === false, JSON.stringify(layout))
  check('正文字号是「间距」节的第一行', layout?.firstRow === '正文字号', JSON.stringify(layout))
  check(
    '「恢复全局默认样式」在正文字号下面',
    layout?.globalResetInSpace === true && layout?.globalResetInBetween === false,
    JSON.stringify(layout)
  )
  check('块间间距内容(圆环)在「块间间距」节里', layout?.hasRing === true, JSON.stringify(layout))
  check(
    '块内间距内容在「块内间距」节里(代码 / 公式 / 列表 / 引用)',
    layout?.hasCode === true &&
      layout?.hasMath === true &&
      layout?.hasList === true &&
      layout?.hasQuote === true,
    JSON.stringify(layout)
  )
  check('自定义样式在「自定义样式」节里', layout?.hasUserStyle === true, JSON.stringify(layout))
  check(
    '圆环里代码块与表格换了位置',
    layout?.ringOrder ===
      'body,heading,table,list,quote,image,code,math,mermaid',
    JSON.stringify(layout?.ringOrder)
  )
  check('圆环里写作「代码」', layout?.ringCodeLabel === '代码', JSON.stringify(layout?.ringCodeLabel))
  check(
    '两处恢复按钮都叫「恢复默认样式」',
    layout?.selectionResetLabel === '恢复默认样式' &&
      layout?.blockResetLabel === '恢复默认样式',
    JSON.stringify({ selection: layout?.selectionResetLabel, block: layout?.blockResetLabel })
  )
  check(
    '默认值下三个恢复按钮都不可点',
    layout?.selectionResetDisabled === true &&
      layout?.blockResetDisabled === true &&
      layout?.globalResetDisabled === true,
    JSON.stringify({
      selection: layout?.selectionResetDisabled,
      block: layout?.blockResetDisabled,
      global: layout?.globalResetDisabled
    })
  )

  // 行间距:连点两次「正文」后出现在配对面板里
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await sleep(150)
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await waitFor(`document.querySelector('[data-pair-mode="self"]')`)
  const pairFields = await evalJs<string[]>(`
    [...document.querySelectorAll('[data-pair-panel] [data-space-field]')]
      .map(el => el.getAttribute('data-space-field') ?? '')`)
  const pairLine = await evalJs<boolean>(
    `!!document.querySelector('[data-pair-panel] input[data-line-space="lineSpace"]')`
  )
  console.log(`     [正文自身配对] ${JSON.stringify(pairFields)}`)
  check(
    '点两次正文:行间距在前、段间距在后',
    JSON.stringify(pairFields) === JSON.stringify(['lineSpace', 'body-body']) && pairLine,
    JSON.stringify({ pairFields, pairLine })
  )
  const swapState = await evalJs<{ exists: boolean; disabled: boolean }>(`
    (() => {
      const button = document.querySelector('[data-ring-swap]')
      return { exists: !!button, disabled: button?.disabled === true }
    })()`)
  check(
    '同类配对时「交换上下」按钮可见但不可点',
    swapState.exists && swapState.disabled,
    JSON.stringify(swapState)
  )
  check(
    '选中一条默认边界时恢复按钮仍不可点',
    await evalJs<boolean>(
      `document.querySelector('[data-spacing-reset="selection"]')?.disabled === true`
    )
  )

  const readouts = await evalJs<{
    code: string
    math: string
    list: string
    quote: string
  }>(`
    (() => {
      const find = title =>
        [...document.querySelectorAll('.settings-row')]
          .find(r => r.querySelector('.settings-row-title')?.textContent.trim() === title)
          ?.querySelector('.settings-readout')?.textContent.trim() ?? ''
      return {
        code: find('代码块行距'),
        math: find('公式块行距'),
        list: find('列表行距'),
        quote: find('引用行距')
      }
    })()`)
  console.log(`     [读数] ${JSON.stringify(readouts)}`)
  check(
    `字号 ${BODY} 时四档默认都读作 ${BODY} px`,
    [readouts.code, readouts.math, readouts.list, readouts.quote].every(
      value => value === `1.0 档 · ${BODY} px`
    ),
    JSON.stringify(readouts)
  )

  async function setSlider(selector: string, value: number): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (!input) return false
      input.value = '${value}'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    return ok
  }

  check('代码块行距滑块存在', await setSlider('input[data-code-line-space]', 2))
  check('公式块行距滑块存在', await setSlider('input[data-math-line-space]', 2.5))
  check('列表行距滑块存在', await setSlider('input[data-list-line-space]', 1.5))
  check('引用行距滑块存在', await setSlider('input[data-quote-line-space]', 0.5))
  const vars = await evalJs<{ code: string; math: string; list: string; quote: string }>(`(() => {
    const read = name =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return {
      code: read('--editor-code-line-space'),
      math: read('--editor-math-line-space'),
      list: read('--editor-list-line-space'),
      quote: read('--editor-quote-line-space')
    }
  })()`)
  console.log(`     [根变量] ${JSON.stringify(vars)}`)
  check(
    '四个滑块写出根变量(2 / 2.5 / 1.5 / 0.5)',
    vars.code === '2' && vars.math === '2.5' && vars.list === '1.5' && vars.quote === '0.5',
    JSON.stringify(vars)
  )

  const resetable = await evalJs<{ block: boolean; global: boolean; selection: boolean }>(`
    (() => {
      const section = name =>
        [...document.querySelectorAll('.settings-section')]
          .find(s => s.querySelector('.settings-section-title')?.textContent.trim() === name)
      const block = section('块内间距')?.querySelector('.settings-reset')
      const global = document.querySelector('[data-spacing-reset="all"]')
      const selection = document.querySelector('[data-spacing-reset="selection"]')
      return {
        block: block?.disabled === false,
        global: global?.disabled === false,
        selection: selection?.disabled === true
      }
    })()`)
  check(
    '改动块内间距后,块内 / 全局恢复按钮可点',
    resetable.block === true && resetable.global === true,
    JSON.stringify(resetable)
  )
  check('段间距没变时,选中边界仍不可恢复', resetable.selection === true, JSON.stringify(resetable))

  await sleep(400)
  const saved = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
  check(
    '四档都写进了 settings.json',
    saved.codeLineSpace === 2 &&
      saved.mathLineSpace === 2.5 &&
      saved.listLineSpace === 1.5 &&
      saved.quoteLineSpace === 0.5,
    JSON.stringify({
      codeLineSpace: saved.codeLineSpace,
      mathLineSpace: saved.mathLineSpace,
      listLineSpace: saved.listLineSpace,
      quoteLineSpace: saved.quoteLineSpace
    })
  )

  // 块内间距的「恢复默认样式」:四档一起回到 1
  await evalJs(`
    (() => {
      const section = [...document.querySelectorAll('.settings-section')]
        .find(s => s.querySelector('.settings-section-title')?.textContent.trim() === '块内间距')
      section?.querySelector('.settings-reset')?.click()
      return true
    })()`)
  await sleep(500)
  const afterReset = await evalJs<Record<string, string>>(`(() => {
    const read = name =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return {
      code: read('--editor-code-line-space'),
      math: read('--editor-math-line-space'),
      list: read('--editor-list-line-space'),
      quote: read('--editor-quote-line-space')
    }
  })()`)
  check(
    '恢复默认后四档都回到 1',
    Object.values(afterReset).every(value => value === '1'),
    JSON.stringify(afterReset)
  )

  // 外观页不再承载间距:切回去确认只剩主题
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '外观')
      ?.click()`)
  await sleep(400)
  const appearance = await evalJs<{ hasRing: boolean; hasBase: boolean; pageTitle: string }>(`
    (() => ({
      pageTitle: document.querySelector('.settings-dialog h1')?.textContent.trim() ?? '',
      hasRing: !!document.querySelector('[data-spacing-ring]'),
      hasBase: [...document.querySelectorAll('.settings-section-title')]
        .some(el => el.textContent.trim() === '主题')
    }))()`)
  console.log(`     [外观页] ${JSON.stringify(appearance)}`)
  check(
    '外观页只保留主题,间距控制都在样式页',
    appearance.pageTitle === '外观' && appearance.hasBase && !appearance.hasRing,
    JSON.stringify(appearance)
  )

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
