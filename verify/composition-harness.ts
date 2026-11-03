/**
 * 验收:IME 组合状态下的「整篇替换」不会把 WYSIWYG 装饰永久冻住。
 *
 * 背景:Agent / 扩展写文档走的是 applyEdits → view.dispatch 全量替换,可能恰好
 * 发生在输入法组合中。浏览器在这种替换后往往不再补发 compositionend,于是
 *
 *   - this.composing 停在 true;
 *   - CM 的 view.composing 也停在 true(它只认 compositionend);
 *   - 之后每次 update 都只 remap、不重建,装饰永久停在替换前那一刻
 *     (症状:新内容全是 Markdown 源码,表格/标题不再渲染)。
 *
 * 规则(见 editor/wysiwyg/build.ts):
 *   - 组合中收到**不是** input.type.compose 的文档变更 = 组合其实已结束,
 *     收尾后照常重建;
 *   - 编辑器失焦同样收尾(浏览器也可能在这里丢掉 compositionend);
 *   - 真正的组合输入仍然只 remap、不重建(不能打断中文输入)。
 *
 * 跑法(仓库根目录,改了渲染层先 npx electron-vite build):
 *   xvfb-run -a node verify/run.mjs composition
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { createMainWindow } from '../src/main/window'

// 特权 scheme 必须在 app ready 之前注册(与 src/main/index.ts 一致)
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

/** 验收窗口一律不显示:窗口照常创建与渲染,只是不出现在屏幕上 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

interface Snapshot {
  pluginComposing: boolean[]
  inputComposing: number
  counts: Record<string, number>
  lines: number
  h1Text: string[]
}

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs composition` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, 'note.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, '# 旧标题\n\n正文第一段。\n', 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: note,
    openFiles: [note],
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })
  await initExtensions({ appVersion: APP_VERSION })

  const win = createMainWindow(await loadSettings())
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', d => {
    if (d.level === 'error' || d.level === 'warning') {
      console.log(`     [渲染层 ${d.level}] ${d.message}`)
    }
  })
  await new Promise<void>(r => win.webContents.once('did-finish-load', () => r()))
  await sleep(1800)

  const evalJs = <T,>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>

  const snapshot = (): Promise<Snapshot> =>
    evalJs<Snapshot>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      const composing = []
      for (const p of v.plugins) {
        if (p.value && typeof p.value === 'object' && 'composing' in p.value) composing.push(p.value.composing)
      }
      const counts = {}
      for (const name of ['cm-md-h1', 'cm-md-h2', 'cm-md-table-host', 'cm-md-code']) {
        counts[name] = v.contentDOM.querySelectorAll('.' + name).length
      }
      return {
        pluginComposing: composing,
        inputComposing: v.inputState ? v.inputState.composing : -2,
        counts,
        lines: v.state.doc.lines,
        h1Text: [...v.contentDOM.querySelectorAll('.cm-md-h1')].map(el => el.textContent)
      }
    })()`)

  const dispatch = (code: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view
      ${code}
      return true
    })()`)

  // Agent / 扩展写文档的路径:tabs.ts 的 applyTabChanges → dispatch 全量替换
  const replaceAll = (text: string): Promise<boolean> =>
    dispatch(`v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(text)} },
      userEvent: 'input'
    })`)

  console.log('\n【A】真正的输入法组合:仍只平移装饰,不重建(不打断中文输入)')
  win.webContents.debugger.attach('1.3')
  const cdp = (method: string, params?: unknown): Promise<unknown> =>
    win.webContents.debugger.sendCommand(method, params)

  await dispatch(`v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } })`)
  await sleep(200)
  await cdp('Input.imeSetComposition', { text: '预', selectionStart: 1, selectionEnd: 1 })
  await sleep(250)
  const during = await snapshot()
  console.log(`     [组合中] ${JSON.stringify(during)}`)
  check(
    '组合中 composing 标记为真(自己的 + CM 的)',
    during.pluginComposing.every(Boolean) && during.inputComposing >= 0,
    JSON.stringify(during)
  )

  await cdp('Input.imeSetComposition', { text: '预编辑', selectionStart: 3, selectionEnd: 3 })
  await sleep(250)
  const typing = await snapshot()
  console.log(`     [组合续写] ${JSON.stringify(typing)}`)
  check(
    '组合续写(带 .compose 的变更)不会收尾组合',
    typing.pluginComposing.every(Boolean) && typing.inputComposing >= 0,
    JSON.stringify(typing)
  )
  check('组合续写期间旧标题装饰还在', typing.counts['cm-md-h1'] === 1, JSON.stringify(typing.counts))

  console.log('\n【B】组合中整篇替换(Agent 写入):必须收尾并重建')
  await replaceAll('# 新标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n新正文。\n')
  await sleep(800)
  const replaced = await snapshot()
  console.log(`     [替换后] ${JSON.stringify(replaced)}`)
  check(
    '组合状态被收尾(自己的标记与 CM 的 composing 都复位)',
    replaced.pluginComposing.every(v => !v) && replaced.inputComposing < 0,
    JSON.stringify(replaced)
  )
  check('新文档的标题已渲染', replaced.counts['cm-md-h1'] === 1 && replaced.h1Text[0] === '新标题', JSON.stringify(replaced))
  check('新文档的表格已渲染(没有沿用替换前的旧装饰)', replaced.counts['cm-md-table-host'] === 1, JSON.stringify(replaced))

  console.log('\n【C】替换之后继续编辑:装饰照常跟着重建')
  await dispatch(`v.dispatch({ changes: { from: 0, insert: '## 追加\\n' } })`)
  await sleep(600)
  const after = await snapshot()
  console.log(`     [再插标题] ${JSON.stringify(after)}`)
  check('新插入的二级标题被渲染', after.counts['cm-md-h2'] === 1, JSON.stringify(after))
  check('表格装饰保持', after.counts['cm-md-table-host'] === 1, JSON.stringify(after))

  console.log('\n【D】组合中窗口失焦(切到别的应用):同样要收尾')
  await dispatch(`v.focus(); v.dispatch({ selection: { anchor: 0 } })`)
  await sleep(200)
  await cdp('Input.imeSetComposition', { text: '组合', selectionStart: 2, selectionEnd: 2 })
  await sleep(300)
  const composingAgain = await snapshot()
  check('重新进入组合', composingAgain.pluginComposing.every(Boolean), JSON.stringify(composingAgain))
  await evalJs(`(() => { window.dispatchEvent(new Event('blur')); return true })()`)
  await sleep(400)
  const blurred = await snapshot()
  console.log(`     [窗口失焦后] ${JSON.stringify(blurred)}`)
  check(
    '窗口失焦收尾了组合状态',
    blurred.pluginComposing.every(v => !v) && blurred.inputComposing < 0,
    JSON.stringify(blurred)
  )

  win.webContents.debugger.detach()
  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[composition] 未捕获异常:', err)
  app.exit(1)
})
