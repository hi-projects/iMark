/**
 * 验收:标签右键菜单的「关闭其余标签 / 关闭所有标签」。
 *
 * 断言:
 *   A 右键标签弹出菜单,两个条目都在
 *   B 「关闭其余标签」只留被点的那个,并保持激活
 *   C 只剩一个标签时「关闭其余标签」不可用
 *   D 「关闭所有标签」清空标签栏,编辑器回到空状态
 *   E 关闭过程中遇到脏标签会询问;选「取消」就停下,不会静默丢掉后面的标签
 *
 * 跑法(先 `npm run build`;无头环境用 xvfb-run):
 *   xvfb-run -a node verify/run.mjs tab-close-menu
 */

import { app, BrowserWindow, dialog, protocol } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// 验收窗口全程隐藏
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
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 原生「是否保存」对话框:默认 1 = 不保存;2 = 取消 */
const dialogQueue: number[] = []
;(dialog as unknown as { showMessageBoxSync: unknown }).showMessageBoxSync = () => dialogQueue.shift() ?? 1
;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
  canceled: true,
  filePath: undefined
})
;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
  canceled: true,
  filePaths: []
})

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs tab-close-menu` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  const notes = ['甲', '乙', '丙'].map(name => join(vault, `${name}.md`))
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  for (const [i, path] of notes.entries()) {
    await writeFile(path, `# ${['甲', '乙', '丙'][i]}\n\n第 ${i + 1} 份文档。\n`, 'utf8')
  }
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile: null,
        openFiles: [],
        autoSaveMode: 'off',
        marketUrl: '',
        marketAutoCheck: false
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

  const tabCount = (): Promise<number> => evalJs<number>(`document.querySelectorAll('.tab').length`)
  const tabLabels = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.tab-title')].map(el => el.textContent.trim())`)
  const activeLabel = (): Promise<string> =>
    evalJs<string>(`document.querySelector('.tab-active .tab-title')?.textContent?.trim() ?? ''`)

  const clickFile = (path: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = [...document.querySelectorAll('.explorer-file')]
        .find(e => e.getAttribute('title') === ${JSON.stringify(path)})
      if (!el) return false
      el.click()
      return true
    })()`)

  const clickTab = (index: number): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = document.querySelectorAll('.tab')[${index}]
      if (!el) return false
      el.click()
      return true
    })()`)

  const rightClickTab = (index: number): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = document.querySelectorAll('.tab')[${index}]
      if (!el) return false
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 60 }))
      return true
    })()`)

  const menuLabels = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.tab-menu-item')].map(el => el.textContent.trim())`)

  const clickMenu = (label: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const el = [...document.querySelectorAll('.tab-menu-item')]
        .find(item => item.textContent.trim() === ${JSON.stringify(label)})
      if (!el) return false
      el.click()
      return true
    })()`)

  const closeMenu = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      document.querySelector('.tab-menu-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)

  async function openThree(): Promise<void> {
    for (const path of notes) {
      await clickFile(path)
      await sleep(250)
    }
  }

  check('标签栏存在', await waitFor(`document.querySelector('.tab-bar')`))
  check('仓库文件已列出', await waitFor(`document.querySelectorAll('.explorer-file').length === 3`))

  // ---------- A ----------
  console.log('\n【A】右键标签弹出菜单')
  await openThree()
  check('三个标签都开了', (await tabCount()) === 3 && (await tabLabels()).join(',') === '甲,乙,丙')
  check('点第二个标签', await clickTab(1))
  check('右键第二个标签', await rightClickTab(1))
  check('菜单出现', await waitFor(`document.querySelector('.tab-menu')`))
  const labels = await menuLabels()
  console.log(`     菜单:${JSON.stringify(labels)}`)
  check('有「关闭其余标签」', labels.includes('关闭其余标签'), JSON.stringify(labels))
  check('有「关闭所有标签」', labels.includes('关闭所有标签'), JSON.stringify(labels))

  // ---------- B ----------
  console.log('\n【B】关闭其余标签')
  check('点「关闭其余标签」', await clickMenu('关闭其余标签'))
  check('只剩被点的那个标签', await waitFor(`document.querySelectorAll('.tab').length === 1`))
  check('留下的是乙', (await tabLabels()).join(',') === '乙', JSON.stringify(await tabLabels()))
  check('乙仍是激活标签', (await activeLabel()) === '乙')
  check('编辑器里是乙', await waitFor(`document.querySelector('.cm-content')?.textContent?.includes('第 2 份文档')`))

  // ---------- C ----------
  console.log('\n【C】只剩一个标签时「关闭其余标签」不可用')
  check('右键唯一的标签', await rightClickTab(0))
  check('菜单出现', await waitFor(`document.querySelector('.tab-menu-item')`))
  const disabled = await evalJs<string[]>(
    `[...document.querySelectorAll('.tab-menu-item:disabled')].map(el => el.textContent.trim())`
  )
  check('「关闭其余标签」处于禁用态', disabled.includes('关闭其余标签'), JSON.stringify(disabled))
  await closeMenu()
  await sleep(150)

  // ---------- D ----------
  console.log('\n【D】关闭所有标签')
  await clickFile(notes[0]!)
  await clickFile(notes[2]!)
  check('重新打开到三个标签', await waitFor(`document.querySelectorAll('.tab').length === 3`), JSON.stringify(await tabLabels()))
  check('右键任一标签', await rightClickTab(0))
  check('点「关闭所有标签」', await clickMenu('关闭所有标签'))
  check('标签栏清空', await waitFor(`document.querySelectorAll('.tab').length === 0`))
  check('编辑器回到空状态', await waitFor(`document.querySelector('.editor-empty-hint')`))

  // ---------- E ----------
  console.log('\n【E】脏标签取消关闭 → 停下,不丢后面的标签')
  await clickFile(notes[0]!)
  await waitFor(`document.querySelector('.cm-content')?.textContent?.includes('第 1 份文档')`)
  // 空状态转回来时视图可能还没拿焦点,合成按键会被静默丢掉
  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  wc.sendInputEvent({ type: 'char', keyCode: 'X' })
  check('甲变脏', await waitFor(`document.querySelectorAll('.tab')[0]?.classList.contains('tab-dirty')`))
  await clickFile(notes[1]!)
  await waitFor(`document.querySelector('.cm-content')?.textContent?.includes('第 2 份文档')`)
  await evalJs(`(() => { document.querySelector('.cm-content')?.focus(); return true })()`)
  wc.sendInputEvent({ type: 'char', keyCode: 'Y' })
  check('乙也变脏', await waitFor(`document.querySelectorAll('.tab')[1]?.classList.contains('tab-dirty')`))
  dialogQueue.push(2) // 取消
  check('右键并关闭所有', (await rightClickTab(0)) && (await waitFor(`document.querySelector('.tab-menu')`)) && (await clickMenu('关闭所有标签')))
  await sleep(500)
  check('两个标签都还在', (await tabCount()) === 2, JSON.stringify(await tabLabels()))
  check('取消没有改动任何内容', (await tabLabels()).join(',') === '甲,乙', JSON.stringify(await tabLabels()))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
