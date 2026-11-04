/**
 * 文件树导出 HTML:文件行悬停操作 + 右键菜单。
 *
 * 断言:
 *   A 文件行有「导出 HTML」按钮(和重命名/删除并排)
 *   B 点按钮 → 用磁盘上的正文渲染出 HTML,默认文件名跟随笔记名
 *   C 右键文件 → 菜单里有「导出 HTML...」,点了同样能落盘
 *   D 右键目录 → 菜单里没有导出(目录导不出东西)
 *   E 已经打开、且有未保存改动的文件 → 导出的是编辑器里的正文,不是旧盘面
 *
 * 跑法(先 `npm run build`;无头环境用 xvfb-run,窗口不会真的弹出来):
 *   xvfb-run -a node verify/run.mjs explorer-export
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}  —— ${detail}`)
  }
}

/** 保存对话框排队的落点;队列空 = 用户点了取消 */
const saveQueue: string[] = []
let lastDefaultPath = ''

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs explorer-export` 跑会自动带上)')
    app.exit(2)
    return
  }

  // 不弹真对话框:测试要的是「点了导出之后写出来什么」,不是系统保存面板长什么样
  const dialogStub = dialog as unknown as {
    showSaveDialog: (
      win: unknown,
      o: { defaultPath?: string }
    ) => Promise<{ canceled: boolean; filePath?: string }>
  }
  dialogStub.showSaveDialog = async (_win, o) => {
    lastDefaultPath = o.defaultPath ?? ''
    const target = saveQueue.shift()
    return target ? { canceled: false, filePath: target } : { canceled: true }
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const diskNote = join(vault, 'ros2/笔记.md')
  await rm(vault, { recursive: true, force: true })
  await mkdir(dirname(diskNote), { recursive: true })
  // 保存对话框选出来的目录在真实环境里总是存在的;桩返回值也得先把目录建好,
  // 否则 writeFileAtomic 写临时文件时 ENOENT(它不替调用方创建父目录)
  const outDir = join(ud, 'out')
  await mkdir(outDir, { recursive: true })
  await writeFile(diskNote, '# 磁盘标题\n\n磁盘正文\n', 'utf8')
  await writeFile(join(vault, 'ros2/另一篇.md'), '# 另一篇\n', 'utf8')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: diskNote,
        marketUrl: '',
        autoSave: false
      },
      null,
      2
    ),
    'utf8'
  )

  const settings = await loadSettings()
  const win = createMainWindow(settings)
  win.setContentSize(1000, 800)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(60)
    }
    return false
  }

  /** 展开目录、让文件行出现在列表里 */
  const clickRow = (name: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      if (!row) return false
      row.click()
      return true
    })()`)

  const rowHasAction = (name: string, title: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      return !!(row && row.querySelector('.explorer-item-actions button[title=${JSON.stringify(title)}]'))
    })()`)

  const clickRowAction = (name: string, title: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      const btn = row && row.querySelector('button[title=${JSON.stringify(title)}]')
      if (!btn) return false
      btn.click()
      return true
    })()`)

  const openMenu = (name: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      if (!row) return false
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))
      return true
    })()`)

  const menuLabels = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.explorer-menu-item .explorer-menu-label')].map(e => e.textContent ?? '')`)

  const clickMenu = (label: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const item = [...document.querySelectorAll('.explorer-menu-item')]
        .find(el => el.querySelector('.explorer-menu-label')?.textContent === ${JSON.stringify(label)})
      if (!item) return false
      item.click()
      return true
    })()`)

  const closeMenu = (): Promise<boolean> =>
    evalJs<boolean>(`(() => { document.querySelector('.explorer-menu-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true })()`)

  async function waitFile(path: string, ms = 8000): Promise<string | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (existsSync(path)) return readFile(path, 'utf8')
      await sleep(60)
    }
    return null
  }

  async function exportViaButton(name: string, target: string): Promise<string | null> {
    saveQueue.push(target)
    lastDefaultPath = ''
    if (!(await clickRowAction(name, '导出 HTML'))) return null
    return waitFile(target)
  }

  const KEY_ALIAS: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }
  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(120)
  }

  // 等仓库树出现。首层目录默认就是展开的 —— 再点一下只会收起来,
  // 所以只在看不到文件时才去展开。
  check('仓库树已加载', await waitFor(`document.querySelector('.explorer-list .explorer-name')`))
  const noteVisible = (ms = 8000): Promise<boolean> =>
    waitFor(
      `[...document.querySelectorAll('.explorer-list .explorer-name')].some(e => e.textContent === '笔记.md')`,
      ms
    )
  await sleep(300)
  if (!(await noteVisible(1500))) {
    await clickRow('ros2')
  }
  check('能看到 笔记.md', await noteVisible())

  // ---------- A ----------
  console.log('\n【A】文件行有导出按钮')
  check('文件行有「导出 HTML」按钮', await rowHasAction('笔记.md', '导出 HTML'))
  check('重命名按钮仍在', await rowHasAction('笔记.md', '重命名'))

  // ---------- B ----------
  console.log('\n【B】点按钮导出磁盘上的正文')
  const htmlOut = join(outDir, 'from-button.html')
  const html = await exportViaButton('笔记.md', htmlOut)
  check('导出的 HTML 已落盘', html !== null)
  if (html) {
    check('正文渲染进来了', html.includes('<h1>磁盘标题</h1>') && html.includes('磁盘正文'), html.slice(0, 200))
    check('默认文件名跟随笔记名', lastDefaultPath.endsWith('笔记.html'), lastDefaultPath)
  }

  // ---------- C ----------
  console.log('\n【C】右键文件菜单里有导出')
  check('右键文件打开菜单', await openMenu('笔记.md'))
  await waitFor(`document.querySelector('.explorer-menu-item')`)
  const fileMenu = await menuLabels()
  console.log(`     菜单:${JSON.stringify(fileMenu)}`)
  check('菜单里有「导出 HTML...」', fileMenu.includes('导出 HTML...'), JSON.stringify(fileMenu))
  const htmlFromMenu = join(outDir, 'from-menu.html')
  saveQueue.push(htmlFromMenu)
  check('点了菜单项', await clickMenu('导出 HTML...'))
  const menuHtml = await waitFile(htmlFromMenu)
  check('右键导出同样写出 HTML', menuHtml !== null && menuHtml.includes('磁盘标题'), String(menuHtml?.length))

  // ---------- D ----------
  console.log('\n【D】右键目录没有导出')
  await sleep(200)
  check('右键目录打开菜单', await openMenu('ros2'))
  await waitFor(`document.querySelector('.explorer-menu-item')`)
  const dirMenu = await menuLabels()
  console.log(`     菜单:${JSON.stringify(dirMenu)}`)
  check('目录菜单里没有导出', !dirMenu.some(l => l.includes('导出')), JSON.stringify(dirMenu))
  await closeMenu()
  await sleep(200)

  // ---------- E ----------
  console.log('\n【E】未保存改动也在导出里')
  check('点文件行打开它', await clickRow('笔记.md'))
  await sleep(500)
  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  await key('End', ['control'])
  for (const ch of 'DIRTY-EXPORT') {
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep(20)
  }
  await sleep(400)
  const bodyText = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
  check('编辑器里能读到刚敲的字', bodyText.includes('DIRTY-EXPORT'), bodyText.slice(-120))
  const htmlDirty = join(outDir, 'from-editor.html')
  const dirty = await exportViaButton('笔记.md', htmlDirty)
  check('导出成功', dirty !== null)
  if (dirty) {
    check('导出的是编辑器里的最新正文', dirty.includes('DIRTY-EXPORT'), dirty.slice(0, 200))
  }

  console.log(`\n通过 ${pass},失败 ${fail}`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
