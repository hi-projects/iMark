/**
 * quick-edit（v2 扩展模型）端到端验收。
 *
 * 这条链路横跨四个边界：CodeMirror 装饰（渲染层）→ 贡献点快照（主进程）
 * → 扩展宿主进程（utilityProcess 里的 `activate` / `insertTable`）
 * → 回到渲染层改文档。任何一段接错，现象都是「点了 + 什么都没发生」，
 * 所以这里盯**最终可见的结果**：DOM 里的菜单/对话框、磁盘上的文件、焦点落点。
 *
 * 覆盖：
 *   1 v2 内置包安装、清单贡献点、未命中 onCommand 前不 fork 宿主
 *   2 行首「+」按钮出现（光标行）
 *   3 菜单 →「表格」→ 对话框（只有行数/列数）→ 4×2 → 插入
 *   4 文档/磁盘内容、渲染表格、焦点落在第一个表头单元格
 *   5 取消不产生任何改动
 *   6 停用 → 菜单与按钮消失、宿主释放；重新启用 → 恢复
 *   7 卸载 → 目录与贡献点一起消失
 *
 * 跑法（在仓库根目录）：
 *   node verify/run.mjs quick-edit
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { createMainWindow } from '../src/main/window'
import { installExtensionPackage } from '../src/main/extensions/installer'
import {
  getExtensionService,
  initExtensions,
  shutdownExtensions
} from '../src/main/extensions/service'

// 打包产物固定落在 <仓库>/out/main/ 下（见 verify/run.mjs），所以由 __dirname 往上两级。
const REPO = join(__dirname, '..', '..')
const QUICK_EDIT_ID = 'imark.quick-edit'

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

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

/** 表格期望长相：2 列时空行是 `|       |       |`，分隔行是 `| :---: | :---: |` */
const BLANK_CELL = '       '
const row = (...cells: string[]): string => `|${cells.map(c => `${c}|`).join('')}`
const blank = (cols: number): string => row(...(Array(cols).fill(BLANK_CELL) as string[]))
const sep = (cols: number): string => row(...(Array(cols).fill(' :---: ') as string[]))

