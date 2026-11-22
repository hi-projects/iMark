/**
 * 验收:中文与英文 / 行内代码之间的自动留白。
 *
 * 需求是「渲染时留一个空格,源码里不要多出空格」,所以断言分三层:
 *   1. `.cm-content` 打开 `text-autospace`,由浏览器排版时插入间距;
 *   2. 行内代码、代码块与公式源码显式关掉自动留白;
 *   3. 关掉后行宽确实变窄,且文档文本与磁盘内容里没有多出来的空格。
 *
 * 跑法(先 `npx electron-vite build`):
 *   node verify/run.mjs autospace
 */

import { app, BrowserWindow, protocol } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const DOC = [
  '默认abc间距',
  '这是a中文',
  '这是a',
  '默认`abc`间距',
  '',
  '```text',
  '中文abc',
  '```',
  ''
].join('\n')

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

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs autospace` 跑会自动带上)')
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
  win.setContentSize(1000, 700)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  console.log('\n【A】自动留白已开启,代码类内容显式关闭')
  const styles = await evalJs<{
    supported: boolean
    content: string
    inlineCode: string
    codeBlock: string
    texts: string[]
  }>(`
    (() => {
      const content = document.querySelector('.cm-content')
      const code = document.querySelector('.cm-md-inlinecode')
      const block = document.querySelector('.cm-md-code')
      return {
        supported: CSS.supports('text-autospace', 'normal'),
        content: content ? getComputedStyle(content).textAutospace : '',
        inlineCode: code ? getComputedStyle(code).textAutospace : '',
        codeBlock: block ? getComputedStyle(block).textAutospace : '',
        texts: [...document.querySelectorAll('.cm-content .cm-line')].map(el => el.textContent ?? '')
      }
    })()`)
  check('浏览器支持 text-autospace', styles.supported, JSON.stringify(styles))
  check('正文开启自动留白', styles.content === 'normal', styles.content)
  check('行内代码关闭自动留白', styles.inlineCode === 'no-autospace', styles.inlineCode)
  check('代码块关闭自动留白', styles.codeBlock === 'no-autospace', styles.codeBlock)

  const noSpaceLines = styles.texts.filter(text => text.includes('默认abc间距'))
  check(
    'DOM 文本里没有自动插入的空格',
    noSpaceLines.length >= 2 && noSpaceLines.every(text => text === '默认abc间距'),
    JSON.stringify(noSpaceLines)
  )

  console.log('\n【B】关掉自动留白后行宽确实变窄')
  const widths = await evalJs<{ on: number; off: number; codeMargin: number; codePadding: number }>(`
    (() => {
      const content = document.querySelector('.cm-content')
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const plain = lines.find(
        el => el.textContent === '默认abc间距' && !el.querySelector('.cm-md-inlinecode')
      )
      const code = lines
        .find(el => el.querySelector('.cm-md-inlinecode'))
        ?.querySelector('.cm-md-inlinecode')
      if (!content || !plain) return { on: 0, off: 0, codeMargin: 0, codePadding: 0 }
      const width = () => {
        const r = document.createRange()
        r.selectNodeContents(plain)
        return r.getBoundingClientRect().width
      }
      const on = width()
      content.style.textAutospace = 'no-autospace'
      const off = width()
      content.style.removeProperty('text-autospace')
      const cs = code ? getComputedStyle(code) : null
      return {
        on,
        off,
        codeMargin: cs ? parseFloat(cs.marginLeft) + parseFloat(cs.marginRight) : 0,
        codePadding: cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0
      }
    })()`)
  check(
    '中文与英文之间确实多出排版间距',
    widths.on > widths.off + 1,
    JSON.stringify(widths)
  )
  check(
    '行内代码自带内边距与外侧留白',
    widths.codePadding > 0 && widths.codeMargin > 0,
    JSON.stringify(widths)
  )

  console.log('\n【D】光标停在中文与英文交界处仍然留白')
  const boundary = await evalJs<{
    atStart: number
    atBoundary: number
    selectA: number
    selectLeft: number
    off: number
  }>(`
    (() => {
      const content = document.querySelector('.cm-content')
      const view = content.cmTile.root.view
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(el => el.textContent === '这是a')
      if (!line) return { atStart: -1, atBoundary: -1, selectA: -1, selectLeft: -1, off: -1 }
      const width = () => {
        const r = document.createRange()
        r.selectNodeContents(line)
        return r.getBoundingClientRect().width
      }
      const pos = view.state.doc.toString().indexOf('这是a')
      view.dispatch({ selection: { anchor: pos } })
      const atStart = width()
      view.dispatch({ selection: { anchor: pos + 2 } })
      const atBoundary = width()
      view.dispatch({ selection: { anchor: pos + 2, head: pos + 3 } })
      const selectA = width()
      view.dispatch({ selection: { anchor: pos, head: pos + 2 } })
      const selectLeft = width()
      view.dispatch({ selection: { anchor: pos } })
      content.style.textAutospace = 'no-autospace'
      const off = width()
      content.style.removeProperty('text-autospace')
      return { atStart, atBoundary, selectA, selectLeft, off }
    })()`)
  check('光标不在交界处时留白', boundary.atStart > boundary.off + 1, JSON.stringify(boundary))
  check('光标停在交界处时仍留白', boundary.atBoundary > boundary.off + 1, JSON.stringify(boundary))
  check('选中英文时留白仍在', boundary.selectA > boundary.off + 1, JSON.stringify(boundary))
  check('选中中文时留白仍在', boundary.selectLeft > boundary.off + 1, JSON.stringify(boundary))

  console.log('\n【E】拖选过程中正文位置不抖动')
  interface LineBox {
    text: string
    left: number
    width: number
    top: number
  }
  const measureLines = (): Promise<LineBox[]> =>
    evalJs(`
      (() => {
        const round = n => Math.round(n * 100) / 100
        return [...document.querySelectorAll('.cm-content .cm-line')]
          .slice(0, 3)
          .map(el => {
            const r = document.createRange()
            r.selectNodeContents(el)
            const b = r.getBoundingClientRect()
            return { text: el.textContent ?? '', left: round(b.left), width: round(b.width), top: round(b.top) }
          })
      })()`)
  const dragPoints = await evalJs<{
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | null>(`
    (() => {
      const lines = [...document.querySelectorAll('.cm-content .cm-line')]
      const first = lines.find(el => el.textContent === '这是a中文')
      const second = lines.find(el => el.textContent === '这是a')
      if (!first || !second) return null
      const a = first.getBoundingClientRect()
      const b = second.getBoundingClientRect()
      return {
        start: { x: Math.round(a.left + 2), y: Math.round(a.top + a.height / 2) },
        end: { x: Math.round(b.right - 2), y: Math.round(b.top + b.height / 2) }
      }
    })()`)
  check('找得到两行待选正文', dragPoints !== null, JSON.stringify(dragPoints))
  if (dragPoints) {
    const before = await measureLines()
    const mouse = (type: string, x: number, y: number, buttons: number): Promise<boolean> =>
      evalJs<boolean>(`
        (() => {
          const target = ${JSON.stringify(type)} === 'mousedown'
            ? document.querySelector('.cm-content')
            : document
          target?.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: ${x},
            clientY: ${y},
            button: 0,
            buttons: ${buttons}
          }))
          return true
        })()`)
    const mid = {
      x: Math.round((dragPoints.start.x + dragPoints.end.x) / 2),
      y: Math.round((dragPoints.start.y + dragPoints.end.y) / 2)
    }
    await mouse('mousedown', dragPoints.start.x, dragPoints.start.y, 1)
    await sleep(80)
    await mouse('mousemove', mid.x, mid.y, 1)
    await sleep(80)
    await mouse('mousemove', dragPoints.end.x, dragPoints.end.y, 1)
    await sleep(400)
    const during = await measureLines()
    await mouse('mouseup', dragPoints.end.x, dragPoints.end.y, 0)
    await sleep(400)
    const after = await measureLines()
    const stable = (a: LineBox[], b: LineBox[]): boolean =>
      a.length === b.length &&
      a.every(
        (line, i) =>
          Math.abs(line.left - b[i].left) < 0.2 &&
          Math.abs(line.width - b[i].width) < 0.2 &&
          Math.abs(line.top - b[i].top) < 0.2
      )
    check('拖选过程中行位置不变', stable(before, during), JSON.stringify({ before, during }))
    check('松开鼠标后行位置不变', stable(before, after), JSON.stringify({ before, after }))
  }

  console.log('\n【C】磁盘上的源码没有被改写')
  const disk = await readFile(note, 'utf8')
  check('源码与写入时完全一致', disk === DOC, JSON.stringify(disk))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('[autospace] 意外失败:', err)
  app.exit(1)
})
