/**
 * 验收:双击 .md(或「打开方式」)时直接显示文件,不再先要求选仓库。
 *
 * 规则:
 *   A 启动参数里带文件,文件属于某个最近用过的仓库 → 不出现选择界面,
 *     顺带载入那个仓库,编辑器里是这份文件;
 *   B 启动参数里带文件,文件不属于任何已知仓库 → 仍然直接打开它,
 *     但不把它的上级目录偷偷登记成仓库(文件浏览器显示「打开仓库...」);
 *   C 勾了「直接打开上次仓库」而文件在另一个仓库 → 以文件所属仓库为准,
 *     不去恢复上次仓库的会话;
 *   D 应用已经停在选择界面时,第二个实例递来文件 → 同样直接打开。
 *
 * 跑法(仓库根目录):
 *   xvfb-run -a node verify/run.mjs system-open --disable-gpu
 */

import { app, BrowserWindow, protocol } from 'electron'
import { APP_VERSION } from './appVersion'
import { basename, join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings, saveSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { setPendingOpenFile } from '../src/main/openFile'
import { createMainWindow } from '../src/main/window'
import { IPC } from '../src/shared/ipc-channels'

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

/** 验收窗口一律不显示(见 session-restore-harness 的说明) */
const proto = BrowserWindow.prototype as unknown as Record<string, () => void>
proto.show = () => {}
proto.maximize = () => {}
proto.unmaximize = () => {}

type Win = BrowserWindow

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs system-open` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})

  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vaultA = join(ud, '仓库甲')
  const vaultB = join(ud, '仓库乙')
  const outside = join(ud, '仓库外')
  const noteA = join(vaultA, '甲笔记.md')
  const noteB = join(vaultB, '乙笔记.md')
  const noteOutside = join(outside, '外部笔记.md')
  const textA = '# 甲笔记\n\n来自仓库甲的文件。\n'
  const textB = '# 乙笔记\n\n上次仓库里的文件。\n'
  const textOutside = '# 外部笔记\n\n不在任何仓库里。\n'

  await rm(vaultA, { recursive: true, force: true })
  await rm(vaultB, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
  await mkdir(vaultA, { recursive: true })
  await mkdir(vaultB, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(noteA, textA, 'utf8')
  await writeFile(noteB, textB, 'utf8')
  await writeFile(noteOutside, textOutside, 'utf8')

  await loadSettings()
  await initExtensions({ appVersion: APP_VERSION })

  const settingsFile = join(ud, 'settings.json')
  const readSettings = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>

  function evalJs<T>(win: Win, code: string): Promise<T> {
    return win.webContents.executeJavaScript(code, true) as Promise<T>
  }

  async function waitFor(win: Win, code: string, ms = 10000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(win, `(() => { try { return !!(${code}) } catch { return false } })()`)) {
        return true
      }
      await sleep(80)
    }
    return false
  }

  const contentHas = (win: Win, text: string): Promise<boolean> =>
    waitFor(win, `document.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(text)})`)

  async function openWindow(): Promise<Win> {
    const win = createMainWindow(await loadSettings())
    win.webContents.setBackgroundThrottling(false)
    const wc = win.webContents
    await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    return win
  }

  async function closeWindow(win: Win): Promise<void> {
    win.destroy()
    await sleep(250)
  }

  /** 打开后的界面事实 */
  async function editorState(win: Win): Promise<{
    picker: boolean
    shell: boolean
    content: string
    tab: string
    vault: string
    openVaultButton: boolean
    files: string[]
  }> {
    return evalJs(win, `({
      picker: !!document.querySelector('.vault-picker'),
      shell: !!document.querySelector('.app-shell'),
      content: document.querySelector('.cm-content')?.textContent ?? '',
      tab: document.querySelector('.tab-active .tab-title')?.textContent?.trim() ?? '',
      vault: document.querySelector('.status-vault')?.textContent?.trim() ?? '',
      openVaultButton: !!document.querySelector('.explorer-open-vault'),
      files: [...document.querySelectorAll('.explorer-file')].map(el => el.getAttribute('title'))
    })`)
  }

  // ------------------------------------------------------------------
  console.log('\n【A】带文件启动,文件在最近用过的仓库里 → 直接显示文件并载入该仓库')
  {
    await saveSettings({
      skipVaultPicker: false,
      vaultPath: null,
      vaults: [vaultA],
      lastFile: null,
      openFiles: [],
      autoSaveMode: 'off',
      marketUrl: '',
      marketAutoCheck: false
    })
    setPendingOpenFile(noteA)
    const win = await openWindow()
    check('编辑器装载了文件内容', await contentHas(win, '来自仓库甲的文件'))
    const st = await editorState(win)
    check('没有停在仓库选择界面', !st.picker && st.shell, JSON.stringify(st))
    check('标签是这份文件', st.tab.includes('甲笔记'), st.tab)
    check('状态栏是文件所属的仓库', st.vault.includes(basename(vaultA)), st.vault)
    check('文件浏览器里有这份文件', st.files.includes(noteA), JSON.stringify(st.files))
    check('窗口标题写着文件名', win.getTitle().includes('甲笔记.md'), win.getTitle())
    check('设置里的 vaultPath 指向该仓库', (await readSettings()).vaultPath === vaultA)
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【B】带文件启动,文件不属于任何已知仓库 → 直接打开,但不擅自建仓库')
  {
    await saveSettings({
      skipVaultPicker: false,
      vaultPath: null,
      vaults: [vaultA],
      lastFile: null,
      openFiles: []
    })
    setPendingOpenFile(noteOutside)
    const win = await openWindow()
    check('编辑器装载了文件内容', await contentHas(win, '不在任何仓库里'))
    const st = await editorState(win)
    check('没有停在仓库选择界面', !st.picker && st.shell, JSON.stringify(st))
    check('标签是这份文件', st.tab.includes('外部笔记'), st.tab)
    check('没有把上级目录登记成仓库', st.vault === '', st.vault)
    check('文件浏览器给出手动打开仓库的入口', st.openVaultButton, JSON.stringify(st))
    check('窗口标题写着文件名', win.getTitle().includes('外部笔记.md'), win.getTitle())
    check('设置里没有冒出新仓库', JSON.stringify((await readSettings()).vaults) === JSON.stringify([vaultA]))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【C】勾了「直接打开上次仓库」时,带文件启动以文件所属仓库为准')
  {
    await saveSettings({
      skipVaultPicker: true,
      vaultPath: vaultB,
      vaults: [vaultB, vaultA],
      lastFile: noteB,
      openFiles: [noteB]
    })
    setPendingOpenFile(noteA)
    const win = await openWindow()
    check('编辑器装载的是双击的那份文件', await contentHas(win, '来自仓库甲的文件'))
    const st = await editorState(win)
    check('没有恢复上次仓库的页面', !st.content.includes('上次仓库里的文件'), st.content)
    check('状态栏切到了文件所属仓库', st.vault.includes(basename(vaultA)), st.vault)
    check('只有一个标签', await evalJs<boolean>(win, `document.querySelectorAll('.tab-bar .tab').length === 1`))
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【D】已经停在选择界面时,第二个实例递来文件 → 直接打开')
  {
    await saveSettings({
      skipVaultPicker: false,
      vaultPath: null,
      vaults: [vaultA],
      lastFile: null,
      openFiles: []
    })
    const win = await openWindow()
    check('启动停在仓库选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    // 等渲染层把 onOpenFile 监听挂上(它紧跟初始化完成注册)
    await sleep(600)
    win.webContents.send(IPC.OpenFileFromSystem, noteA)
    check('文件被直接打开', await contentHas(win, '来自仓库甲的文件'))
    const st = await editorState(win)
    check('从选择界面切到了编辑器', !st.picker && st.shell, JSON.stringify(st))
    check('顺带载入了文件所属仓库', st.vault.includes(basename(vaultA)), st.vault)
    await closeWindow(win)
  }

  // ------------------------------------------------------------------
  console.log('\n【E】停在选择界面(之前有仓库)时打开仓库外的文件 → 不残留旧仓库')
  {
    await saveSettings({
      skipVaultPicker: true,
      vaultPath: vaultB,
      vaults: [vaultB],
      lastFile: null,
      openFiles: []
    })
    const win = await openWindow()
    check('先进入仓库乙的编辑器', await waitFor(win, `document.querySelector('.app-shell')`))
    const atVault = await editorState(win)
    check('侧栏是仓库乙', atVault.vault.includes(basename(vaultB)), atVault.vault)
    // 状态栏仓库名 → 回到选择界面(与用户「打开另一个仓库」的操作一致)
    await evalJs<boolean>(win, `(() => { const b = document.querySelector('.status-vault'); if (!b) return false; b.click(); return true })()`)
    check('回到选择界面', await waitFor(win, `document.querySelector('.vault-picker')`))
    win.webContents.send(IPC.OpenFileFromSystem, noteOutside)
    check('仓库外的文件被直接打开', await contentHas(win, '不在任何仓库里'))
    const st = await editorState(win)
    check('没有残留的旧仓库(侧栏是「打开仓库...」)', st.openVaultButton && st.vault === '', JSON.stringify(st))
    await closeWindow(win)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('[system-open] 未捕获异常:', err)
  app.exit(1)
})
