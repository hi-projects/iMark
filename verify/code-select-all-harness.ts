/**
 * 代码块内 Ctrl+A 的验收:选中这一块代码,重复按也不扩到整篇。
 *
 * 改动前 Ctrl+A 是全篇全选(原生菜单的 role: 'selectAll' 自带加速键,
 * 在 keydown 到达渲染层之前就把它拦掉了)。现在:
 *   · 菜单「全选」不再挂 role / 加速键,Ctrl+A 交回渲染层;
 *   · 焦点在编辑器时走 CM keymap(editor/keymap.ts 的 Mod-a → selectAllInCodeBlock);
 *   · 焦点在输入框 / 扩展面板里时仍是 Chromium 原生全选(菜单项点击转发给渲染层,
 *     由 App.vue 的 edit:select-all 分支处理)。
 *
 * 断言:
 *   A 围栏代码块里 Ctrl+A → 只选中正文(不含 ``` 围栏)
 *   B 再按一次 → 仍是这一块,不扩到整篇
 *   C 正文段落里 Ctrl+A → 整篇(不误伤普通全选)
 *   D 光标停在围栏行上 Ctrl+A → 仍是代码正文
 *   E 缩进代码块 Ctrl+A → 选中整行;再按一次仍是这一块
 *   F 引用里的围栏 → 只选代码,不带 `> ` 前缀
 *   G 菜单「全选」点击(edit:select-all)也按同一规则
 *   H 菜单项不再挂 role / 加速键(否则 keydown 到不了渲染层)
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   xvfb-run -a node verify/run.mjs code-select-all
 */

import { app, BrowserWindow, dialog, Menu, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
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

const FENCED = ['```python', 'import torch', '', 'x = 1', '```'].join('\n')
const INDENTED = ['    indented line', '    second'].join('\n')
const QUOTED = ['> ```js', '> const q = 1', '> ```'].join('\n')
const DOC = `# 代码块全选验收\n\n正文段落。\n\n${FENCED}\n\n${INDENTED}\n\n${QUOTED}\n\n末尾\n`

const FENCED_TEXT = 'import torch\n\nx = 1'
const INDENTED_TEXT = '    indented line\n    second'
const QUOTED_TEXT = 'const q = 1'

interface Selection {
  from: number
  to: number
  text: string
  docLen: number
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
  const note = join(vault, '全选.md')
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

  /** 把光标放到文档里的某个偏移(直接派发,免去按键移动光标的不确定性) */
  const setCursor = (pos: number): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      v.focus()
      v.dispatch({ selection: { anchor: ${pos} }, userEvent: 'select' })
      return true
    })()`)

  async function ctrlA(): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await sleep(250)
  }

  const selection = (): Promise<Selection> =>
    evalJs<Selection>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const r = v.state.selection.main
      return { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to), docLen: v.state.doc.length }
    })()`)

  const menuSelectAll = (): Promise<void> => {
    wc.send(IPC.MenuCommand, 'edit:select-all')
    return sleep(250)
  }

  const at = (s: string, extra = 0): number => {
    const i = DOC.indexOf(s)
    if (i < 0) throw new Error(`用例文档里找不到 ${JSON.stringify(s)}`)
    return i + extra
  }

  await focusEditor()

  console.log('\n【A】围栏代码块里 Ctrl+A:只选中代码正文')
  await setCursor(at('import torch', 3))
  await ctrlA()
  {
    const sel = await selection()
    check('选中的是代码正文', sel.text === FENCED_TEXT, JSON.stringify(sel.text))
    check('不含围栏标记', !sel.text.includes('```'), JSON.stringify(sel.text))
    check(
      '范围正好是正文(从 import 到 x = 1 结尾)',
      sel.from === at('import torch') && sel.to === at('x = 1') + 'x = 1'.length,
      `${sel.from}..${sel.to}`
    )
  }

  console.log('\n【B】再按一次 Ctrl+A:仍是这一块,不扩到整篇')
  await ctrlA()
  {
    const sel = await selection()
    check('第二次按仍只选代码正文', sel.text === FENCED_TEXT, JSON.stringify(sel.text))
    check(
      '范围没有变成整篇',
      sel.from === at('import torch') && sel.to === at('x = 1') + 'x = 1'.length,
      `${sel.from}..${sel.to}/${sel.docLen}`
    )
  }

  console.log('\n【C】正文段落里 Ctrl+A:仍是整篇(普通全选不受影响)')
  await setCursor(at('正文段落', 1))
  await ctrlA()
  {
    const sel = await selection()
    check('段落里全选整篇', sel.from === 0 && sel.to === sel.docLen, `${sel.from}..${sel.to}`)
  }

  console.log('\n【D】光标停在围栏行上 Ctrl+A:仍是代码正文')
  await setCursor(at('```python', 1))
  await ctrlA()
  {
    const sel = await selection()
    check('围栏行上也是选代码正文', sel.text === FENCED_TEXT, JSON.stringify(sel.text))
  }

  console.log('\n【E】缩进代码块:选整行;再按一次仍是这一块')
  await setCursor(at('indented line', 2))
  await ctrlA()
  {
    const sel = await selection()
    check('选中两行缩进代码(含行首缩进)', sel.text === INDENTED_TEXT, JSON.stringify(sel.text))
  }
  await ctrlA()
  {
    const sel = await selection()
    check('第二次按仍是这一块', sel.text === INDENTED_TEXT, JSON.stringify(sel.text))
  }

  console.log('\n【F】引用里的围栏:选中的代码不带 `> ` 前缀')
  await setCursor(at('const q = 1', 2))
  await ctrlA()
  {
    const sel = await selection()
    check('选中引用里的代码正文', sel.text === QUOTED_TEXT, JSON.stringify(sel.text))
    check('不带引用前缀', !sel.text.includes('>'), JSON.stringify(sel.text))
  }

  console.log('\n【G】菜单「全选」点击(edit:select-all)走同一规则')
  await setCursor(at('import torch', 2))
  await menuSelectAll()
  {
    const sel = await selection()
    check('菜单命令在代码块里也只选正文', sel.text === FENCED_TEXT, JSON.stringify(sel.text))
  }

  console.log('\n【H】菜单项不再挂 role / 加速键(Ctrl+A 能到达渲染层)')
  {
    const menu = Menu.getApplicationMenu()
    let selectAllItem: Electron.MenuItem | null = null
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.label === '全选') selectAllItem = item
        if (item.submenu) walk(item.submenu.items)
      }
    }
    if (menu) walk(menu.items)
    check('找得到「全选」菜单项', Boolean(selectAllItem))
    check(
      '没有 role(role: selectAll 自带 Ctrl+A,会拦掉 keydown)',
      Boolean(selectAllItem) && !(selectAllItem as Electron.MenuItem).role,
      JSON.stringify((selectAllItem as Electron.MenuItem | null)?.role)
    )
    check(
      '没有 accelerator',
      Boolean(selectAllItem) && !(selectAllItem as Electron.MenuItem).accelerator,
      JSON.stringify((selectAllItem as Electron.MenuItem | null)?.accelerator)
    )
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
