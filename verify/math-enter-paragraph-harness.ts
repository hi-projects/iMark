/**
 * 复现:公式块末尾回车建段、输入文字,再点文字末尾时整段被顶下去。
 *
 * 步骤:
 *   1. 文档 `$$\na\n$$`,光标移到末尾,回车 → 新段;
 *   2. 在新段输入「阿」;
 *   3. 鼠标点在「阿」后面 → 观察段落位置与光标落点。
 *
 * 期望:点「阿」后面只把光标放到这一行末尾,公式块保持渲染,段落不位移,
 * 也不会落到公式块折叠掉的行上。
 *
 * 跑法:env -u ELECTRON_RUN_AS_NODE xvfb-run -a node verify/run.mjs math-enter-paragraph
 */

import { app, BrowserWindow, protocol } from 'electron'
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
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

/** 文件末尾带一个换行(用户的常见写法);在它后面回车/输入,公式与正文之间会留一条空行 */
const DOC = ['$$', 'a', '$$', ''].join('\n')

interface LineInfo {
  text: string
  cls: string
  top: number
  height: number
}

async function main(): Promise<void> {
  await app.whenReady()
  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'm.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, DOC, 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify({
      skipVaultPicker: true,
      vaultPath: vault,
      vaults: [vault],
      lastFile: note,
      marketUrl: '',
      autoSaveMode: 'off',
      lineWrapping: true,
      editorFontSize: 16,
      editorFontSizeVersion: 2
    }),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win = createMainWindow(settings)
  win.setContentSize(1000, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1200)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  const focusEditor = async (): Promise<void> => {
    await evalJs(`document.querySelector('.cm-content')?.focus()`)
  }

  const type = async (text: string): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(300)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
    }
  }

  const key = async (keyCode: string): Promise<void> => {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(300)
  }

  interface Snapshot {
    doc: string
    anchor: number
    line: number
    lineText: string
    lineCls: string
    widgets: number
    voids: number
    lines: LineInfo[]
  }

  const snapshot = (): Promise<Snapshot> =>
    evalJs<Snapshot>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const sel = v.state.selection.main
        const l = v.state.doc.lineAt(sel.head)
        const lines = [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
          const r = el.getBoundingClientRect()
          return {
            text: el.textContent,
            cls: el.className,
            top: Math.round(r.top * 10) / 10,
            height: Math.round(r.height * 10) / 10
          }
        })
        return {
          doc: v.state.doc.toString(),
          anchor: sel.head,
          line: l.number,
          lineText: l.text,
          lineCls: document.querySelector('.cm-content .cm-line:nth-child(' + l.number + ')')?.className ?? '',
          widgets: document.querySelectorAll('.cm-md-math-display').length,
          voids: document.querySelectorAll('.cm-content .cm-line.cm-md-math-void').length,
          lines
        }
      })()`)

  /** 点在「阿」行文字末尾右侧一点 */
  const clickAfter = async (text: string): Promise<boolean> => {
    const point = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const line = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => (el.textContent || '').includes(${JSON.stringify(text)}))
        if (!line) return null
        const r = line.getBoundingClientRect()
        const span = [...line.querySelectorAll('span')].find(s =>
          (s.textContent || '').includes(${JSON.stringify(text)}))
        const t = span ? span.getBoundingClientRect() : r
        return { x: Math.round(t.right + 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!point) return false
    const mouse = (type: string, buttons: number): Promise<boolean> =>
      evalJs<boolean>(`
        (() => {
          const target = ${JSON.stringify(type)} === 'mousedown'
            ? document.querySelector('.cm-content')
            : document
          target?.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: ${point.x},
            clientY: ${point.y},
            button: 0,
            buttons: ${buttons}
          }))
          return true
        })()`)
    await mouse('mousedown', 1)
    await sleep(80)
    await mouse('mouseup', 0)
    await sleep(500)
    return true
  }

  await focusEditor()
  // 光标放在收尾 `$$` 的行尾(不是文件末尾的空行)
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ selection: { anchor: v.state.doc.line(3).to } })
    return true
  })()`)
  await sleep(200)

  console.log('\n【A】公式块末尾回车,输入「阿」')
  const pre = await snapshot()
  console.log(`     [回车前] ${JSON.stringify(pre)}`)
  await key('Return')
  await sleep(400)
  const afterEnter = await snapshot()
  console.log(`     [回车后] ${JSON.stringify(afterEnter)}`)
  check('回车后文档多出空段', afterEnter.doc === `${DOC}\n`, JSON.stringify(afterEnter.doc))
  check('光标停在新段(第 5 行)', afterEnter.line === 5, JSON.stringify(afterEnter.line))

  await type('阿')
  const typed = await snapshot()
  console.log(`     [输入后] ${JSON.stringify(typed)}`)
  check(
    '「阿」落在第 5 行(公式与它之间隔着一条空行),公式保持渲染',
    typed.doc === `${DOC}\n阿` && typed.lineText === '阿' && typed.widgets === 1,
    JSON.stringify({ doc: typed.doc, lineText: typed.lineText, widgets: typed.widgets })
  )
  const beforeClick = typed

  console.log('\n【B】点「阿」后面')
  check('找到了「阿」并点击', await clickAfter('阿'))
  const clicked = await snapshot()
  console.log(`     [点击后] ${JSON.stringify(clicked)}`)
  check(
    '点击后公式仍是渲染态,不出现源码行',
    clicked.widgets === 1,
    JSON.stringify({ widgets: clicked.widgets, voids: clicked.voids })
  )
  check(
    '光标落在第 5 行末尾(没有落到公式折叠行或中间空行)',
    clicked.line === 5 && clicked.anchor === clicked.doc.length,
    JSON.stringify({ line: clicked.line, anchor: clicked.anchor, len: clicked.doc.length })
  )
  const lineBefore = beforeClick.lines.find(l => l.text.includes('阿'))
  const lineAfter = clicked.lines.find(l => l.text.includes('阿'))
  console.log(`     [阿的位置] before=${JSON.stringify(lineBefore)} after=${JSON.stringify(lineAfter)}`)
  check(
    '「阿」的位置没有因为点击而变化',
    !!lineBefore && !!lineAfter && Math.abs(lineAfter.top - lineBefore.top) <= 1,
    JSON.stringify({ before: lineBefore?.top, after: lineAfter?.top })
  )
  check(
    '没有多出可编辑的空白行(行数与输入后一致)',
    clicked.lines.length === beforeClick.lines.length,
    JSON.stringify({ before: beforeClick.lines.length, after: clicked.lines.length })
  )

  console.log('\n【C】点公式后面的收紧空行:光标改道到正文,空行不能被编辑')
  const gapPoint = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => el.classList.contains('cm-md-block-gap-body'))
      if (!line) return null
      const r = line.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  check('找得到公式后的结构空行', gapPoint !== null, JSON.stringify(gapPoint))
  if (gapPoint) {
    const mouse = (type: string, buttons: number): Promise<boolean> =>
      evalJs<boolean>(`
        (() => {
          const target = ${JSON.stringify(type)} === 'mousedown'
            ? document.querySelector('.cm-content')
            : document
          target?.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: ${gapPoint.x},
            clientY: ${gapPoint.y},
            button: 0,
            buttons: ${buttons}
          }))
          return true
        })()`)
    await mouse('mousedown', 1)
    await sleep(80)
    await mouse('mouseup', 0)
    await sleep(500)
    const gapClicked = await snapshot()
    console.log(`     [点空行后] ${JSON.stringify(gapClicked)}`)
    check(
      '光标改道到下面的正文行(没有停在空行上)',
      gapClicked.line === 5 && gapClicked.lineText === '阿' && gapClicked.anchor === 9,
      JSON.stringify({ line: gapClicked.line, anchor: gapClicked.anchor })
    )
    const beforeType = await snapshot()
    await type('x')
    const afterType = await snapshot()
    console.log(`     [在空行点击后打字] ${JSON.stringify(afterType.doc)}`)
    check(
      '在这条空行上打字只会落到正文行里,不会撑出新行',
      afterType.doc === '$$\na\n$$\n\nx阿' && afterType.lines.length === beforeType.lines.length,
      JSON.stringify({ doc: afterType.doc, lines: afterType.lines.length })
    )
  }

  console.log('\n【D】点公式进源码态,再点「阿」回渲染态:结构空行仍不可编辑')
  {
    const widgetPoint = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const w = document.querySelector('.cm-md-math-display')?.getBoundingClientRect()
        return w ? { x: Math.round(w.left + w.width / 2), y: Math.round(w.top + w.height / 2) } : null
      })()`)
    check('找得到公式 widget', widgetPoint !== null, JSON.stringify(widgetPoint))
    if (widgetPoint) {
      wc.sendInputEvent({
        type: 'mouseDown',
        x: widgetPoint.x,
        y: widgetPoint.y,
        button: 'left',
        clickCount: 1
      })
      wc.sendInputEvent({
        type: 'mouseUp',
        x: widgetPoint.x,
        y: widgetPoint.y,
        button: 'left',
        clickCount: 1
      })
      await sleep(600)
      const source = await snapshot()
      check(
        '点公式进入源码态',
        source.widgets === 0,
        JSON.stringify({ widgets: source.widgets, voids: source.voids })
      )
    }
    check('再点「阿」回到渲染态', await clickAfter('阿'))
    await sleep(300)
    const back = await snapshot()
    console.log(`     [切回渲染后] ${JSON.stringify(back)}`)
    check('公式恢复渲染', back.widgets === 1, JSON.stringify(back.widgets))

    const gapAfter = back.lines.find(l => l.cls.includes('cm-md-block-gap-body'))
    console.log(`     [结构空行] ${JSON.stringify(gapAfter)}`)
    check(
      '公式与「阿」之间仍是收紧的结构空行(16px)',
      !!gapAfter && gapAfter.height <= 20,
      JSON.stringify(gapAfter)
    )

    const gapPoint2 = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const line = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => el.classList.contains('cm-md-block-gap-body'))
        if (!line) return null
        const r = line.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (gapPoint2) {
      const mouse2 = (type: string, buttons: number): Promise<boolean> =>
        evalJs<boolean>(`
          (() => {
            const target = ${JSON.stringify(type)} === 'mousedown'
              ? document.querySelector('.cm-content')
              : document
            target?.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: ${gapPoint2.x},
              clientY: ${gapPoint2.y},
              button: 0,
              buttons: ${buttons}
            }))
            return true
          })()`)
      await mouse2('mousedown', 1)
      await sleep(80)
      await mouse2('mouseup', 0)
      await sleep(500)
      const gapClicked2 = await snapshot()
      console.log(`     [切回后点结构空行] ${JSON.stringify(gapClicked2)}`)
      check(
        '切换后点结构空行,光标仍改道到正文行',
        gapClicked2.line === 5 && gapClicked2.lineText.includes('阿'),
        JSON.stringify({ line: gapClicked2.line, anchor: gapClicked2.anchor })
      )
    } else {
      check('切换后仍找得到结构空行', false)
    }
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
