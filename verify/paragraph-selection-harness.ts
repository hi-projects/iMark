/**
 * 验收:从下往上拖选跨过两段之间的结构空行时,正文不能上下跳。
 *
 * 复现:第一行输入「啊」回车,第二行输入「啊」,从第二行往第一行拖选。
 * 鼠标经过中间那条空行时,行高若从「段间距」变回整行,第二行的字会被顶下去;
 * 继续往上又弹回原处。
 *
 * 跑法(先 `npx electron-vite build`):
 *   node verify/run.mjs paragraph-selection
 */

import { app, BrowserWindow, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// 验收窗口一律不显示
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

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

interface LineInfo {
  text: string
  cls: string
  top: number
  height: number
}

interface Snapshot {
  empty: boolean
  anchor: number
  head: number
  headText: string
  headLine: number
  lines: LineInfo[]
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs paragraph-selection` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'probe.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '啊\n\n啊\n', 'utf8')
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
        lineWrapping: true,
        editorFontSize: 14,
        editorFontSizeVersion: 2
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.setContentSize(900, 600)
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

  async function type(text: string): Promise<void> {
    await focusEditor()
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(30)
    }
    await sleep(300)
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(400)
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(350)
  }

  const snapshot = (): Promise<Snapshot> =>
    evalJs(`
      (() => {
        const round = n => Math.round(n * 100) / 100
        const view = document.querySelector('.cm-content').cmTile.root.view
        const sel = view.state.selection.main
        const headLine = view.state.doc.lineAt(sel.head)
        return {
          empty: sel.empty,
          anchor: sel.anchor,
          head: sel.head,
          headText: headLine.text,
          headLine: headLine.number,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            return {
              text: el.textContent ?? '',
              cls: el.className,
              top: round(r.top),
              height: round(r.height)
            }
          })
        }
      })()`)

  // 按用户的操作顺序输入:啊 / 回车 / 啊
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
      selection: { anchor: 0 },
      userEvent: 'input'
    })
    return true
  })()`)
  await sleep(300)
  await focusEditor()
  await type('啊')
  await key('Return')
  await type('啊')
  await sleep(500)
  console.log(
    '    (源码)',
    JSON.stringify(
      await evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)
    )
  )

  const before = await snapshot()
  const nonEmpty = before.lines.filter(line => line.text.includes('啊'))
  check('有两行「啊」', nonEmpty.length === 2, JSON.stringify(before.lines))
  check('两行之间有结构空行', before.lines.length >= 3, JSON.stringify(before.lines))
  const secondTop = nonEmpty[1]?.top ?? 0

  const points = await evalJs<{
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | null>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const hit = lines.filter(el => (el.textContent || '').includes('啊'))
      if (hit.length < 2) return null
      const a = hit[1].getBoundingClientRect()
      const b = hit[0].getBoundingClientRect()
      // 从正文右侧（行尾之后）起拖：选区只覆盖换行与中间空行，不包含两行文字
      const ar = document.createRange()
      ar.selectNodeContents(hit[1])
      const text = ar.getBoundingClientRect()
      return {
        start: { x: Math.round(text.right + 8), y: Math.round(a.top + a.height / 2) },
        end: { x: Math.round(b.left + 2), y: Math.round(b.top + b.height / 2) }
      }
    })()`)
  check('找得到拖选起止点', points !== null, JSON.stringify(points))
  if (!points) {
    console.log(`\n结果:${pass} 通过,${fail} 失败`)
    app.exit(1)
    return
  }

  wc.debugger.attach('1.3')
  const mouseTypes: Record<string, string> = {
    mousedown: 'mousePressed',
    mousemove: 'mouseMoved',
    mouseup: 'mouseReleased'
  }
  const mouse = async (type: string, x: number, y: number, buttons: number): Promise<void> => {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: mouseTypes[type],
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1
    })
  }

  await mouse('mousedown', points.start.x, points.start.y, 1)
  await sleep(80)

  console.log('\n[A] 自下而上拖选:逐步记录第二行「啊」的位置')
  let jumped = false
  let jumpStep = ''
  let lastTop = secondTop
  for (let step = 1; step <= 24; step++) {
    const y = Math.round(points.start.y + ((points.end.y - points.start.y) * step) / 24)
    await mouse('mousemove', points.start.x, y, 1)
    await sleep(40)
    const snap = await snapshot()
    const top = snap.lines.filter(line => line.text.includes('啊'))[1]?.top ?? 0
    if (Math.abs(top - secondTop) > 0.2) {
      jumped = true
      jumpStep = JSON.stringify({ step, y, top, snap })
      console.log(`    (第 ${step} 步位置变化:${top} ← ${secondTop})`, JSON.stringify(snap))
      break
    }
    lastTop = top
  }
  await mouse('mouseup', points.end.x, points.end.y, 0)
  await sleep(400)
  const after = await snapshot()
  const afterTop = after.lines.filter(line => line.text.includes('啊'))[1]?.top ?? 0

  check('拖选过程中第二行没有移动', !jumped, jumpStep)
  check('松开鼠标后第二行仍在原位', Math.abs(afterTop - secondTop) < 0.2, `${afterTop} ← ${secondTop}`)
  console.log(`    (最后一步 top=${lastTop}, 松手后 top=${afterTop})`)

  console.log('\n[B] 按住左键时选区瞬时退化为空行,也不把空行撑开')
  const blankLine = (): Promise<string> =>
    evalJs(`document.querySelector('.cm-content').cmTile.root.view.state.doc.line(2).from`)
  const blankFrom = await blankLine()
  await mouse('mousedown', points.start.x, points.start.y, 1)
  await sleep(80)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: ${blankFrom} }, userEvent: 'select.pointer' })
    return true
  })()`)
  await sleep(250)
  const collapsedDuring = await snapshot()
  const blankDuring = collapsedDuring.lines[1]
  const topDuring = collapsedDuring.lines.filter(line => line.text.includes('啊'))[1]?.top ?? 0
  check(
    '按住左键时空行保持收紧',
    blankDuring.height <= 16,
    JSON.stringify(collapsedDuring.lines)
  )
  check(
    '按住左键时第二行不移动',
    Math.abs(topDuring - secondTop) < 0.2,
    `${topDuring} ← ${secondTop}`
  )
  await mouse('mouseup', points.start.x, points.start.y, 0)
  await sleep(300)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    view.dispatch({ selection: { anchor: ${blankFrom} } })
    return true
  })()`)
  await sleep(300)
  const collapsedAfter = await snapshot()
  check(
    '松开左键后空光标落在空行上也不改变行高',
    collapsedAfter.lines[1].height <= 16,
    JSON.stringify(collapsedAfter.lines)
  )

  console.log('\n[C] 拖到空行就松手')
  const blankPoint = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const blank = lines[1]
      if (!blank) return null
      const r = blank.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  check('找得到空行坐标', blankPoint !== null, JSON.stringify(blankPoint))
  if (blankPoint) {
    await mouse('mousedown', points.start.x, points.start.y, 1)
    await sleep(80)
    await mouse('mousemove', blankPoint.x, blankPoint.y, 1)
    await sleep(200)
    await mouse('mouseup', blankPoint.x, blankPoint.y, 0)
    await sleep(400)
    const released = await snapshot()
    console.log(
      '    (松手状态)',
      JSON.stringify({
        empty: released.empty,
        anchor: released.anchor,
        head: released.head,
        blank: released.lines[1],
        top: released.lines.filter(line => line.text.includes('啊'))[1]?.top
      })
    )
    const endpoints = await evalJs<{ empty: boolean; fromText: string; toText: string }>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const r = view.state.selection.main
        return {
          empty: r.empty,
          fromText: view.state.doc.lineAt(r.from).text,
          toText: view.state.doc.lineAt(r.to).text
        }
      })()`)
    check(
      '拖到空行松手后选区不会只剩空行',
      endpoints.empty || endpoints.fromText !== '' || endpoints.toText !== '',
      JSON.stringify(endpoints)
    )
    check(
      '空行仍然保持收紧',
      released.lines[1].height <= 16 &&
        Math.abs((released.lines.filter(line => line.text.includes('啊'))[1]?.top ?? 0) - secondTop) < 0.2,
      JSON.stringify(released.lines)
    )
  }

  console.log('\n[D] 选区只框住换行时,会补上相邻正文')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const doc = view.state.doc
    view.dispatch({
      selection: { anchor: doc.line(1).to, head: doc.line(3).from },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const whitespaceOnly = await evalJs<{
    text: string
    empty: boolean
    fromLine: string
    toLine: string
  }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty,
        fromLine: view.state.doc.lineAt(r.from).text,
        toLine: view.state.doc.lineAt(r.to).text
      }
    })()`)
  check(
    '选区自动补上至少一个可见字符',
    !whitespaceOnly.empty && /\S/.test(whitespaceOnly.text),
    JSON.stringify(whitespaceOnly)
  )
  const afterWhitespace = await snapshot()
  check(
    '补字后空行仍然收紧',
    afterWhitespace.lines[1].height <= 16 &&
      Math.abs(
        (afterWhitespace.lines.filter(line => line.text.includes('啊'))[1]?.top ?? 0) - secondTop
      ) < 0.2,
    JSON.stringify(afterWhitespace.lines)
  )

  console.log('\n[E] 代码块末尾回车后点击空白')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = '啊\\n\\n$$\\na\\n$$\\n'
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: 'input'
    })
    document.querySelector('.cm-content').focus()
    return true
  })()`)
  await sleep(800)
  const stateE = (): Promise<{
    doc: string
    head: number
    headLine: number
    headText: string
    lines: LineInfo[]
  }> =>
    evalJs(`
      (() => {
        const round = n => Math.round(n * 100) / 100
        const view = document.querySelector('.cm-content').cmTile.root.view
        const sel = view.state.selection.main
        const line = view.state.doc.lineAt(sel.head)
        return {
          doc: view.state.doc.toString(),
          head: sel.head,
          headLine: line.number,
          headText: line.text,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const r = el.getBoundingClientRect()
            return {
              text: el.textContent ?? '',
              cls: el.className,
              top: round(r.top),
              height: round(r.height)
            }
          })
        }
      })()`)
  // 光标放到末尾 `$$` 后面
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const at = text.lastIndexOf('$$')
    view.dispatch({ selection: { anchor: at + 2 } })
    document.querySelector('.cm-content').focus()
    return true
  })()`)
  await sleep(600)
  console.log('    (回车前)', JSON.stringify(await stateE()))
  await key('Return')
  await sleep(600)
  const afterEnter = await stateE()
  console.log('    (回车后)', JSON.stringify(afterEnter))
  const clickPoint = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const last = lines[lines.length - 1]
      const editor = document.querySelector('.cm-editor')?.getBoundingClientRect()
      if (!last || !editor) return null
      const r = last.getBoundingClientRect()
      return {
        x: Math.round(editor.left + 120),
        y: Math.round(Math.min(r.bottom + 40, editor.bottom - 20))
      }
    })()`)
  check('找得到文档下方空白', clickPoint !== null, JSON.stringify(clickPoint))
  if (clickPoint) {
    await mouse('mousedown', clickPoint.x, clickPoint.y, 1)
    await mouse('mouseup', clickPoint.x, clickPoint.y, 0)
    await sleep(500)
    const afterClick = await stateE()
    console.log('    (点击空白后)', JSON.stringify(afterClick))
    check(
      '点击空白后光标不会跑到别的行',
      afterClick.headLine === afterEnter.headLine,
      JSON.stringify({ afterEnter, afterClick })
    )
  }

  console.log('\n[F] 文档末尾只剩两条换行的选区')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = '啊\\n\\n$$\\na\\n$$\\n\\n'
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: 'input'
    })
    return true
  })()`)
  await sleep(500)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const end = view.state.doc.length
    view.dispatch({
      selection: { anchor: end - 2, head: end },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const trailing = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '末尾空白选区被补上正文',
    !trailing.empty && /\S/.test(trailing.text),
    JSON.stringify(trailing)
  )

  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const at = text.lastIndexOf('$$')
    view.dispatch({
      selection: { anchor: at + 1, head: text.length },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const hiddenFence = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '碰到隐藏公式块时扩成整块',
    !hiddenFence.empty &&
      hiddenFence.text.startsWith('$$') &&
      hiddenFence.text.includes('a') &&
      hiddenFence.text.includes('$$'),
    JSON.stringify(hiddenFence)
  )

  console.log('\n[G] 选中整个公式块时不被吸附走')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const from = text.indexOf('$$')
    const last = text.lastIndexOf('$$')
    view.dispatch({
      selection: { anchor: from, head: last + 2 },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const wholeBlock = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '整个公式块仍可被选中',
    !wholeBlock.empty &&
      wholeBlock.text.includes('$$') &&
      wholeBlock.text.includes('a') &&
      !wholeBlock.text.includes('啊'),
    JSON.stringify(wholeBlock)
  )

  console.log('\n[H] 从块后面往第一行拖:不能只剩第一行')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const end = view.state.doc.length
    view.dispatch({
      selection: { anchor: end, head: 0 },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const upward = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '向上拖选保留了整段范围',
    !upward.empty && upward.text.includes('啊') && upward.text.length > 5,
    JSON.stringify(upward)
  )

  console.log('\n[I] 从下往上只选到公式块:不被吸附走')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const from = text.indexOf('$$')
    view.dispatch({
      selection: { anchor: text.length, head: from },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const backwardBlock = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '反向选区仍包住公式块',
    !backwardBlock.empty &&
      backwardBlock.text.includes('$$') &&
      backwardBlock.text.includes('a') &&
      !backwardBlock.text.includes('啊'),
    JSON.stringify(backwardBlock)
  )

  console.log('\n[J] 拖选途中碰到半个公式块会立即扩成整块')
  await evalJs(`(() => {
    const content = document.querySelector('.cm-content')
    content.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0
    }))
    const view = content.cmTile.root.view
    const text = view.state.doc.toString()
    const from = text.indexOf('$$')
    view.dispatch({
      selection: { anchor: from + 1, head: text.length },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const midDrag = await evalJs<{ text: string; from: number; blockFrom: number }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        from: r.from,
        blockFrom: view.state.doc.toString().indexOf('$$')
      }
    })()`)
  check(
    '拖选途中也被扩成整块',
    midDrag.from === midDrag.blockFrom && midDrag.text.startsWith('$$'),
    JSON.stringify(midDrag)
  )

  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const blockFrom = text.indexOf('$$')
    view.dispatch({
      selection: { anchor: 0, head: blockFrom - 1 },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const midBreak = await evalJs<{ text: string }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return { text: view.state.doc.sliceString(r.from, r.to) }
    })()`)
  check(
    '拖选途中不会只选中一个换行',
    midBreak.text.includes('啊\n\n') && midBreak.text !== '啊\n',
    JSON.stringify(midBreak)
  )

  await evalJs(`(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }))
    return true
  })()`)
  await sleep(200)

  console.log('\n[K] 选到公式块前面的边界时,带上整块')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const blockFrom = text.indexOf('$$')
    view.dispatch({
      selection: { anchor: 0, head: blockFrom },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const boundary = await evalJs<{ text: string; empty: boolean }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        empty: r.empty
      }
    })()`)
  check(
    '块前边界选区也带上整块',
    !boundary.empty && boundary.text.startsWith('啊') && boundary.text.includes('a') && boundary.text.includes('$$'),
    JSON.stringify(boundary)
  )

  console.log('\n[L] 段落分隔中间不会出现「文字 + 一个换行」')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    const blockFrom = text.indexOf('$$')
    view.dispatch({
      selection: { anchor: 0, head: blockFrom - 1 },
      userEvent: 'select.pointer'
    })
    return true
  })()`)
  await sleep(300)
  const oneNewline = await evalJs<{ text: string; from: number; to: number }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const r = view.state.selection.main
      return {
        text: view.state.doc.sliceString(r.from, r.to),
        from: r.from,
        to: r.to
      }
    })()`)
  check(
    '段落选区要么是文字,要么带完整两个换行',
    oneNewline.text === '啊' ||
      oneNewline.text === '啊\n\n' ||
      oneNewline.text === '啊\n\n$$\na\n$$',
    JSON.stringify(oneNewline)
  )

  console.log('\n[M] 块后新段输入中文 / 英文')
  const resetTail = async (): Promise<void> => {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const text = '啊\\n\\n$$\\na\\n$$\\n\\n'
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
        userEvent: 'input'
      })
      return true
    })()`)
    await sleep(400)
    await focusEditor()
  }
  const tailState = (): Promise<{ doc: string; headLine: number; lineText: string }> =>
    evalJs(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const sel = view.state.selection.main
        const line = view.state.doc.lineAt(sel.head)
        return { doc: view.state.doc.toString(), headLine: line.number, lineText: line.text }
      })()`)
  await resetTail()
  await wc.debugger.sendCommand('Input.imeSetComposition', {
    text: '中',
    selectionStart: 1,
    selectionEnd: 1
  })
  await sleep(250)
  await wc.debugger.sendCommand('Input.insertText', { text: '中' })
  await sleep(500)
  const zh = await tailState()
  console.log('    (中文输入后)', JSON.stringify(zh))
  check(
    '中文输入留在当前新段行',
    zh.doc.endsWith('\n\n中') && zh.headLine === 7,
    JSON.stringify(zh)
  )
  await resetTail()
  await wc.debugger.sendCommand('Input.insertText', { text: 'a' })
  await sleep(500)
  const en = await tailState()
  console.log('    (英文输入后)', JSON.stringify(en))
  check('英文输入留在当前新段行', en.doc.endsWith('\n\na') && en.headLine === 7, JSON.stringify(en))

  console.log('\n[N] 组合中按回车不会多插一段空行')
  await resetTail()
  await wc.debugger.sendCommand('Input.imeSetComposition', {
    text: '中',
    selectionStart: 1,
    selectionEnd: 1
  })
  await sleep(250)
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(300)
  await wc.debugger.sendCommand('Input.insertText', { text: '中' })
  await sleep(500)
  const imeEnter = await tailState()
  console.log('    (组合中回车后)', JSON.stringify(imeEnter))
  check(
    '组合中回车没有把字挤到下一行',
    imeEnter.doc.endsWith('\n\n中') && imeEnter.headLine === 7,
    JSON.stringify(imeEnter)
  )

  console.log('\n[O] 键盘光标落到结构空行会回到相邻正文')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = '啊\\n\\n啊'
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      userEvent: 'input'
    })
    return true
  })()`)
  await sleep(500)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const gap = view.state.doc.line(2)
    view.dispatch({ selection: { anchor: gap.from }, userEvent: 'select' })
    return true
  })()`)
  await sleep(350)
  const normalizedCaret = await evalJs<{ lineText: string; head: number; gapHeight: number }>(`
    (() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      const sel = view.state.selection.main
      const line = view.state.doc.lineAt(sel.head)
      const gap = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => el.classList.contains('cm-md-block-gap-body'))
      return {
        lineText: line.text,
        head: sel.head,
        gapHeight: gap ? Math.round(gap.getBoundingClientRect().height) : -1
      }
    })()`)
  check(
    '空行上的光标被移动到相邻正文',
    normalizedCaret.lineText.trim() !== '' && normalizedCaret.gapHeight <= 16,
    JSON.stringify(normalizedCaret)
  )

  console.log('\n[P] 块后新段输入文字后再点空白:文字不能移动')
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = '啊\\n\\n$$\\na\\n$$\\n'
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      userEvent: 'input'
    })
    return true
  })()`)
  await sleep(500)
  await evalJs(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view
    const text = view.state.doc.toString()
    view.dispatch({ selection: { anchor: text.lastIndexOf('$$') + 2 } })
    return true
  })()`)
  await sleep(400)
  await key('Return')
  await sleep(400)
  await type('啊')
  await sleep(400)
  const typedState = (): Promise<{ doc: string; textTop: number; textLine: string; lines: LineInfo[] }> =>
    evalJs(`
      (() => {
        const round = n => Math.round(n * 100) / 100
        const view = document.querySelector('.cm-content').cmTile.root.view
        const line = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(el => el.textContent === '啊' && el.getBoundingClientRect().top > 150)
        const r = line ? line.getBoundingClientRect() : null
        const head = view.state.doc.lineAt(view.state.selection.main.head)
        return {
          doc: view.state.doc.toString(),
          textTop: r ? round(r.top) : -1,
          textLine: head.text,
          lines: [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
            const b = el.getBoundingClientRect()
            return { text: el.textContent ?? '', cls: el.className, top: round(b.top), height: round(b.height) }
          })
        }
      })()`)
  const typedBefore = await typedState()
  const clickPointP = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const last = lines[lines.length - 1]
      const editor = document.querySelector('.cm-editor')?.getBoundingClientRect()
      if (!last || !editor) return null
      const r = last.getBoundingClientRect()
      return {
        x: Math.round(editor.left + 120),
        y: Math.round(Math.min(r.bottom + 40, editor.bottom - 20))
      }
    })()`)
  check('找得到新段下方的空白', clickPointP !== null, JSON.stringify(clickPointP))
  if (clickPointP) {
    await mouse('mousedown', clickPointP.x, clickPointP.y, 1)
    await mouse('mouseup', clickPointP.x, clickPointP.y, 0)
    await sleep(500)
    const typedAfter = await typedState()
    console.log('    (输入后点击空白前/后)', JSON.stringify({ typedBefore, typedAfter }))
    check(
      '点击空白后新段文字位置不变',
      typedAfter.textTop === typedBefore.textTop && typedAfter.doc.includes('\n\n啊'),
      JSON.stringify({ before: typedBefore, after: typedAfter })
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[paragraph-selection] 意外失败:', err)
  app.exit(1)
})
