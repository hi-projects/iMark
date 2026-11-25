/**
 * 块级公式的渲染高度只由**公式内容**决定,不跟源码行数走。
 *
 * 回归的是这样一条旧行为:渲染态的公式盒子按源码行数预留 min-height
 * (源码占几行,渲染块就有几行高),公式在这块预留空间里垂直居中。它让
 * 「点进 / 点出公式时下方正文不跳」,但代价是一行公式写在 8 行源码里时,
 * 屏幕上会留出一大片空白。
 *
 * 验两件事:
 *   1. 同一段 TeX,写成单行 `$$...$$` 与展开成多行源码,渲染出的块**一样高**;
 *   2. 渲染块高度 ≈ 公式本身高度(宿主行没有额外叠行高)。
 *
 * 跑法(仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs math-natural-height
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
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
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 同一段 TeX:两行 cases,渲染高度与源码怎么写无关 */
const BODY = ['\\begin{cases}', 'a = b \\\\', 'c = d', '\\end{cases}']

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <name>` 跑会自动带上)')
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
  await mkdir(vault, { recursive: true })
  await writeFile(note, '占位\n', 'utf8')
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
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers as never })
    await sleep(200)
  }

  /** 写盘 + 重载,然后把光标挪到文末(公式外 → 渲染态),量宿主行与 widget 的高度 */
  async function measure(content: string): Promise<{ widget: number; host: number } | null> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1200)
    await focusEditor()
    await key('End', ['control'])
    await sleep(700)
    return evalJs<{ widget: number; host: number } | null>(`
      (() => {
        const w = document.querySelector('.cm-md-math-display')
        const host = w?.closest('.cm-line')
        if (!w || !host) return null
        return {
          widget: Math.round(w.getBoundingClientRect().height * 10) / 10,
          host: Math.round(host.getBoundingClientRect().height * 10) / 10
        }
      })()`)
  }

  console.log('\n【1】同一段 TeX:单行源码')
  const single = await measure(`$$ ${BODY.join(' ')} $$\n\n末尾\n`)
  check('单行公式渲染成 widget', single !== null, JSON.stringify(single))

  console.log('\n【2】同一段 TeX:展开成 6 行源码')
  const multi = await measure(`$$\n${BODY.join('\n')}\n$$\n\n末尾\n`)
  check('多行公式渲染成 widget', multi !== null, JSON.stringify(multi))

  if (single && multi) {
    console.log(`\n【3】两者高度对比:单行 ${single.widget}px,多行源码 ${multi.widget}px`)
    check(
      '渲染高度与源码怎么写无关(±2px)',
      Math.abs(single.widget - multi.widget) <= 2,
      JSON.stringify({ single, multi })
    )
    check(
      '宿主行没有额外叠一份行高',
      Math.abs(multi.host - multi.widget) <= 2,
      JSON.stringify(multi)
    )
    check(
      '渲染高度小于源码行数 × 一行的高度(不再按源码长度预留)',
      multi.widget < 6 * 20,
      JSON.stringify(multi)
    )
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
