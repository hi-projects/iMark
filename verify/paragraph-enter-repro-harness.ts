/**
 * 复现/回归:正文输入一个字 → 回车新段 → 在新段输入,光标与文字落点是否一致。
 *
 * 跑法:
 *   xvfb-run -a node verify/run.mjs paragraph-enter-repro
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
  const note = join(vault, '回车.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
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
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1500)

  const evalJs = <T,>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(25)
      }
      await sleep(350)
      const doc = await evalJs<string>(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`)
      if (doc.includes(text)) return
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)})`)
    }
  }

  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(350)
  }

  interface LineSnap {
    text: string
    cls: string
    top: number
    left: number
    h: number
    padTop: string
    padBottom: string
    fs: string
    lh: string
    textTop: number | null
    textBottom: number | null
  }
  interface Snap {
    doc: string
    head: number
    empty: boolean
    caretLine: number
    caretY: number | null
    caretBottom: number | null
    lines: LineSnap[]
  }

  /** 文档、选区、每行 DOM 文本与坐标 */
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const sel = v.state.selection.main
        const lines = Array.from(document.querySelectorAll('.cm-content .cm-line')).map(el => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          // 行内文字的包围盒(跳过 + 按钮)
          let tr = null
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue
            const rg = document.createRange(); rg.selectNodeContents(n)
            const rr = rg.getBoundingClientRect()
            tr = tr ? { top: Math.min(tr.top, rr.top), bottom: Math.max(tr.bottom, rr.bottom) } : { top: rr.top, bottom: rr.bottom }
          }
          return {
            text: el.textContent,
            cls: el.className,
            top: Math.round(r.top), left: Math.round(r.left), h: Math.round(r.height),
            padTop: cs.paddingTop, padBottom: cs.paddingBottom,
            fs: cs.fontSize, lh: cs.lineHeight,
            textTop: tr ? Math.round(tr.top) : null,
            textBottom: tr ? Math.round(tr.bottom) : null
          }
        })
        const caret = v.coordsAtPos(sel.head)
        return {
          doc: JSON.stringify(v.state.doc.toString()),
          head: sel.head,
          empty: sel.empty,
          caretLine: v.state.doc.lineAt(sel.head).number,
          caretY: caret ? Math.round(caret.top) : null,
          caretBottom: caret ? Math.round(caret.bottom) : null,
          lines
        }
      })()`)

  /** CDP 输入法组合:与真实中文输入法同一条路径 */
  wc.debugger.attach('1.3')
  const cdp = (method: string, params?: unknown): Promise<unknown> => wc.debugger.sendCommand(method, params)

  const log = async (title: string): Promise<Snap> => {
    console.log(`\n【${title}】`)
    const s = await snap()
    console.log(JSON.stringify(s, null, 2))
    return s
  }

  let passed = 0
  let failed = 0
  const check = (title: string, ok: boolean, detail = ''): void => {
    if (ok) {
      passed++
      console.log(`  ✓ ${title}`)
    } else {
      failed++
      console.log(`  ✗ ${title}${detail ? ` — ${detail}` : ''}`)
    }
  }

  const shot = async (name: string): Promise<void> => {
    const img = await wc.capturePage()
    await writeFile(`/tmp/imark-para-${name}.png`, img.toPNG())
  }

  await focusEditor()
  await log('0】初始')

  // 第一次用组合输入上屏「阿」,模拟真实输入法
  await cdp('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 })
  await sleep(200)
  await log('0.5】组合中 a')
  await cdp('Input.insertText', { text: '阿' })
  await sleep(400)
  await log('1】输入法上屏 阿 后')

  await key('Return')
  await log('2】回车新段后')

  // 新段落里再用输入法输入:组合 → 上屏
  await cdp('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 })
  await sleep(250)
  await log('3a】新段组合中 a')
  await cdp('Input.insertText', { text: '阿' })
  await sleep(500)
  await log('3b】新段输入法上屏 阿 后')

  // 再用「组合中按回车」这条路(有的输入法用回车上屏)试一次
  await key('Return')
  await cdp('Input.imeSetComposition', { text: 'e', selectionStart: 1, selectionEnd: 1 })
  await sleep(250)
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(500)
  await log('4】组合中按回车后')

  // 用户描述里那句「我在这段输入标题」:在新段里输入 `# 标题`
  // 先把上一段组合状态清干净,从空文档重来
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' }, selection: { anchor: 0 }, userEvent: 'input' })
    return true
  })()`)
  await sleep(500)
  await focusEditor()
  await type('阿')
  await log('5a】空文档输入 阿')
  await key('Return')
  await log('5b】回车到新段')
  await shot('5b')
  await type('#')
  await log('5c】新段输入 #')
  await type(' ')
  await log('5d】输入 # 空格')
  await type('阿')
  await log('5e】输入标题文字 阿')
  await shot('5e')

  // 标题行上用输入法上屏:组合 → 上屏,然后回车
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' }, selection: { anchor: 0 }, userEvent: 'input' })
    return true
  })()`)
  await sleep(400)
  await focusEditor()
  await type('阿')
  await key('Return')
  await type('# ')
  await log('6a】新段输入 # 空格')
  await cdp('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 })
  await sleep(250)
  await log('6b】标题行组合中 a')
  await cdp('Input.insertText', { text: '阿' })
  await sleep(500)
  await log('6c】标题行输入法上屏 阿')
  await shot('6c')
  await key('Return')
  await log('6d】标题后回车')
  await shot('6d')

  /*
   * 用户报的场景:正文输入一个字 → 回车新段 → 在新段里写标题。回看上一段时
   * (标题行行首按上键),光标会停在标题前那条空行上,带出一个「+」——
   * 看着像新段里凭空多出来的段内换行。
   */
  const setDoc = async (text: string, anchor: number): Promise<void> => {
    await evalJs(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const t = ${JSON.stringify(text)}
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: ${anchor} }, userEvent: 'input' })
      return true
    })()`)
    await sleep(500)
    await focusEditor()
  }

  await setDoc('阿\n\n# 阿', 6)
  await log('7a】光标在标题行尾')
  await key('Up')
  const s7b = await log('7b】按上键之后')
  await shot('7b')
  const [l1, blank, heading] = s7b.lines
  check('上键从标题回到上一段', s7b.caretLine === 1, `caretLine=${s7b.caretLine}`)
  check(
    '标题前的空行按结构行处理(带 block-gap)',
    blank?.cls.includes('cm-md-h-space-before') && blank?.cls.includes('cm-md-block-gap'),
    blank?.cls ?? 'none'
  )
  check(
    '标题前的空行仍占一整行(和正文行一样高)',
    !!blank && !!l1 && Math.abs(blank.h - l1.h) <= 1,
    `${blank?.h} vs ${l1?.h}`
  )
  check('「+」没有落到空行上', !blank?.text.includes('+'), JSON.stringify(blank?.text))
  check('标题行还是标题', heading?.cls.includes('cm-md-h1') ?? false, heading?.cls ?? 'none')

  await key('Up')
  const s7c = await log('7c】再按一次上键')
  check('再按上键到上一段行首', s7c.caretLine === 1 && s7c.head === 0, `caretLine=${s7c.caretLine} head=${s7c.head}`)
  await key('Down')
  const s7d = await log('7d】再按下键')
  check('下键直接回到标题行,不停空行', s7d.caretLine === 3, `caretLine=${s7d.caretLine}`)

  // 对照:两个正文段落时,上键会跳过中间那条空行
  await setDoc('阿\n\n阿', 4)
  await key('Up')
  const s7e = await log('7e】两个正文段落:上键')
  check('正文段之间也跳过空行(对照)', s7e.caretLine === 1, `caretLine=${s7e.caretLine}`)

  // 标题前那条空行的另一边:光标在上一段时按下键,也不该停在它上面
  await setDoc('阿\n\n# 阿', 0)
  await key('Down')
  const s8 = await log('8】标题场景:上一段按下键')
  check('下键从上一段直接到标题行', s8.caretLine === 3, `caretLine=${s8.caretLine}`)

  // 点击标题前的空行:光标不该停上去
  await setDoc('阿\n\n# 阿', 0)
  const pt = await evalJs<{ x: number; y: number }>(`(() => {
    const line = document.querySelectorAll('.cm-content .cm-line')[1]
    const r = line.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y })
  wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(500)
  const s9 = await log('9】点击标题前空行')
  await shot('9')
  check('点击标题前的空行不把光标停上去', s9.caretLine !== 2, `caretLine=${s9.caretLine}`)

  console.log(`\n通过 ${passed},失败 ${failed}`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(failed ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
