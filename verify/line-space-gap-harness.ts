/**
 * 验收:调「行间距」不再改变段与段之间的距离。
 *
 * 用户报告:在设置 → 样式 → 块间间距(连点两次「正文」)里把行间距从 0.6 档
 * 调到 1.4 档,两段正文之间的距离也跟着变大 —— 行间距本该只管「同一段里行与行之间」。
 *
 * 行高的模型是 行盒 = (1 + 行间距档) × 字号,多出来的那一份在文字上下各分
 * 一半。段落首行 / 末行也会分到这两半,于是调行间距就把段间距一起推大。
 * 结构空行现在完全折叠,段落面向另一段正文的一侧用 text-box-trim 裁掉这
 * 半份行距(见 rules.ts 的 styleParagraphTrim 与 editor.css 的
 * cm-md-para-trim-*),断言:
 *   · 0.6 / 1.0 / 1.4 档下,两段正文的文字距离保持不变;
 *   · 两段之间的距离就是配对间距(默认 1 档 = 16px);
 *   · 结构空行收成零高度,连排空行不会叠出更多间距;
 *   · 同一段内行与行之间的距离仍然随行间距变大(功能没丢);
 *   · 「段间距」滑块照常改变段与段的距离。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs line-space-gap
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
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 两段正文,中间一条结构空行(渲染时折叠成配对间距) */
const PARAS = '第一段正文。\n\n第二段正文。\n\n第三段正文。\n'
/** 同一个段落里的三行(源码行首尾相接,没有空行) */
const LINES = '同一段第一行\n同一段第二行\n同一段第三行\n'

