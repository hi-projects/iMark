/**
 * 验收:启动时恢复「关闭前打开的页面」,没有页面时什么都不打开。
 *
 * 两条用户可见规则:
 *   A 关闭前没打开任何页面 → 启动后不出现「未命名」文档,编辑区是空的;
 *   B 关闭前打开了某页面   → 启动后恢复那个文件。
 *
 * 配套的持久化规则(不然 A/B 会互相打架):
 *   - 打开文件 → lastFile 记它;
 *   - 新建未命名文档 → lastFile 清空(未命名没法跨启动恢复),
 *     但同一会话里还开着的文件标签仍会恢复(多标签页后它们没有被关掉);
 *   - 回到仓库选择界面 → lastFile 清空(眼前没有页面了);
 *   - 上次的文件已被删除 → 不打开任何东西,并清掉那条记忆。
 *
 * 窗口全程隐藏:验收在后台跑,不能弹出窗口打扰正在用电脑的人。
 * 另外用 `xvfb-run` 跑一次更稳妥(见文件末尾的跑法)。
 *
 * 跑法(仓库根目录):
 *   xvfb-run -a node verify/run.mjs session-restore --disable-gpu
 */

import { app, BrowserWindow, protocol } from 'electron'
import { basename, join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { createMainWindow } from '../src/main/window'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { IPC } from '../src/shared/ipc-channels'

// 特权 scheme 必须在 app ready 之前注册(与 src/main/index.ts 一致)
protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

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

/**
 * 验收窗口一律不显示。
 *
 * `createMainWindow` 会在 ready-to-show 时 show(),进入编辑器还会 maximize()。
 * 在进程里把这两个方法换成空操作:窗口照常创建、照常渲染(executeJavaScript 与
 * DOM 都不受影响),只是从不出现在屏幕上,也不会抢焦点。
 */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

type Win = BrowserWindow

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs session-restore` 跑会自动带上)')
    app.exit(2)
    return
  }

  // 默认行为是「所有窗口关掉就退出」;这个验收会反复关窗/开窗,得把退出挡住
  app.on('window-all-closed', () => {})

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const note = join(vault, '笔记.md')
  const noteText = '# 笔记\n\n这是关闭前打开的那一页。\n'
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await writeFile(note, noteText, 'utf8')

  await loadSettings()
  await saveSettings({
    skipVaultPicker: true,
    vaultPath: vault,
    vaults: [vault],
    lastFile: null,
    autoSaveMode: 'off',
    marketUrl: '',
    marketAutoCheck: false
  })

  await initPluginHost()

  const settingsFile = join(ud, 'settings.json')

  async function readSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
  }

  function evalJs<T>(win: Win, code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(win: Win, code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(win, `(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  async function waitTitle(win: Win, text: string, ms = 4000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (win.getTitle().includes(text)) return true
      await sleep(60)
    }
    return false
  }

  async function waitSettings(
    predicate: (s: Record<string, unknown>) => boolean,
    ms = 4000
  ): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      try {
        if (predicate(await readSettings())) return true
      } catch {
        /* 写盘途中可能读到半截,下一次再试 */
      }
      await sleep(60)
    }
    return false
  }

  /**
   * 开一个窗口并等界面**稳定下来**。
   *
   * 不能只等「出现了 picker 或 app-shell」:自动恢复仓库时视图先经过一次 picker
   * (初始值)才切到编辑器,早一步返回就会对着选择界面做后续断言。
   */
  async function openWindow(expect: 'editor' | 'picker' = 'editor'): Promise<Win> {
    const win = createMainWindow(await loadSettings())
    // 隐藏窗口默认会被 Chromium 降频,定时器/渲染变慢会让等待变得不可预测
    win.webContents.setBackgroundThrottling(false)
    const wc = win.webContents
    await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    if (expect === 'picker') {
      await waitFor(win, `document.querySelector('.vault-picker')`)
    } else {
      // 编辑器视图 + 文件树(或空状态)都就位,才算这一窗准备好了
      await waitFor(win, `document.querySelector('.app-shell')`)
      await waitFor(win, `document.querySelector('.explorer-file') || document.querySelector('.editor-empty-hint')`)
    }
    const diag = await evalJs<{
      files: string[]
      vault: string
      picker: boolean
      openVaultButton: boolean
    }>(
      win,
      `({
        files: [...document.querySelectorAll('.explorer-file')].map(el => el.getAttribute('title')),
        vault: document.querySelector('.status-vault')?.textContent?.trim() ?? '',
        picker: !!document.querySelector('.vault-picker'),
        openVaultButton: !!document.querySelector('.explorer-open-vault')
      })`
    )
    console.log(
      `     [窗口] title=${JSON.stringify(win.getTitle())} 仓库=${JSON.stringify(diag.vault)} picker=${diag.picker} 空仓库按钮=${diag.openVaultButton} 文件行=${JSON.stringify(diag.files)}`
    )
    return win
  }

  async function closeWindow(win: Win): Promise<void> {
    // destroy 不走 close 事件(不会触发未保存确认),closed 里主进程会把引用清掉
    win.destroy()
    await sleep(250)
  }

  /** 「没有打开页面」的界面事实 */
  async function noDocumentState(win: Win): Promise<{
    hint: boolean
    fileLabel: boolean
    content: string
    title: string
    statusText: string
  }> {
    const dom = await evalJs<{
      hint: boolean
      fileLabel: boolean
      content: string
      statusText: string
    }>(win, `(() => {
      const content = document.querySelector('.cm-content')
      return {
        hint: !!document.querySelector('.editor-empty-hint'),
        fileLabel: !!document.querySelector('.status-file'),
        content: content ? content.textContent : '(没有编辑器)',
        statusText: document.querySelector('.status-bar')?.textContent ?? ''
      }
    })()`)
    // 窗口标题是主进程设的,不在 document.title 里 —— 必须问 BrowserWindow
    return { ...dom, title: win.getTitle() }
  }

  const contentHas = (win: Win, text: string): Promise<boolean> =>
    waitFor(win, `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(text)})`)

  const clickFile = (win: Win, path: string): Promise<boolean> =>
    evalJs<boolean>(
      win,
      `(() => {
        const row = [...document.querySelectorAll('.explorer-file')].find(
          el => el.getAttribute('title') === ${JSON.stringify(path)}
        )
        if (!row) return false
        row.click()
        return true
      })()`
    )

  // ------------------------------------------------------------------
  console.log('\n【A】没有上次打开的页面 → 启动后什么都不打开')
  {
    const win = await openWindow()
    const ready = await waitFor(win, `document.querySelector('.editor-empty-hint')`)
    check('进入编辑器且显示空状态提示', ready)
    const state = await noDocumentState(win)
    check('编辑区没有内容', state.content.trim() === '', JSON.stringify(state.content))
    check('状态栏不写「未命名」', !state.fileLabel && !state.statusText.includes('未命名'), state.statusText)
    check('窗口标题不写「未命名」', !state.title.includes('未命名') && state.title.includes(basename(vault)), state.title)
    check('盘上的 lastFile 仍是空', (await readSettings()).lastFile === null)
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【B】没有页面时关掉再启动 → 依旧什么都不打开(不会冒出未命名文档)')
  {
    const win = await openWindow()
    const ready = await waitFor(win, `document.querySelector('.editor-empty-hint')`)
    const state = await noDocumentState(win)
    check('重启后仍是空状态', ready && state.content.trim() === '' && !state.fileLabel)
    check('标题仍只有仓库名', state.title === `${basename(vault)} - iMark`, state.title)
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【C】打开一个文件 → 关闭 → 启动后恢复它')
  {
    const win = await openWindow()
    check('文件树里能点到那个文件', await clickFile(win, note))
    check('编辑器装载了文件内容', await contentHas(win, '关闭前打开的那一页'))
    check('状态栏显示文件名', await waitFor(win, `document.querySelector('.status-file')?.textContent?.includes('笔记.md')`))
    check('lastFile 记录了它', await waitSettings(s => s.lastFile === note), String((await readSettings()).lastFile))
    await closeWindow(win)
  }
  {
    const win = await openWindow()
    check('重启后恢复打开的页面', await contentHas(win, '关闭前打开的那一页'))
    check('没有空状态提示', !(await evalJs<boolean>(win, `!!document.querySelector('.editor-empty-hint')`)))
    check('窗口标题写着文件名', await waitTitle(win, '笔记.md'))
    check('编辑区是那个文件', await evalJs<boolean>(win, `!!document.querySelector('.explorer-file-active')`))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【D】Ctrl+N 新建未命名文档 → 关闭 → 启动后什么都不打开')
  {
    const win = await openWindow()
    await contentHas(win, '关闭前打开的那一页')
    win.webContents.send(IPC.MenuCommand, 'file:new')
    check('编辑器清空', await waitFor(win, `document.querySelector('.cm-content')?.textContent?.trim() === ''`))
    check('此时是一份未命名文档(有文件名、无空状态提示)', await waitFor(win, `document.querySelector('.status-file')?.textContent?.includes('未命名')`))
    check('lastFile 被清空', await waitSettings(s => s.lastFile === null), String((await readSettings()).lastFile))
    await closeWindow(win)
  }
  {
    const win = await openWindow()
    // 未命名页本身恢复不了,但它旁边的文件标签没有被关掉,仍然该恢复
    check('重启后恢复了后台的文件标签', await contentHas(win, '关闭前打开的那一页'))
    check(
      '但没有恢复未命名文档',
      await waitFor(win, `!document.querySelector('.status-file')?.textContent?.includes('未命名')`)
    )
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【E】回到仓库选择界面 → 关闭 → 启动后什么都不打开')
  {
    const win = await openWindow()
    await clickFile(win, note)
    await contentHas(win, '关闭前打开的那一页')
    check('打开后 lastFile 有值', await waitSettings(s => s.lastFile === note))
    const clicked = await evalJs<boolean>(
      win,
      `(() => { const b = document.querySelector('.status-vault'); if (!b) return false; b.click(); return true })()`
    )
    check('回到选择界面', clicked && (await waitFor(win, `document.querySelector('.vault-picker')`)))
    check('lastFile 被清空', await waitSettings(s => s.lastFile === null), String((await readSettings()).lastFile))
    await closeWindow(win)
  }
  {
    const win = await openWindow()
    const ready = await waitFor(win, `document.querySelector('.editor-empty-hint')`)
    check('重启后没有恢复任何页面', ready && !(await evalJs<boolean>(win, `!!document.querySelector('.status-file')`)))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【F】上次的文件已被删除 → 不打开任何东西,并清掉记忆')
  {
    await saveSettings({ lastFile: join(vault, '已经删掉.md') })
    const win = await openWindow()
    const ready = await waitFor(win, `document.querySelector('.editor-empty-hint')`)
    check('文件不存在时不打开空壳文档', ready)
    check('lastFile 被清掉', await waitSettings(s => s.lastFile === null), String((await readSettings()).lastFile))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【H】不自动进仓库 + 上次没有页面 → 选中仓库后仍然什么都不打开')
  {
    await saveSettings({ skipVaultPicker: false, lastFile: null, vaults: [vault], vaultPath: vault })
    const win = await openWindow('picker')
    check('启动停在仓库选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    const clicked = await evalJs<boolean>(
      win,
      `(() => { const row = document.querySelector('.vault-row'); if (!row) return false; row.click(); return true })()`
    )
    check('选择仓库后进入编辑器', clicked && (await waitFor(win, `document.querySelector('.app-shell')`)))
    check('进入编辑器后是空状态', await waitFor(win, `document.querySelector('.editor-empty-hint')`))
    // 真实使用里不会在进编辑器的那一帧就断言 —— 给迟到的事务/焦点处理留出时间,
    // 否则「先显示空状态、随后悄悄冒出未命名文档」会从断言缝里溜过去
    await sleep(3000)
    const state = await noDocumentState(win)
    check('停留几秒后仍显示空状态提示', await evalJs<boolean>(win, `!!document.querySelector('.editor-empty-hint')`))
    check('停留几秒后仍没有文档', !state.fileLabel && !state.statusText.includes('未命名'), state.statusText)
    check('停留几秒后标题仍只有仓库名', state.title === `${basename(vault)} - iMark`, state.title)
    check('停留几秒后编辑区仍没有内容', state.content.trim() === '', JSON.stringify(state.content))

    // 空状态不是一份「等你输入」的空文档:光标不出现,打字也不该把它变成未命名
    const editable = await evalJs<string>(
      win,
      `document.querySelector('.cm-content')?.getAttribute('contenteditable') ?? '(没有编辑器)'`
    )
    check('空状态编辑器是只读的', editable === 'false', editable)
    check(
      '空状态编辑器没有焦点',
      !(await evalJs<boolean>(win, `document.activeElement === document.querySelector('.cm-content')`))
    )

    // 即便绕过遮罩直接聚焦并输入,也不能凭空产生一份「未命名」文档
    await evalJs(win, `document.querySelector('.cm-content')?.focus(); true`)
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' })
    await sleep(500)
    check(
      '聚焦后输入不会冒出未命名文档',
      await evalJs<boolean>(
        win,
        `!document.querySelector('.status-file') && document.querySelector('.cm-content')?.textContent?.trim() === ''`
      )
    )

    // 真实鼠标点击落在遮罩上:不该聚焦编辑器,随后的输入同样无效
    const spot = await evalJs<{ x: number; y: number }>(
      win,
      `(() => {
        const r = document.querySelector('.editor-pane').getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`
    )
    win.webContents.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'y' })
    await sleep(500)
    check(
      '点击空编辑区不会聚焦、也不会开始文档',
      await evalJs<boolean>(
        win,
        `document.activeElement !== document.querySelector('.cm-content') &&
         !document.querySelector('.status-file') &&
         !!document.querySelector('.editor-empty-hint')`
      )
    )

    // Ctrl+N 仍然是明确的新建入口,而且新建后必须能正常输入
    win.webContents.send(IPC.MenuCommand, 'file:new')
    check(
      'Ctrl+N 新建未命名文档',
      await waitFor(win, `document.querySelector('.status-file')?.textContent?.includes('未命名')`)
    )
    check(
      '新建后编辑器恢复可写',
      (await evalJs<string>(
        win,
        `document.querySelector('.cm-content')?.getAttribute('contenteditable') ?? ''`
      )) === 'true'
    )
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'z' })
    check('新建后输入真的进入了文档', await contentHas(win, 'z'))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【G】不自动进仓库(选择界面启动)→ 选中仓库后仍恢复上次页面')
  {
    await saveSettings({ skipVaultPicker: false, lastFile: note, vaults: [vault], vaultPath: vault })
    const win = await openWindow('picker')
    check('启动停在仓库选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    const clicked = await evalJs<boolean>(
      win,
      `(() => { const row = document.querySelector('.vault-row'); if (!row) return false; row.click(); return true })()`
    )
    check('选择仓库后恢复了上次的页面', clicked && (await contentHas(win, '关闭前打开的那一页')))
    check('恢复时没有把 lastFile 弄丢', await waitSettings(s => s.lastFile === note))
    await closeWindow(win)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[session-restore] 未捕获异常:', err)
  app.exit(1)
})
