/**
 * 代码块 Tab 缩进验收。
 *
 * 验的是 editor/codeIndent.ts + keymap 的 Tab 绑定:
 *
 *  · 围栏代码块里按 Tab 在光标处插入设置里选定的空格数(默认从 2 起验);
 *  · 缩进代码块(光标落在行首那 4 个空格里)也能插入;
 *  · 围栏行不拦 Tab —— 否则在 ``` 前面加空格会把围栏变成缩进代码块;
 *  · 正文里 Tab 保持默认(不插入空格);
 *  · 有选区时用空格替换选区(与直接敲空格一致);
 *  · 在设置面板里切到 4 空格后立即生效,并落到 settings.json。
 *
 * 跑法(在仓库根目录,先 `npx electron-vite build`):
 *   node verify/run.mjs code-indent
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const REPO = join(__dirname, '..', '..')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

/** 行号从 1 起;返回渲染后的行文本(去掉复制按钮那种 DOM 控件) */
const FENCED = ['```python', 'import torch', 'x = 1', '```'].join('\n')
const INDENTED = ['    indented line', '    second'].join('\n')
const DOC = `# 缩进验收\n\n${FENCED}\n\n普通段落\n\n${INDENTED}\n\n末尾\n`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs code-indent` 跑会自动带上)')
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
  const note = join(vault, '缩进.md')
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
        // 先给 2:验证启动时读设置 → 模块偏好这条链路,后面再在面板里改成 4
        codeIndentSize: 2
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: '0.1.0' })
  await ensureBundledProvisioned(service)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  wc.on('console-message', (_event, ...args: unknown[]) => {
    const first = args[0]
    if (first && typeof first === 'object') {
      const details = first as { level?: string; message?: string }
      if (details.level !== 'debug') console.log(`[renderer:${details.level}] ${details.message}`)
    } else if (typeof args[1] === 'string') {
      console.log(`[renderer:${String(first)}] ${args[1]}`)
    }
  })
  wc.on('render-process-gone', (_event, details) => console.log('[render-process-gone]', details))
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function focusEditor(): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
    await sleep(80)
  }

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }

  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
    await sleep(140)
  }

  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(900)
    await focusEditor()
  }

  /** 第 lineNo 行(从 1 起)的渲染文本;复制按钮是绝对定位控件,不算正文 */
  const lineText = (lineNo: number): Promise<string> =>
    evalJs<string>(`
      (() => {
        const line = document.querySelectorAll('.cm-content .cm-line')[${lineNo - 1}]
        if (!line) return '<missing>'
        const copy = line.cloneNode(true)
        copy.querySelectorAll('.cm-md-code-copy').forEach(b => b.remove())
        return copy.textContent
      })()`)

  /** 把光标放到第 lineNo 行(1 起);atStart=true 时先按两次 Home 落到行首 */
  async function gotoLine(lineNo: number, atStart: boolean): Promise<void> {
    await focusEditor()
    await key('Home', ['control'])
    for (let i = 1; i < lineNo; i++) await key('ArrowDown')
    if (atStart) {
      await key('Home')
      await key('Home') // 第一次到首个非空白字符,第二次才到行首
    }
  }

  await focusEditor()

  // ---------- 1. 围栏代码块:行尾 / 行首插入 2 空格 ----------

  console.log('\n【1】围栏代码块里 Tab 插入 2 个空格(设置文件里是 2)')
  await gotoLine(4, false) // import torch
  await key('End')
  await key('Tab')
  check('行尾按 Tab 追加 2 个空格', (await lineText(4)) === 'import torch  ', JSON.stringify(await lineText(4)))
  await key('Tab')
  check('再按一次再追加 2 个(累计 4)', (await lineText(4)) === 'import torch    ', JSON.stringify(await lineText(4)))
  await key('z', ['control'])
  await key('z', ['control'])
  check('撤销后回到原文', (await lineText(4)) === 'import torch', JSON.stringify(await lineText(4)))

  await gotoLine(5, true) // x = 1
  await key('Tab')
  check('行首按 Tab 在光标处插入 2 个空格', (await lineText(5)) === '  x = 1', JSON.stringify(await lineText(5)))
  await key('z', ['control'])

  // ---------- 2. 光标落在缩进代码块的行首空格里 ----------

  console.log('\n【2】缩进代码块:光标在行首的 4 个空格里也能插入')
  await gotoLine(10, true) // 缩进代码块第一行(前面 4 个空格)
  await key('Tab')
  check(
    '缩进代码块行首插入 2 个空格(变成 6 个)',
    (await lineText(10)) === '      indented line',
    JSON.stringify(await lineText(10))
  )
  await key('z', ['control'])
  check('撤销后恢复 4 个空格', (await lineText(10)) === '    indented line', JSON.stringify(await lineText(10)))

  // ---------- 3. 围栏行 / 正文:不拦 Tab ----------

  console.log('\n【3】围栏行与正文里的 Tab 保持默认(不改文档)')
  await gotoLine(3, true) // ```python 行(光标上去后源码标记会显示出来)
  const fenceBefore = await lineText(3)
  await key('Tab')
  check('围栏行按 Tab 不改文档', (await lineText(3)) === fenceBefore, JSON.stringify(await lineText(3)))

  await gotoLine(8, true) // 普通段落
  const paraBefore = await lineText(8)
  await key('Tab')
  check('正文段落按 Tab 不改文档', (await lineText(8)) === paraBefore, JSON.stringify(await lineText(8)))

  // ---------- 4. 有选区:空格替换选区 ----------

  console.log('\n【4】代码块里有选区时,Tab 用空格替换选区')
  await gotoLine(5, true) // x = 1
  await key('End', ['shift'])
  await key('Tab')
  check('整行被替换成 2 个空格', (await lineText(5)) === '  ', JSON.stringify(await lineText(5)))
  await key('z', ['control'])
  check('撤销后恢复', (await lineText(5)) === 'x = 1', JSON.stringify(await lineText(5)))

  // ---------- 5. 设置面板改成 4:立即生效并落盘 ----------

  console.log('\n【5】设置面板切到 4 空格:立即生效并写入 settings.json')
  await loadDoc(DOC)
  const opened = await evalJs<boolean>(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('设置'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
  check('从状态栏打开设置面板', opened)
  await sleep(400)
  const navClicked = await evalJs<boolean>(`
    (() => {
      const btn = [...document.querySelectorAll('.settings-nav-item')].find(
        b => b.textContent.trim() === '编辑器'
      )
      if (!btn) return false
      btn.click()
      return true
    })()`)
  check('切到「编辑器」页', navClicked)
  await sleep(400)

  const presets = await evalJs<{ label: string; active: boolean }[]>(`
    (() => {
      const row = [...document.querySelectorAll('.settings-row')].find(
        r => r.querySelector('.settings-row-title')?.textContent.trim() === '代码块 Tab 缩进'
      )
      return row
        ? [...row.querySelectorAll('button')].map(b => ({
            label: b.textContent.trim(),
            active: b.classList.contains('settings-preset-active')
          }))
        : []
    })()`)
  check(
    '提供 2 / 4 两个档位,且当前选中 2(来自启动时读的设置)',
    presets.length === 2 &&
      presets[0].label === '2 个空格' &&
      presets[1].label === '4 个空格' &&
      presets[0].active &&
      !presets[1].active,
    JSON.stringify(presets)
  )

  const clicked = await evalJs<boolean>(`
    (() => {
      const row = [...document.querySelectorAll('.settings-row')].find(
        r => r.querySelector('.settings-row-title')?.textContent.trim() === '代码块 Tab 缩进'
      )
      const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '4 个空格')
      if (!btn) return false
      btn.click()
      return true
    })()`)
  check('点击「4 个空格」', clicked)
  await sleep(500)

  await key('Escape') // 关设置面板
  await sleep(300)
  await loadDoc(DOC)
  await gotoLine(4, false)
  await key('End')
  await key('Tab')
  check('改成 4 后 Tab 立即插入 4 个空格', (await lineText(4)) === 'import torch    ', JSON.stringify(await lineText(4)))

  const saved = JSON.parse(await readFile(join(ud, 'settings.json'), 'utf8')) as { codeIndentSize?: number }
  check('设置已写入 settings.json', saved.codeIndentSize === 4, JSON.stringify(saved.codeIndentSize))

  // ---------- 截图 ----------

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  try {
    await writeFile(join(shots, 'code-indent.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    console.log('  (截图跳过:', err instanceof Error ? err.message : String(err), ')')
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  app.exit(2)
})
