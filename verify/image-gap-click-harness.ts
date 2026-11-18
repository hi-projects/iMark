/**
 * 验收:点击「正文与独占一行的图片之间」的留白,不会把空行撑出来。
 *
 * 用户报告:粘贴图片后,光标点击上一行(如「阿」)和图片中间的空行,凭空多出
 * 一行 —— 图片被推下去。原因是那条空行带的是图片专用的间距类
 * (cm-md-image-gap-blank-before-body),点击改道逻辑只认正文 / 表格的
 * cm-md-block-gap-…-before|after,没接住它:光标停在空行上,空行按正文行
 * 撑开,布局整体下移。
 *
 * 期望(与正文段落之间的留白一致):
 *   · 点击图片上方的留白:光标落到上一段末尾,空行高度不变,图片位置不变;
 *   · 点击图片下方的留白:光标落到下一段开头,空行高度不变,正文位置不变;
 *   · 源码不被改动。
 *
 * 跑法(仓库根目录;改了 src/renderer/** 之后先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs image-gap-click
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

/** 1×1 透明 PNG,够让 img 真正加载成功 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

interface Metrics {
  gapH: number
  gapTop: number
  imgTop: number
  head: number
  caretLine: number
  caretText: string
  doc: string
  gapCls: string
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs image-gap-click` 跑会自动带上)')
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
  await mkdir(join(vault, '.assets'), { recursive: true })
  await writeFile(join(vault, '.assets', 'pic.png'), PNG)
  await writeFile(note, '', 'utf8')
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

  async function loadNote(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1100)
  }

  async function setCaret(pos: number): Promise<void> {
    await evalJs(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      view.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true })
      view.focus()
      return true
    })()`)
    await sleep(150)
  }

  /** 找到带某个间距类的空行并测量布局 */
  const measure = (gapClass: string): Promise<Metrics | null> =>
    evalJs<Metrics | null>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const gap = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(l => l.classList.contains(${JSON.stringify(gapClass)}))
        if (!gap) return null
        const gr = gap.getBoundingClientRect()
        const img = document.querySelector('.cm-content .cm-md-image img')
        const head = view.state.selection.main.head
        const caretLine = view.state.doc.lineAt(head)
        return {
          gapH: Math.round(gr.height),
          gapTop: Math.round(gr.top),
          imgTop: img ? Math.round(img.getBoundingClientRect().top) : -1,
          head,
          caretLine: caretLine.number,
          caretText: caretLine.text,
          doc: view.state.doc.toString(),
          gapCls: gap.className
        }
      })()`)

  /** 用真实输入事件点这条空行的行盒中心 */
  async function clickGapLine(gapClass: string): Promise<boolean> {
    const point = await evalJs<{ x: number; y: number }>(`
      (() => {
        const el = [...document.querySelectorAll('.cm-content .cm-line')]
          .find(l => l.classList.contains(${JSON.stringify(gapClass)}))
        if (!el) return { x: -1, y: -1 }
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (point.x < 0) return false
    wc.focus()
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await sleep(400)
    return true
  }

  // ---------- 1. 图片上方:正文与图片之间的留白 ----------

  console.log('\n【1】点击正文与图片之间的留白:不撑行,光标回上一段末尾')
  const DOC1 = '阿\n\n![图片](.assets/pic.png)\n'
  await loadNote(DOC1)
  await waitFor(`document.querySelector('.cm-content .cm-md-image-loaded img')`)
  await setCaret(DOC1.length) // 光标停在文末,图片正常渲染
  {
    const before = await measure('cm-md-image-gap-blank-before-body')
    check('图片独占一行的间距类挂在空行上', !!before, JSON.stringify(before))
    check('空行平时是收紧的一档高度', !!before && before.gapH <= 24, JSON.stringify(before))
    if (!before) {
      console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
      app.exit(1)
      return
    }
    check('点击留白', await clickGapLine('cm-md-image-gap-blank-before-body'))
    const after = await measure('cm-md-image-gap-blank-before-body')
    check('点击后光标落到上一段末尾', !!after && after.head === 1 && after.caretText === '阿', JSON.stringify(after))
    check('空行没有被撑开', !!after && after.gapH === before.gapH, JSON.stringify({ before: before.gapH, after: after?.gapH }))
    check('图片位置没有下移', !!after && after.imgTop === before.imgTop, JSON.stringify({ before: before.imgTop, after: after?.imgTop }))
    check('源码没有被改动', !!after && after.doc === DOC1, JSON.stringify(after?.doc))
  }

  // ---------- 2. 图片下方:图片与正文之间的留白 ----------

  console.log('\n【2】点击图片与正文之间的留白:不撑行,光标到下一段开头')
  const DOC2 = '![图片](.assets/pic.png)\n\n乙\n'
  await loadNote(DOC2)
  await waitFor(`document.querySelector('.cm-content .cm-md-image-loaded img')`)
  await setCaret(DOC2.length - 1) // 「乙」行尾
  {
    const before = await measure('cm-md-image-gap-blank-after-body')
    check('图片下方的间距类挂在空行上', !!before, JSON.stringify(before))
    if (!before) {
      console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
      app.exit(1)
      return
    }
    check('点击留白', await clickGapLine('cm-md-image-gap-blank-after-body'))
    const after = await measure('cm-md-image-gap-blank-after-body')
    const lineFrom = await evalJs<number>(`
      (() => {
        const view = document.querySelector('.cm-content').cmTile.root.view
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        return line.text === '乙' ? view.state.selection.main.head : -1
      })()`)
    check('点击后光标落到下一段开头', lineFrom === DOC2.length - 2, JSON.stringify({ lineFrom, after }))
    check('空行没有被撑开', !!after && after.gapH === before.gapH, JSON.stringify({ before: before.gapH, after: after?.gapH }))
    check('图片位置没有下移', !!after && after.imgTop === before.imgTop, JSON.stringify({ before: before.imgTop, after: after?.imgTop }))
    check('源码没有被改动', !!after && after.doc === DOC2, JSON.stringify(after?.doc))
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