async function main(): Promise<void> {
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行：必须带 --user-data-dir（用 `node verify/run.mjs quick-edit` 跑会自动带上）')
    app.exit(2)
    return
  }

  await app.whenReady()

  // 原生对话框全部 stub 掉：这一轮不该弹出任何需要人点的东西
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
  // 「全新用户」：扩展目录整个抹掉，内置包由本 harness 按 v2 安装路径装进去
  await rm(join(ud, 'plugins'), { recursive: true, force: true })
  await rm(join(ud, 'extensions-data'), { recursive: true, force: true })

  const START = '第一行\n\n第三行\n'
  await writeFile(note, START, 'utf8')
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

  // 装内置的 v2 包：与市场安装走同一条校验/落盘路径（没有「因为是内置所以跳过」）
  const envelope = JSON.parse(
    await readFile(join(REPO, 'src/main/market/builtin/imark.quick-edit.imkpkg.json'), 'utf8')
  ) as unknown
  // 直接跑 electron 可执行文件时 app.getVersion() 是 Electron 的版本（44.x），
  // 不是 package.json 里的应用版本；engines.imark 要按应用版本校验。
  const APP_VERSION = '0.1.0'
  const installed = await installExtensionPackage(envelope, {
    source: 'bundled',
    appVersion: APP_VERSION
  })
  check('内置 v2 包通过校验并安装', installed.manifest.publisher === 'imark')

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  service.setRendererSender(message => {
    if (!win.isDestroyed()) wc.send(IPC.ExtensionToRenderer, message)
  })
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)
  await service.startup()

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  async function afterLoad(): Promise<void> {
    await evalJs(`(() => {
      window.__alerts = []
      window.alert = m => { window.__alerts.push(String(m)) }
      return true
    })()`)
    await focusEditor()
  }

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

  /** sendInputEvent 要的是 W3C 旧键名（`Left`/`Down`），写成 `ArrowLeft` 会被静默丢掉 */
  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(160)
  }

  const click = (sel: string): Promise<boolean> =>
    evalJs<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`
    )

  /** 「+」当前挂在第几行（1 起；没有按钮返回 -1） */
  const plusLine = (): Promise<number> =>
    evalJs<number>(`(() => {
      const i = [...document.querySelectorAll('.cm-content .cm-line')]
        .findIndex(el => el.querySelector('.line-plus'))
      return i < 0 ? -1 : i + 1
    })()`)

  const menuLabels = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.line-menu-item')].map(el => el.textContent.trim())`)

  const dialogInfo = (): Promise<{
    title: string
    labels: string[]
    values: string[]
    confirm: string
  } | null> =>
    evalJs(`
      (() => {
        const d = document.querySelector('.line-dialog')
        if (!d) return null
        return {
          title: d.querySelector('.line-dialog-head')?.textContent?.trim() ?? '',
          labels: [...d.querySelectorAll('.plugin-field-label')].map(el => el.textContent.trim()),
          values: [...d.querySelectorAll('input[type=number]')].map(el => el.value),
          confirm: d.querySelector('.line-dialog-primary')?.textContent?.trim() ?? ''
        }
      })()`)

  /** 填行数与列数。必须派 change —— PluginField 只在 change 上把值交出来 */
  const setNumbers = (rows: number, cols: number): Promise<boolean> =>
    evalJs<boolean>(`
      (() => {
        const ins = [...document.querySelectorAll('.line-dialog input[type=number]')]
        if (ins.length < 2) return false
        const put = (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })) }
        put(ins[0], ${rows}); put(ins[1], ${cols})
        return true
      })()`)

  /** 写盘 + 重载窗口，拿到一个光标在文首的干净编辑器 */
  async function loadDoc(content: string): Promise<boolean> {
    const lines = content.split('\n').length
    const ready = `document.querySelectorAll('.cm-content .cm-line').length === ${lines}`
    for (let attempt = 1; attempt <= 3; attempt++) {
      await writeFile(note, content, 'utf8')
      const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
      if (attempt === 1) wc.reload()
      else await wc.loadFile(join(__dirname, '../renderer/index.html'))
      await done
      await sleep(900)
      if (await waitFor(ready, 6000)) {
        await afterLoad()
        return true
      }
      const dom = await evalJs<string[]>(
        `[...document.querySelectorAll('.cm-content .cm-line')].map(el => el.textContent)`
      )
      console.log(`    （第 ${attempt} 次载入没等到：DOM ${JSON.stringify(dom)}）`)
    }
    return false
  }

  /** 落盘内容（触发一次保存再读文件），末尾空行不算行 */
  const readSource = async (): Promise<string[]> => {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(700)
    const lines = (await readFile(note, 'utf8')).split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** 打开「+」菜单（已经开着就不重复点）并返回条目文案 */
  async function openMenu(): Promise<string[]> {
    if (!(await evalJs<boolean>(`!!document.querySelector('.line-menu')`))) {
      if (!(await click('.line-plus'))) return []
    }
    await sleep(250)
    return menuLabels()
  }

  /** 打开「+」菜单并点某一条；fail-fast 地把中间态报出来 */
  async function openMenuAndPick(label: string): Promise<boolean> {
    const labels = await openMenu()
    if (labels.length === 0) return false
    if (!labels.includes(label)) {
      console.log(`    （菜单里只有 ${JSON.stringify(labels)}）`)
      return false
    }
    await evalJs(
      `(() => {
        const el = [...document.querySelectorAll('.line-menu-item')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
        el.click(); return true
      })()`
    )
    await sleep(250)
    return true
  }

  /** 当前焦点如果是渲染表格里的单元格，返回它的行列与可编辑态 */
  const activeTableCell = (): Promise<{ row: number; col: number; editable: string } | null> =>
    evalJs(`
      (() => {
        const el = document.activeElement
        const cell = el && el.closest ? el.closest('th,td') : null
        if (!cell || !cell.closest('.cm-md-table-widget')) return null
        return {
          row: Number(cell.dataset.row),
          col: Number(cell.dataset.col),
          editable: cell.getAttribute('contenteditable') ?? ''
        }
      })()`)

  async function waitForActiveCell(ms = 5000): Promise<{ row: number; col: number; editable: string } | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const cell = await activeTableCell()
      if (cell) return cell
      await sleep(80)
    }
    return null
  }

  // ---------- 1. 安装、清单贡献点、懒激活 ----------

  console.log('\n【1】v2 内置包安装：贡献点来自 package.json，onCommand 前不 fork 宿主')
  const views = service.listExtensions()
  const quick = views.find(v => v.descriptor.id === QUICK_EDIT_ID)
  check('扩展列表里有 imark.quick-edit', !!quick, JSON.stringify(views.map(v => v.descriptor.id)))
  check('默认启用', quick?.enabled === true, JSON.stringify(quick))
  check('来源标成内置（bundled）', quick?.source === 'bundled', String(quick?.source))
  check(
    '清单里声明了插入命令',
    quick?.descriptor.contributes.commands?.some(c => c.command === 'imark.quick-edit.insertTable') === true
  )

  const contribs = service.getContributions()
  const lineItem = contribs.lineMenu.find(item => item.command === 'imark.quick-edit.insertTable')
  check('贡献点快照里有这条菜单', !!lineItem, JSON.stringify(contribs.lineMenu))
  check('菜单条目带对话框（行数/列数）', lineItem?.dialog?.fields.length === 2, JSON.stringify(lineItem?.dialog))
  check('还没有命中 onCommand，扩展未激活', !service.isActivated(QUICK_EDIT_ID))
  check(
    '未激活时不占用宿主进程',
    service.hostGroupsView().every(group => group.pid === null),
    JSON.stringify(service.hostGroupsView())
  )

  // ---------- 2. 「+」按钮 ----------

  console.log('\n【2】「+」按钮只在光标行')
  check('第 1 行画出「+」', await waitFor(`document.querySelector('.line-plus')`, 10000))
  check('按钮在第 1 行', (await plusLine()) === 1, `按钮在第 ${await plusLine()} 行`)
  check('全文档只有这一个按钮', (await evalJs<number>(`document.querySelectorAll('.line-plus').length`)) === 1)

  await key('ArrowDown')
  check('光标移到第 2 行后按钮跟过去', (await plusLine()) === 2, `按钮在第 ${await plusLine()} 行`)
  await key('ArrowUp')

  // ---------- 3. 菜单 + 对话框 ----------

  console.log('\n【3】「+」→ 菜单 →「表格」→ 4 行 2 列 → 插入')
  check('「+」点得开', await click('.line-plus'))
  await sleep(250)
  check('菜单出现了', await evalJs<boolean>(`!!document.querySelector('.line-menu')`))
  const labels = await menuLabels()
  check('菜单里有「表格」', labels.includes('表格'), JSON.stringify(labels))

  check('点「表格」打开参数对话框', await openMenuAndPick('表格'))
  const info = await dialogInfo()
  check('对话框出现了', !!info)
  check('标题是「插入表格」', info?.title === '插入表格', String(info?.title))
  check(
    '只有行数与列数两个字段',
    JSON.stringify(info?.labels) === JSON.stringify(['行数（含表头）', '列数']),
    JSON.stringify(info?.labels)
  )
  check('默认值是 3 / 3', JSON.stringify(info?.values) === JSON.stringify(['3', '3']), JSON.stringify(info?.values))
  check('确定按钮文案来自清单', info?.confirm === '插入', String(info?.confirm))

  check('填进去了 4 行 2 列', await setNumbers(4, 2))
  check('点得到「插入」', await click('.line-dialog-primary'))
  check('对话框关掉了', await waitFor(`!document.querySelector('.line-dialog')`, 4000))
  await sleep(600)
  check('命令触发了宿主激活', service.isActivated(QUICK_EDIT_ID))

  // ---------- 4. 渲染与焦点 ----------

  console.log('\n【4】渲染成真表格，焦点落在第一个表头单元格')
  const rendered = await evalJs<{
    tables: number
    sourceRows: number
    th: number
    td: number
    voids: number
    aligns: string[]
  }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      return {
        tables: document.querySelectorAll('.cm-content .cm-md-table-widget table').length,
        sourceRows: document.querySelectorAll('.cm-content .cm-line.cm-md-table').length,
        th: t ? t.querySelectorAll('th').length : 0,
        td: t ? t.querySelectorAll('td').length : 0,
        voids: document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length,
        aligns: t ? [...t.querySelectorAll('th, td')].map(el => el.style.textAlign) : []
      }
    })()`)
  check(
    '表格以真 <table> 渲染（不再铺 Markdown 源码）',
    rendered.tables === 1 && rendered.sourceRows === 0,
    JSON.stringify(rendered)
  )
  check('4 行 2 列 = 2 个表头 + 6 个数据格', rendered.th === 2 && rendered.td === 6, JSON.stringify(rendered))
  check(
    '表头与内容默认居中',
    rendered.aligns.length === 8 && rendered.aligns.every(a => a === 'center'),
    JSON.stringify(rendered.aligns)
  )
  check('其余 4 行折叠成零高度 void 行', rendered.voids === 4, JSON.stringify(rendered))

  const firstCell = await waitForActiveCell()
  check(
    '焦点落在第一个表头单元格（contenteditable）',
    firstCell?.row === 0 && firstCell?.col === 0 && firstCell?.editable === 'plaintext-only',
    JSON.stringify(firstCell)
  )
  // 落盘必须在焦点检查之后：保存会提交并结束单元格编辑态，焦点自然离开单元格。
  // 4 行 = 1 行表头 + 1 行分隔 + 3 行内容；紧贴光标行的下一行。
  // rows=4 → 表头 + 分隔 + 3 行内容 = 5 条表格源码行；末尾原有一条空行
  const want = ['第一行', blank(2), sep(2), blank(2), blank(2), blank(2), '', '第三行']
  const got = await readSource()
  check('磁盘上的文档就是 4 行 2 列的表', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  check('表从光标行的下一行开始', got[1] === blank(2), JSON.stringify(got.slice(0, 3)))
  check('分隔行用 `:---:`（默认居中）', got.includes(sep(2)))

  // ---------- 5. 取消不产生改动 ----------

  console.log('\n【5】Esc 取消对话框：文档一个字符都不动')
  check('重新载入干净文档', await loadDoc(START))
  const beforeCancel = await readSource()
  check('打开「表格」对话框', await openMenuAndPick('表格'))
  await key('Escape')
  check('Esc 关掉对话框', await waitFor(`!document.querySelector('.line-dialog')`, 3000))
  await sleep(300)
  const afterCancel = await readSource()
  check(
    '取消后文档内容不变',
    JSON.stringify(afterCancel) === JSON.stringify(beforeCancel),
    JSON.stringify(afterCancel)
  )

  // ---------- 6. 停用 / 重新启用 ----------

  console.log('\n【6】停用 → 菜单与按钮消失、宿主释放；重新启用 → 恢复')
  await service.setEnabled(QUICK_EDIT_ID, false)
  check('停用后扩展不在启用列表', service.listExtensions().find(v => v.descriptor.id === QUICK_EDIT_ID)?.enabled === false)
  check('贡献点里没有这条菜单', !service.getContributions().lineMenu.some(i => i.command === 'imark.quick-edit.insertTable'))
  check('「+」按钮消失', await waitFor(`!document.querySelector('.line-plus')`, 5000))
  check('宿主已释放', !service.isActivated(QUICK_EDIT_ID))

  await service.setEnabled(QUICK_EDIT_ID, true)
  check('重新启用后「+」回来', await waitFor(`document.querySelector('.line-plus')`, 5000))
  check(
    '菜单条目重新出现',
    service.getContributions().lineMenu.some(i => i.command === 'imark.quick-edit.insertTable')
  )

  // ---------- 7. 卸载 ----------

  console.log('\n【7】卸载扩展：目录、贡献点、按钮一起消失')
  await service.uninstallExtension(QUICK_EDIT_ID)
  check('扩展列表里不再有它', !service.listExtensions().some(v => v.descriptor.id === QUICK_EDIT_ID))
  check('贡献点快照清空', service.getContributions().lineMenu.length === 0)
  check('「+」按钮消失', await waitFor(`!document.querySelector('.line-plus')`, 5000))
  const dirGone = await readFile(join(ud, 'plugins', QUICK_EDIT_ID, 'package.json'), 'utf8').then(
    () => false,
    () => true
  )
  check('安装目录被删除', dirGone)

  await shutdownExtensions()
  console.log(`\n${pass} 通过, ${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  app.exit(1)
})
