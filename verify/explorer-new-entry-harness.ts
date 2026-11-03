/**
 * 文件树「新建」输入行的落点。
 *
 * 现象:点某个目录行上的「新建文件 / 新建文件夹」,输入行永远出现在列表最前
 * (仓库根的位置),看不出到底在哪个目录里建。正确的位置是**目标父目录展开后
 * 的第一个子项**,缩进也跟着父目录的层级走;只有从顶部工具栏新建(父目录 =
 * 仓库根)时才出现在最前。
 *
 * 断言:
 *   A 目录行「新建文件」→ 输入行紧跟该目录行、在它第一个子项之前,缩进 +1 层
 *   B 输入框自动聚焦;输入名字回车 → 文件真的建在那个目录里
 *   C 工具栏「新建文件」(仓库根)→ 输入行在列表最前,缩进第一层
 *   D 右键菜单「新建文件」→ 同样落在该目录下
 *   E 目录行「新建文件夹」→ 同样落在该目录下,并建出子目录
 *   F 重命名输入行仍在原位且自动聚焦(顺带回归重构后的聚焦方式)
 *
 * 跑法(先 `npm run build`):
 *   xvfb-run -a node verify/run.mjs explorer-new-entry
 */

import { app, BrowserWindow, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

interface EditInfo {
  /** 输入行是否存在 */
  found: boolean
  /** 输入行前面 / 后面的兄弟行说明(名字或位置) */
  prev: string | null
  next: string | null
  /** 输入行与父目录行的 paddingLeft */
  padding: number | null
  parentPadding: number | null
  focused: boolean
  /** 输入行是不是列表里的第一个 .explorer-item */
  first: boolean
  index: number
}

const EDIT_INFO = (name: string) => `
(() => {
  const items = [...document.querySelectorAll('.explorer-list .explorer-item')]
  const input = document.querySelector('.explorer-editing input')
  if (!input) return { found: false, prev: null, next: null, padding: null, parentPadding: null, focused: false, first: false, index: -1 }
  const row = input.closest('.explorer-item')
  const idx = items.indexOf(row)
  const label = el => {
    if (!el) return null
    if (!el.classList.contains('explorer-item')) return '<' + el.tagName.toLowerCase() + '>'
    const n = el.querySelector('.explorer-name')
    return n ? n.textContent : '(editing)'
  }
  const dir = items.find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
  const px = el => el ? parseFloat(getComputedStyle(el).paddingLeft) : null
  return {
    found: true,
    prev: label(row.previousElementSibling),
    next: label(row.nextElementSibling),
    padding: px(row),
    parentPadding: px(dir),
    focused: document.activeElement === input,
    first: idx === 0,
    index: idx
  }
})()`

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs explorer-new-entry` 跑会自动带上)')
    app.exit(2)
    return
  }

  app.on('window-all-closed', () => {})
  await app.whenReady()
  registerIpc()
  registerImarkProtocol()

  const ud = app.getPath('userData')
  const vault = join(ud, 'vault')
  /** 路径一律相对仓库根,拼成绝对路径再落盘(相对路径会写进当前工作目录) */
  const mk = async (rel: string, text?: string): Promise<void> => {
    const p = join(vault, rel)
    await mkdir(dirname(p), { recursive: true })
    if (text !== undefined) await writeFile(p, text, 'utf8')
    else await mkdir(p, { recursive: true })
  }
  await rm(vault, { recursive: true, force: true })
  await mkdir(vault, { recursive: true })
  await mk('ros2/assets')
  await mk('ros2/C++工程化/接口.md', '# 接口\n')
  await mk('ros2/C++工程化/数据类型.md', '# 数据类型\n')
  await mk('ros2/ros2-moveit2/管线.md', '# 管线\n')
  await mk('ros2/ros2-moveit2/配置打包器.md', '# 配置打包器\n')
  await mk('vla/pi0.5.md', '# pi0.5\n')
  const lastFile = join(vault, 'ros2/ros2-moveit2/管线.md')
  await writeFile(
    join(ud, 'settings.json'),
    JSON.stringify(
      {
        skipVaultPicker: true,
        vaultPath: vault,
        vaults: [vault],
        lastFile,
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
  const editInfo = (name: string): Promise<EditInfo> => evalJs<EditInfo>(EDIT_INFO(name))
  const rowNames = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.explorer-list .explorer-item .explorer-name')].map(e => e.textContent)`)

  const clickRow = (name: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
        .find(el => el.querySelector('.explorer-name')?.textContent === ${JSON.stringify(name)})
      if (!row) return false
      row.click()
      return true
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

  const typeAndEnter = (value: string): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return false
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)

  const escape = (): Promise<boolean> =>
    evalJs<boolean>(`(() => {
      const input = document.querySelector('.explorer-editing input')
      if (!input) return true
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)

  // 等仓库树出现(首层目录自动展开)
  const treeReady = await waitFor(`document.querySelector('.explorer-list .explorer-name')`)
  check('仓库树已加载', treeReady)
  await sleep(300)

  // 展开 ros2-moveit2(嵌套目录默认收起)
  await clickRow('ros2-moveit2')
  await sleep(300)
  check('ros2-moveit2 已展开(能看到 管线.md)', (await rowNames()).includes('管线.md'))

  // ---------- A ----------
  console.log('\n【A】目录行「新建文件」:输入行落在该目录下')
  await clickRowAction('ros2-moveit2', '新建文件')
  const aReady = await waitFor(`document.querySelector('.explorer-editing input')`)
  check('出现新建输入行', aReady)
  const a = await editInfo('ros2-moveit2')
  console.log(`     prev=${a.prev} next=${a.next} padding=${a.padding}/${a.parentPadding}`)
  check('紧跟在 ros2-moveit2 目录行之后(不是在列表最前)', a.prev === 'ros2-moveit2' && !a.first, JSON.stringify([a.prev, a.first, a.index]))
  check('位于该目录第一个子项之前', a.next === '管线.md', String(a.next))
  check('缩进比父目录深一层', a.padding !== null && a.parentPadding !== null && a.padding === a.parentPadding + 14, `${a.padding} vs ${a.parentPadding}`)
  check('输入框自动聚焦', a.focused)

  // ---------- B ----------
  console.log('\n【B】输入名字回车:文件建在目标目录里')
  check('输入行接受输入', await typeAndEnter('新文件'))
  const created = join(vault, 'ros2/ros2-moveit2/新文件.md')
  const createdOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(created)) return true
      await sleep(80)
    }
    return false
  })()
  check('文件建在 ros2/ros2-moveit2/ 下', createdOk, created)
  // 落盘之后还要等 IPC 返回 + 刷新仓库,输入行才会收起
  check('建完后输入行消失', await waitFor(`!document.querySelector('.explorer-editing input')`))
  await sleep(400)
  const namesAfterCreate = await rowNames()
  check('新文件出现在树里', namesAfterCreate.includes('新文件.md'), JSON.stringify(namesAfterCreate))

  // ---------- C ----------
  console.log('\n【C】工具栏「新建文件」(仓库根):输入行在最前')
  await escape()
  await evalJs(`(() => {
    const btn = document.querySelector('.explorer-header button[title="新建文件"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const c = await editInfo('新文件.md')
  console.log(`     prev=${c.prev} next=${c.next} padding=${c.padding}`)
  check('输入行是列表里的第一个 .explorer-item', c.first && c.prev === null, JSON.stringify([c.prev, c.first, c.index]))
  check('下一行是第一个顶层项', c.next === 'ros2', String(c.next))
  check('缩进为第一层(8 + 1*14)', c.padding === 22, String(c.padding))
  check('输入框自动聚焦', c.focused)
  await escape()
  await sleep(200)

  // ---------- D ----------
  console.log('\n【D】右键菜单「新建文件」:同样落在该目录下')
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.explorer-list .explorer-item')]
      .find(el => el.querySelector('.explorer-name')?.textContent === 'ros2-moveit2')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 260 }))
    return true
  })()`)
  await waitFor(`document.querySelector('.explorer-menu')`)
  const menuClicked = await evalJs<boolean>(`(() => {
    const item = [...document.querySelectorAll('.explorer-menu-item')]
      .find(el => el.querySelector('.explorer-menu-label')?.textContent === '新建文件')
    if (!item) return false
    item.click()
    return true
  })()`)
  check('右键菜单里点到「新建文件」', menuClicked)
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const d = await editInfo('ros2-moveit2')
  console.log(`     prev=${d.prev} next=${d.next} padding=${d.padding}/${d.parentPadding}`)
  check('输入行紧跟 ros2-moveit2 目录行', d.prev === 'ros2-moveit2' && !d.first, JSON.stringify([d.prev, d.first]))
  check('缩进比父目录深一层', d.padding !== null && d.parentPadding !== null && d.padding === d.parentPadding + 14, `${d.padding} vs ${d.parentPadding}`)
  await escape()
  await sleep(200)

  // ---------- E ----------
  console.log('\n【E】目录行「新建文件夹」:同样落在该目录下,并建出子目录')
  await clickRowAction('ros2-moveit2', '新建文件夹')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const e = await editInfo('ros2-moveit2')
  console.log(`     prev=${e.prev} next=${e.next} padding=${e.padding}/${e.parentPadding}`)
  check('输入行紧跟 ros2-moveit2 目录行', e.prev === 'ros2-moveit2' && !e.first, JSON.stringify([e.prev, e.first]))
  check('缩进比父目录深一层', e.padding !== null && e.parentPadding !== null && e.padding === e.parentPadding + 14, `${e.padding} vs ${e.parentPadding}`)
  check('焦点在输入框', e.focused)
  await typeAndEnter('新目录')
  const dirCreated = join(vault, 'ros2/ros2-moveit2/新目录')
  const dirOk = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(dirCreated)) return true
      await sleep(80)
    }
    return false
  })()
  check('子目录真的建出来了', dirOk, dirCreated)

  // ---------- F ----------
  console.log('\n【F】重命名输入行:仍在原位且自动聚焦')
  await escape()
  await sleep(300)
  await clickRowAction('管线.md', '重命名')
  await waitFor(`document.querySelector('.explorer-editing input')`)
  const f = await editInfo('管线.md')
  const renameValue = await evalJs<string>(`document.querySelector('.explorer-editing input').value`)
  console.log(`     value=${renameValue} padding=${f.padding}`)
  check('重命名输入框带原文件名', renameValue === '管线.md', renameValue)
  check('重命名输入行在文件原来的位置(不是列表最前)', !f.first, String(f.index))
  check('重命名输入框自动聚焦', f.focused)
  await escape()

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.exit(fail === 0 ? 0 : 1)
}

void main()
