/**
 * 复现:正文回车新段,后面跟一个空代码块时,新段光标的落点不对。
 *
 * 步骤:
 *   1. 输入「阿」→ 回车(新段)
 *   2. 在新段输入 ``` → 回车(生成空代码块)
 *   3. 光标移到第一行末尾 → 回车(在第一行和代码块之间新建一段)
 *   4. 对比回车后光标矩形与随后输入文字的位置
 *
 * 跑法:xvfb-run -a node verify/run.mjs paragraph-after-code
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
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(r => wc.once('did-finish-load', () => r()))
  await sleep(1500)
  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

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
      const doc = await evalJs<string>(
        `document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`
      )
      if (doc.includes(text)) return
      console.log(`    (输入没落进去:${JSON.stringify(text)})`)
    }
  }
  async function key(keyCode: string): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode })
    wc.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(400)
  }

  interface Snap {
    doc: string
    head: number
    caretLine: number
    caret: { left: number; top: number; bottom: number } | null
    lines: {
      text: string
      cls: string
      top: number
      h: number
      textTop: number | null
      textLeft: number | null
      textBottom: number | null
      /** 每个非空白文本节点的位置(跳过行首「+」标记) */
      texts: { t: string; left: number; top: number; bottom: number }[]
    }[]
  }
  const snap = (): Promise<Snap> =>
    evalJs<Snap>(`
      (() => {
        const v = document.querySelector('.cm-content').cmTile.root.view
        const sel = v.state.selection.main
        const lines = [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
          const r = el.getBoundingClientRect()
          let tr = null
          const texts = []
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let n = w.nextNode(); n; n = w.nextNode()) {
            if (!n.textContent.trim()) continue
            const rg = document.createRange(); rg.selectNodeContents(n)
            const rr = rg.getBoundingClientRect()
            texts.push({
              t: n.textContent,
              left: Math.round(rr.left),
              top: Math.round(rr.top),
              bottom: Math.round(rr.bottom)
            })
            tr = tr
              ? { top: Math.min(tr.top, rr.top), left: Math.min(tr.left, rr.left), bottom: Math.max(tr.bottom, rr.bottom) }
              : { top: rr.top, left: rr.left, bottom: rr.bottom }
          }
          return {
            text: el.textContent,
            cls: el.className,
            top: Math.round(r.top),
            h: Math.round(r.height),
            textTop: tr ? Math.round(tr.top) : null,
            textLeft: tr ? Math.round(tr.left) : null,
            textBottom: tr ? Math.round(tr.bottom) : null,
            texts
          }
        })
        const c = v.coordsAtPos(sel.head)
        return {
          doc: JSON.stringify(v.state.doc.toString()),
          head: sel.head,
          caretLine: v.state.doc.lineAt(sel.head).number,
          caret: c ? { left: Math.round(c.left), top: Math.round(c.top), bottom: Math.round(c.bottom) } : null,
          lines
        }
      })()`)

  await focusEditor()
  await type('阿')
  await key('Return')
  await type('\`\`\`')
  await key('Return')
  console.log('\n【A】代码块建好之后')
  console.log(JSON.stringify(await snap(), null, 2))

  // 光标移到第一行末尾(用户用鼠标/键盘回去,这里直接设选区)
  await evalJs(`(() => {
    const v = document.querySelector('.cm-content').cmTile.root.view
    v.dispatch({ selection: { anchor: v.state.doc.line(1).to } })
    return true
  })()`)
  await sleep(300)
  await focusEditor()
  await key('Return')
  console.log('\n【B】第一行末尾回车之后(光标应落在新段)')
  const b = await snap()
  console.log(JSON.stringify(b, null, 2))

  await type('阿')
  console.log('\n【C】在新段输入「阿」之后')
  const c = await snap()
  console.log(JSON.stringify(c, null, 2))

  // 对比:回车后的光标矩形 vs 随后文字的位置(同一条逻辑行里的「阿」)
  const caret = b.caret
  const line = c.lines[c.caretLine - 1]
  const target = line?.texts.find(t => t.t.includes('阿')) ?? null
  let pass = 0
  let fail = 0
  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
  }
  if (caret && target) {
    check(
      '回车后的光标纵向落在新段文字行上(±2px)',
      Math.abs(caret.top - target.top) <= 2,
      JSON.stringify({ caret: caret.top, textTop: target.top })
    )
    check(
      '回车后的光标横向落在新段文字起点(±2px)',
      Math.abs(caret.left - target.left) <= 2,
      JSON.stringify({ caret: caret.left, textLeft: target.left })
    )
  } else {
    check('量得到光标与新段文字', false, JSON.stringify({ caret, target }))
  }
  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