interface Metrics {
  /** 相邻依次两段文字之间的空白:上一段文字底 → 下一段文字顶 */
  gaps: number[]
  /** 同一段内相邻两行文字的行距(上一行文字顶 → 下一行文字顶) */
  advances: number[]
  /** 文字字形盒的高度(随字体固定,不随行高变) */
  lineHeights: number[]
  /** 每一行行盒的高度(= (1+行间距档)×字号,段落首尾行按边裁切) */
  boxHeights: number[]
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs line-space-gap` 跑会自动带上)')
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
  await writeFile(note, PARAS, 'utf8')
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
        lineWrapping: false,
        editorFontSize: 16,
        editorFontSizeVersion: 2
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  // 行首「+」来自内置 advanced-edit 贡献的菜单条目;不装内置扩展就没有按钮
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

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
    await sleep(1100)
    await focusEditor()
  }

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} } })
      view.focus()
      return true
    })()`)
    await sleep(120)
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(250)
  }

  /** 改根元素上的档位变量(与设置面板写的是同一组变量) */
  async function setVars(lineSpace: number, bodyGap: number): Promise<void> {
    await evalJs(`(() => {
      const root = document.documentElement
      root.style.setProperty('--editor-line-space', '${lineSpace}')
      root.style.setProperty('--md-gap-body-body', '${bodyGap}')
      return true
    })()`)
    await sleep(250)
  }

  const metrics = (): Promise<Metrics> =>
    evalJs<Metrics>(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const textLines = []
        for (const el of lines) {
          /*
           * 只量行里的**正文文字**:绝对定位的行首「+」按钮也算在 textContent
           * 里(它的文字是一个 "+"),整行范围还会被按钮的盒子撑到左上方 ——
           * 光标行恰好是空行时,会被误当成一条有字的正文行。
           */
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let first = null
          let last = null
          let text = ''
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const parent = n.parentElement
            if (parent && parent.closest('.cm-widget, .line-plus, .line-plus-anchor')) continue
            text += n.textContent ?? ''
            if (!n.textContent) continue
            if (!first) first = n
            last = n
          }
          if (!first || !last || !/\\S/.test(text)) continue
          const range = document.createRange()
          range.setStart(first, 0)
          range.setEnd(last, last.textContent.length)
          const r = range.getBoundingClientRect()
          if (r.height > 0) textLines.push({ el, r })
        }
        const gaps = []
        for (let i = 1; i < textLines.length; i++) {
          gaps.push(Math.round((textLines[i].r.top - textLines[i - 1].r.bottom) * 100) / 100)
        }
        const advances = []
        for (let i = 1; i < textLines.length; i++) {
          advances.push(Math.round((textLines[i].r.top - textLines[i - 1].r.top) * 100) / 100)
        }
        const lineHeights = textLines.map(t => Math.round(t.r.height * 100) / 100)
        const boxHeights = textLines.map(t => Math.round(t.el.getBoundingClientRect().height * 100) / 100)
        return { gaps, advances, lineHeights, boxHeights }
      })()`)

  const near = (a: number, b: number, tol = 1.5): boolean => Math.abs(a - b) <= tol
  const fmt = (m: Metrics): string => JSON.stringify(m)

  // ---------- 1. 两段正文之间:行间距变了,段距离不变 ----------

  console.log('\n【1】调行间距:两段正文之间的文字距离保持不变')
  await loadDoc(PARAS)
  await setVars(1, 1)
  const base = await metrics()
  console.log(`     [1.0 档] ${fmt(base)}`)
  check(
    '默认 1 档:两段文字之间的距离 = 1 档(16px)',
    base.gaps.every(g => near(g, 16)),
    fmt(base)
  )

  await setVars(0.6, 1)
  const small = await metrics()
  console.log(`     [0.6 档] ${fmt(small)}`)
  check(
    '0.6 档:段与段的文字距离与 1 档相同',
    small.gaps.length === base.gaps.length && small.gaps.every((g, i) => near(g, base.gaps[i])),
    fmt({ base: base.gaps, small: small.gaps })
  )
  check(
    '0.6 档:段与段之间仍只有 1 档(16px)',
    small.gaps.every(g => near(g, 16)),
    fmt(small.gaps)
  )

  await setVars(1.4, 1)
  const large = await metrics()
  console.log(`     [1.4 档] ${fmt(large)}`)
  check(
    '1.4 档:段与段的文字距离仍与 1 档相同',
    large.gaps.length === base.gaps.length && large.gaps.every((g, i) => near(g, base.gaps[i])),
    fmt({ base: base.gaps, large: large.gaps })
  )
  check(
    '1.4 档:段与段之间仍只有 1 档(16px)',
    large.gaps.every(g => near(g, 16)),
    fmt(large.gaps)
  )

  // ---------- 2. 段间距滑块仍能拉开两段 ----------

  console.log('\n【2】「段间距」滑块照常改变段与段的距离')
  await setVars(1, 2)
  const body2 = await metrics()
  console.log(`     [段间距 2 档] ${fmt(body2)}`)
  check(
    '段间距 2 档:两段文字之间的距离 = 2 档(32px)',
    body2.gaps.every(g => near(g, 32)),
    fmt(body2.gaps)
  )
  check(
    '段间距 2 档:两段文字之间的距离相应变大',
    body2.gaps.every((g, i) => near(g, base.gaps[i] + 16)),
    fmt({ base: base.gaps, body2: body2.gaps })
  )

  // ---------- 3. 同一段内的行距仍随行间距变化 ----------

  console.log('\n【3】同一段内行与行之间:行间距照常生效')
  await loadDoc(LINES)
  await setVars(0.6, 1)
  const tight = await metrics()
  console.log(`     [段内 0.6 档] ${fmt(tight)}`)
  await setVars(1.4, 1)
  const loose = await metrics()
  console.log(`     [段内 1.4 档] ${fmt(loose)}`)
  check(
    '段内行距随行间距变大(0.6 → 1.4)',
    tight.advances.length > 0 &&
      loose.advances.length === tight.advances.length &&
      loose.advances.every((a, i) => a > tight.advances[i] + 4),
    fmt({ tight: tight.advances, loose: loose.advances })
  )
  check(
    '段内行盒高度按 (1+档)×字号 变化(段落首尾行按边裁切)',
    near(tight.boxHeights[1], 25.6, 2) && near(loose.boxHeights[1], 38.4, 2),
    fmt({ tight: tight.boxHeights, loose: loose.boxHeights })
  )

  // ---------- 4. 连排空行 / 回车建出的空段落:同样不随行间距移动 ----------

  console.log('\n【4】连排结构空行:两段文字的距离不随行间距变化')
  // 两条空行 = 普通段落分隔(结构空行);三条以上会还原出空段落,见【5】与
  // empty-line-persist 用例
  await loadDoc('阿\n\n\n阿\n')
  await setVars(0.6, 1)
  const blanksTight = await metrics()
  await setVars(1.4, 1)
  const blanksLoose = await metrics()
  console.log(`     [连排 0.6] ${fmt(blanksTight)}\n     [连排 1.4] ${fmt(blanksLoose)}`)
  check(
    '两条结构空行连排:行间距变化时两段文字距离不变',
    blanksTight.gaps.length === 1 &&
      blanksLoose.gaps.length === 1 &&
      near(blanksTight.gaps[0], blanksLoose.gaps[0]),
    fmt({ tight: blanksTight.gaps, loose: blanksLoose.gaps })
  )
  check(
    '结构空行折叠成配对间距本身(16px)',
    near(blanksTight.gaps[0], 16),
    fmt(blanksTight.gaps)
  )

  console.log('\n【5】回车建出的空段落:两段文字的距离不随行间距变化')
  await loadDoc('阿\n\n阿\n')
  await setCaret(1)
  await key('Enter')
  await setVars(0.6, 1)
  const keptTight = await metrics()
  await setVars(1.4, 1)
  const keptLoose = await metrics()
  console.log(`     [空段落 0.6] ${fmt(keptTight)}\n     [空段落 1.4] ${fmt(keptLoose)}`)
  check(
    '回车空段落夹在中间时,行间距变化不移动两段文字',
    keptTight.gaps.length === 1 &&
      keptLoose.gaps.length === 1 &&
      near(keptTight.gaps[0], keptLoose.gaps[0]),
    fmt({ tight: keptTight.gaps, loose: keptLoose.gaps })
  )

  /*
   * 空段落上面还是空段落时,配对间距不能"找不到非空块"就跳过:
   * 用户在第一行按回车,得到的就是两个空段落,第二条光标的落点必须和
   * 「第一行有字,再回车」时一样,否则两条光标会贴在一起。
   */
  console.log('\n【5b】空文档里按回车:两个空段落之间也要有配对间距')
  const caretLayout = (): Promise<{
    gap: number
    caretLine: number
    caretCls: string
    caretPad: number
  }> =>
    evalJs(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const caret = v.state.selection.main.head
        const caretLine = v.state.doc.lineAt(caret)
        if (caretLine.number < 2) return { gap: -1, caretLine: caretLine.number, caretCls: '', caretPad: -1 }
        const first = v.state.doc.line(1)
        const a = v.coordsAtPos(first.from)
        const b = v.coordsAtPos(caretLine.from)
        // .cm-line 与文档行一一对应(折叠行也是元素)
        const el = document.querySelectorAll('.cm-content .cm-line')[caretLine.number - 1]
        return {
          gap: a && b ? Math.round((b.top - a.top) * 100) / 100 : -1,
          caretLine: caretLine.number,
          caretCls: el ? el.className : '',
          caretPad: el ? parseFloat(getComputedStyle(el).paddingTop) : -1
        }
      })()`)

  await loadDoc('啊\n')
  await setCaret(1)
  await key('Enter')
  const textGap = await caretLayout()

  await loadDoc('')
  await setCaret(0)
  await key('Enter')
  const emptyGap = await caretLayout()
  console.log(`     [有字] ${JSON.stringify(textGap)}\n     [空行] ${JSON.stringify(emptyGap)}`)
  check(
    '第一行为空时按回车:两行光标的距离与第一行有字时一致',
    textGap.gap > 0 && emptyGap.gap > 0 && near(textGap.gap, emptyGap.gap, 2),
    JSON.stringify({ textGap, emptyGap })
  )
  check(
    '回车建出的空段落按 body-body 配对留白(不是零间距)',
    /cm-md-body-body/.test(emptyGap.caretCls) && emptyGap.caretPad > 0,
    JSON.stringify(emptyGap)
  )

  /*
   * 同一行的下一步:空段落敲成标题。
   *
   * 空着时按 body-body 预加了配对间距,敲下 `#` 后必须沿 body-heading
   * 拿到同一条边的留白(见 rules.ts 的 styleBlockPair 与 build.ts 的
   * trimForEmpty),否则整行会少一档上留白、行首「+」往上一跳。
   * 第一行有字时上方有正文块、配对本来就对,只有文首这两条空段落会犯。
   */
  console.log('\n【5c】空文档回车后输入 #:标题行不少一档留白、加号仍在文字中线')
  const plusBox = (): Promise<{
    dx: number
    dy: number
    delta: number
    cls: string
    pad: number
  }> =>
    evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const btn = document.querySelector('.line-plus')
        const line = btn ? btn.closest('.cm-line') : null
        if (!btn || !line) return { dx: NaN, dy: NaN, delta: NaN, cls: '', pad: -1 }
        const lr = line.getBoundingClientRect()
        const br = btn.getBoundingClientRect()
        const caret = view.coordsAtPos(view.state.selection.main.head)
        return {
          dx: Math.round((br.left - lr.left) * 10) / 10,
          dy: Math.round((br.top - lr.top) * 10) / 10,
          delta: caret
            ? Math.round(((br.top + br.height / 2) - (caret.top + caret.bottom) / 2) * 10) / 10
            : NaN,
          cls: line.className,
          pad: parseFloat(getComputedStyle(line).paddingTop) || 0
        }
      })()`)

  await loadDoc('')
  await setCaret(0)
  await key('Enter')
  const plusBefore = await plusBox()
  wc.sendInputEvent({ type: 'char', keyCode: '#' })
  await sleep(600)
  const plusHash = await plusBox()
  /*
   * 只敲 `#` 还不是标题(见 rules.ts 的 isPendingHeading):版式和配对间距
   * 都要停在正文状态,补上空格才切标题。
   */
  check(
    '只敲 # 时仍按正文排版(等空格)',
    !/(^|\s)cm-md-h1(\s|$)/.test(plusHash.cls),
    JSON.stringify(plusHash)
  )
  check(
    '只敲 # 时配对间距仍是 body-body',
    /(^|\s)cm-md-body-body(\s|$)/.test(plusHash.cls) && near(plusHash.pad, plusBefore.pad, 0.5),
    JSON.stringify({ plusBefore, plusHash })
  )
  wc.sendInputEvent({ type: 'char', keyCode: ' ' })
  await sleep(600)
  const plusAfter = await plusBox()
  console.log(
    `     [空行] ${JSON.stringify(plusBefore)}\n     [# 后] ${JSON.stringify(plusHash)}\n     [标题] ${JSON.stringify(plusAfter)}`
  )
  check(
    '输入 # 前后:加号都在文字行的垂直中线上(标题字号变大也跟着走)',
    Number.isFinite(plusBefore.delta) &&
      Number.isFinite(plusAfter.delta) &&
      Math.abs(plusBefore.delta) <= 1.5 &&
      Math.abs(plusAfter.delta) <= 1.5,
    JSON.stringify({ plusBefore, plusAfter })
  )
  check(
    '输入 # 前后:加号相对行首的水平位置不变',
    Number.isFinite(plusBefore.dx) && near(plusBefore.dx, plusAfter.dx, 0.5),
    JSON.stringify({ plusBefore, plusAfter })
  )
  check(
    '变成标题后仍按 body-heading 拿到配对间距(行盒没有少一档)',
    /(^|\s)cm-md-body-heading(\s|$)/.test(plusAfter.cls) &&
      plusAfter.pad > 0 &&
      near(plusBefore.pad, plusAfter.pad, 0.5),
    JSON.stringify({ plusBefore, plusAfter })
  )

  /*
   * 空文档 / 文首空行点进去:光标所在的那条空行必须撑成正文行。
   * 结构空行是 0 高 + overflow:hidden,折叠它会把光标和行首「+」一起裁掉
   * (用户报过:空文档里点进去,第一行看不到闪烁的光标)。
   */
  console.log('\n【5d】空文档 / 文首空行:光标所在行撑开,光标与「+」可见')
  const caretBox = (): Promise<{ lineH: number; cursorH: number; plusH: number; cls: string }> =>
    evalJs(`
      (() => {
        const cur = document.querySelector('.cm-cursor')
        const btn = document.querySelector('.line-plus')
        const line = btn ? btn.closest('.cm-line') : null
        return {
          lineH: line ? Math.round(line.getBoundingClientRect().height * 10) / 10 : -1,
          cursorH: cur ? Math.round(cur.getBoundingClientRect().height * 10) / 10 : -1,
          plusH: btn ? Math.round(btn.getBoundingClientRect().height * 10) / 10 : -1,
          cls: line ? line.className : ''
        }
      })()`)

  await loadDoc('\n\n')
  await setCaret(0)
  const blankCaret = await caretBox()
  console.log(`     [空行文档] ${JSON.stringify(blankCaret)}`)
  check(
    '光标落在文首空行:所在行撑成整行(不是 0 高的结构空行)',
    blankCaret.lineH > 10 && !/(^|\s)cm-md-structural-blank(\s|$)/.test(blankCaret.cls),
    JSON.stringify(blankCaret)
  )
  check('光标有可见高度', blankCaret.cursorH > 10, JSON.stringify(blankCaret))
  check('行首「+」没有被折叠行裁掉', blankCaret.plusH > 10, JSON.stringify(blankCaret))

  /*
   * 行首「+」的垂直位置:必须落在这一行**文字**的垂直中线上。
   * 行盒高度随字号 / 行间距 / text-box-trim / 标题上留白 / 代码块上方的
   * 下留白变化,按钮不能写死 top —— 用光标矩形(文字行)当基准。
   */
  console.log('\n【5e】行首「+」在文字行里垂直居中(含折行)')
  await loadDoc(
    ['正文一行', '', '# 标题', '', '上一行', '', '```ts', 'const x = 1', '```', '', '很长'.repeat(120), ''].join(
      '\n'
    )
  )
  const plusDelta = (
    lineNumber: number,
    at: 'start' | 'end' = 'end'
  ): Promise<{ delta: number; lineH: number }> =>
    evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const line = view.state.doc.line(${lineNumber})
        view.dispatch({ selection: { anchor: ${at === 'start' ? 'line.from' : 'line.to'} } })
        view.focus()
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
          const btn = document.querySelector('.line-plus')
          const el = btn ? btn.closest('.cm-line') : null
          const caret = view.coordsAtPos(view.state.selection.main.head)
          if (!btn || !el || !caret) return resolve({ delta: NaN, lineH: -1 })
          const br = btn.getBoundingClientRect()
          resolve({
            delta: Math.round(((br.top + br.height / 2) - (caret.top + caret.bottom) / 2) * 10) / 10,
            lineH: Math.round(el.getBoundingClientRect().height * 10) / 10
          })
        })))
      })()`)

  await sleep(350)
  const body = await plusDelta(1)
  const head = await plusDelta(3)
  const aboveCode = await plusDelta(5)
  const wrapped = await plusDelta(11, 'start')
  console.log(
    `     [正文] ${body.delta}px [标题] ${head.delta}px [代码块上一行] ${aboveCode.delta}px ` +
      `[折行首行] ${wrapped.delta}px(行高 ${wrapped.lineH})`
  )
  check('正文行:加号中心与文字行中心对齐', Math.abs(body.delta) <= 1.5, JSON.stringify(body))
  check('标题行:加号中心与标题文字行中心对齐', Math.abs(head.delta) <= 1.5, JSON.stringify(head))
  check('代码块上一行(有下留白):加号仍居中', Math.abs(aboveCode.delta) <= 1.5, JSON.stringify(aboveCode))
  check(
    '折行正文:加号对齐第一行文字,不落在整段中间',
    wrapped.lineH > 30 && Math.abs(wrapped.delta) <= 1.5,
    JSON.stringify(wrapped)
  )

  /*
   * 行首回车得到空段落,再敲 `>`:引用要等 `> ` 才成立(见 rules 的
   * quoteOpened),在那之前这一行就是普通文本。它不能被当作结构空行折叠 ——
   * 0 高 + overflow:hidden 会让刚敲的 `>` 和光标一起消失,下面的正文
   * 也会跟着往上跳(用户报过)。
   */
  console.log('\n【5f】行首回车后敲 `>`:这一行要看得见,下面的正文不上移')
  /*
   * 把「正文之间」和「引用下方」两组配对间距设成不同的档:裸 `>` 还不算
   * 引用,下面的正文必须仍按「正文之间」排;一旦按引用算,文字会被垫高一档。
   */
  const setQuoteGaps = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const root = document.documentElement
      root.style.setProperty('--md-gap-body-body', '1')
      root.style.setProperty('--md-gap-quote-body', '2')
      return true
    })()`)
  const quoteLineState = (): Promise<{
    doc: string
    gt: { cls: string; h: number; top: number } | null
    body: { top: number; textTop: number; cls: string } | null
    caretH: number
    quotes: number
  }> =>
    evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        const el = lines[0]
        const body = lines.find(l => (l.textContent || '').trim() === '啊')
        const cur = document.querySelector('.cm-cursor')
        const rect = el ? el.getBoundingClientRect() : null
        let textTop = -1
        if (body) {
          const r = document.createRange()
          r.selectNodeContents(body)
          textTop = Math.round(r.getBoundingClientRect().top * 10) / 10
        }
        return {
          doc: JSON.stringify(view.state.doc.toString()),
          gt: el && rect
            ? { cls: el.className, h: Math.round(rect.height * 10) / 10, top: Math.round(rect.top) }
            : null,
          body: body
            ? { top: Math.round(body.getBoundingClientRect().top), textTop, cls: body.className }
            : null,
          caretH: cur ? Math.round(cur.getBoundingClientRect().height * 10) / 10 : -1,
          quotes: document.querySelectorAll('.cm-content .cm-md-quote').length
        }
      })()`)

  await loadDoc('啊\n')
  await setQuoteGaps()
  await setCaret(0)
  await key('Enter')
  await sleep(250)
  const beforeQuote = await quoteLineState()
  wc.sendInputEvent({ type: 'char', keyCode: '>' })
  await sleep(500)
  const bare = await quoteLineState()
  console.log(
    `     [敲 > 前] ${JSON.stringify(beforeQuote)}\n     [裸 >] ${JSON.stringify(bare)}`
  )
  check(
    '敲 `>` 时下面的正文不动(文字位置不变)',
    !!beforeQuote.body && !!bare.body && near(beforeQuote.body.textTop, bare.body.textTop, 1),
    JSON.stringify({ beforeQuote, bare })
  )
  check(
    '裸 `>` 还不算引用:下面的正文仍按「正文之间」配对',
    !!bare.body && /(^|\s)cm-md-body-body(\s|$)/.test(bare.body.cls),
    JSON.stringify(bare.body)
  )
  check('裸 `>` 这一行有正常行高(没有被折叠成结构空行)', !!bare.gt && bare.gt.h > 10 &&
    !/(^|\s)cm-md-structural-blank(\s|$)/.test(bare.gt.cls), JSON.stringify(bare))
  check('裸 `>` 上有可见光标', bare.caretH > 10, JSON.stringify(bare))
  check(
    '下面的正文仍在 `>` 这一行下面(没有跳到第一行)',
    !!bare.gt && !!bare.body && bare.body.top > bare.gt.top,
    JSON.stringify(bare)
  )
  check('这之前还不按引用渲染', bare.quotes === 0, JSON.stringify(bare))

  wc.sendInputEvent({ type: 'char', keyCode: ' ' })
  await sleep(500)
  const opened = await quoteLineState()
  wc.sendInputEvent({ type: 'char', keyCode: 'x' })
  await sleep(500)
  const typed = await quoteLineState()
  console.log(`     [> 空格] ${JSON.stringify(opened)}\n     [> x] ${JSON.stringify(typed)}`)
  check('敲出 `> ` 后按引用渲染', opened.quotes >= 1, JSON.stringify(opened))
  check(
    '引用成立后按「引用下方」的配对间距排',
    !!opened.body && /(^|\s)cm-md-quote-body(\s|$)/.test(opened.body.cls),
    JSON.stringify(opened.body)
  )
  check(
    '继续输入后引用保持渲染,行仍在正文上方',
    typed.quotes >= 1 && !!typed.body && !!typed.gt && typed.body.top > typed.gt.top,
    JSON.stringify(typed)
  )

  /*
   * 代码块的上侧间距做在上一块末行的 padding-bottom 上。这一行如果同时
   * 是单行段落(自己还挂着 cm-md-body-body 的 padding-top),两条配类
   * 不能互相覆盖 —— 否则接入代码块的一瞬间上一段的段间距会被清零。
   */
  console.log('\n【5g】两段之后接代码块:上一段的段间距不能被代码配对清零')
  const paraPair = (): Promise<{ cls: string; padTop: number; padBottom: number; textGap: number } | null> =>
    evalJs(`
      (() => {
        const lines = [...document.querySelectorAll('.cm-content .cm-line')]
        // 光标行带行首「+」(widget 的 textContent 也是 "+"),按包含 啊 过滤
        const paras = lines.filter(l => (l.textContent || '').includes('啊'))
        if (paras.length < 2) return null
        const info = el => {
          const s = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          const padTop = parseFloat(s.paddingTop)
          // 段落首行裁过 top,文字顶 = 行盒顶 + padding-top
          return { padTop, padBottom: parseFloat(s.paddingBottom), textTop: r.top + padTop }
        }
        const a = info(paras[0])
        const b = info(paras[1])
        return {
          cls: paras[1].className,
          padTop: b.padTop,
          padBottom: b.padBottom,
          textGap: Math.round((b.textTop - a.textTop) * 100) / 100
        }
      })()`)
  await loadDoc('啊\n\n啊\n')
  const pairPlain = await paraPair()
  await loadDoc('啊\n\n啊\n\n```\n\n```\n')
  const pairWithCode = await paraPair()
  console.log(`     [无代码块] ${JSON.stringify(pairPlain)}\n     [接代码块] ${JSON.stringify(pairWithCode)}`)
  check(
    '接上代码块后两段文字的距离不变',
    !!pairPlain && !!pairWithCode && near(pairPlain.textGap, pairWithCode.textGap, 1),
    JSON.stringify({ pairPlain, pairWithCode })
  )
  check(
    '上一段自己仍有上侧段间距,与代码块的间距加在下侧',
    !!pairWithCode && pairWithCode.padTop > 0 && pairWithCode.padBottom > 0,
    JSON.stringify(pairWithCode)
  )

  // ---------- 6. 设置面板:拖行间距时,正文与预览都不移动 ----------

  console.log('\n【6】设置面板里拖「行间距」:正文位置与预览里的两段距离都不动')
  await loadDoc(PARAS)
  await evalJs(`document.querySelector('button[title^="设置"]')?.click()`)
  await waitFor(`document.querySelector('.settings-nav-item')`)
  await evalJs(`
    [...document.querySelectorAll('.settings-nav-item')]
      .find(b => b.textContent.trim() === '样式')
      ?.click()`)
  await waitFor(`document.querySelector('[data-spacing-preview]')`)
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await sleep(150)
  await evalJs(`document.querySelector('.spacing-ring-node[data-block-node="body"]')?.click()`)
  await waitFor(`document.querySelector('[data-pair-mode="self"]')`)

  /** 用面板上的滑块改行间距(同时更新 store 与根变量) */
  async function setLineSpaceBySlider(value: number): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const input = document.querySelector('input[data-line-space="lineSpace"]')
      if (!input) return false
      input.value = '${value}'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(350)
    return ok
  }

  interface PanelMetrics {
    /** 编辑器里第一段正文的文字上沿 */
    firstTextTop: number
    /** 预览里两个样本盒之间的距离(样本已裁到文字边,就是两段之间的距离) */
    previewBetween: number
    /** 预览里那条缝的实际高度 */
    previewGap: number
    /** 上样本里的行数(段内换行预览) */
    previewLines: number
    /** 上样本里第一行到第二行的行距 */
    previewAdvance: number
  }

  const panelMetrics = (): Promise<PanelMetrics | null> =>
    evalJs<PanelMetrics | null>(`
      (() => {
        const first = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').trim())
        const samples = [...document.querySelectorAll('.spacing-doc-sample')]
        const gap = document.querySelector('[data-preview-gap]')
        if (!first || samples.length < 2 || !gap) return null
        const textTop = el => {
          const r = document.createRange()
          r.selectNodeContents(el)
          return r.getBoundingClientRect().top
        }
        const lines = [...samples[0].querySelectorAll('.spacing-doc-body > div')]
        const s0 = samples[0].getBoundingClientRect()
        const s1 = samples[1].getBoundingClientRect()
        return {
          firstTextTop: Math.round(textTop(first) * 10) / 10,
          previewBetween: Math.round((s1.top - s0.bottom) * 10) / 10,
          previewGap: Math.round(parseFloat(getComputedStyle(gap).height) * 10) / 10,
          previewLines: lines.length,
          previewAdvance:
            lines.length > 1 ? Math.round((textTop(lines[1]) - textTop(lines[0])) * 10) / 10 : 0
        }
      })()`)

  check('行间距滑块可用', await setLineSpaceBySlider(1))
  const pm1 = await panelMetrics()
  console.log(`     [1.0 档] ${JSON.stringify(pm1)}`)
  check('设置面板里能同时量到正文与预览', !!pm1, JSON.stringify(pm1))
  const pm0 = await (async () => {
    check('拖到 0 档', await setLineSpaceBySlider(0))
    return panelMetrics()
  })()
  console.log(`     [0.0 档] ${JSON.stringify(pm0)}`)
  const pm14 = await (async () => {
    check('拖到 1.4 档', await setLineSpaceBySlider(1.4))
    return panelMetrics()
  })()
  console.log(`     [1.4 档] ${JSON.stringify(pm14)}`)
  if (pm1 && pm0 && pm14) {
    check(
      '编辑器正文没有上下移动(首行文字位置不变)',
      near(pm0.firstTextTop, pm1.firstTextTop, 2) && near(pm14.firstTextTop, pm1.firstTextTop, 2),
      JSON.stringify({ pm0: pm0.firstTextTop, pm1: pm1.firstTextTop, pm14: pm14.firstTextTop })
    )
    check(
      '预览里两段正文的距离不变',
      near(pm0.previewBetween, pm1.previewBetween, 2) &&
        near(pm14.previewBetween, pm1.previewBetween, 2),
      JSON.stringify({
        pm0: pm0.previewBetween,
        pm1: pm1.previewBetween,
        pm14: pm14.previewBetween
      })
    )
    check(
      '预览里那条缝的高度不随行间距变化',
      near(pm0.previewGap, pm1.previewGap, 1) && near(pm14.previewGap, pm1.previewGap, 1),
      JSON.stringify({ pm0: pm0.previewGap, pm1: pm1.previewGap, pm14: pm14.previewGap })
    )
    check(
      '预览上样本画了两行(段内换行可见)',
      pm1.previewLines === 2,
      JSON.stringify({ lines: pm1.previewLines })
    )
    check(
      '预览里段内两行的行距随行间距变大',
      pm14.previewAdvance > pm0.previewAdvance + 10,
      JSON.stringify({ pm0: pm0.previewAdvance, pm14: pm14.previewAdvance })
    )
  } else {
    check('设置面板里的量测齐全', false, JSON.stringify({ pm1, pm0, pm14 }))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
