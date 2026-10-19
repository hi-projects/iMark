/**
 * 行首「+」菜单 + 表格插入端到端验证(Advanced Table,插件 id 仍是 quick-edit)。
 *
 * 这条链路横跨四个进程边界:CodeMirror 装饰(渲染层) → 插件贡献点(descriptor,主进程)
 * → 插件运行时(主进程里的用户代码) → 回到渲染层改文档。任何一段接错,现象都是
 * 「点了 + 什么都没发生」,所以这里不看中间态,只钉**最终可见的结果**:
 * DOM 里的行、磁盘上的文件、焦点落点(靠往那儿打字来验)。
 *
 * 覆盖:
 *   1 全新 userData:内置包自动补装、默认启用,按钮只在光标行
 *   2 点「+」→ 菜单出现,里面有「表格」
 *   3 点「表格」→ 对话框只有行数/列数 → 改成 4 行 2 列 → 确定 → 文档与磁盘都是 4×2;
 *     表格以真 <table> 渲染,焦点直接落在第一个表头单元格里
 *   3b 在渲染态直接输入:打字 → Tab 换格 → 保存时自动提交 → 回车换行
 *   4 取消 / Esc 不产生任何改动(反向断言)
 *   5 失败路径:插件被停用时点确定,文档一个字符都不变(且要吭声)
 *   6 重新初始化宿主 + 重载渲染层后照旧可用(盯 descriptor 从磁盘重建的那条路)
 *   7 贡献点的通用性:另一个插件的 template 条目不过插件往返也能插入
 *   8 停用插件 → 按钮消失
 *   9 插件目录不存在 → 按钮不出现
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs quick-edit
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC } from '../src/shared/ipc-channels'
import { integrityInput } from '../src/shared/pluginPackage'
import { registerPluginScheme } from '../src/main/plugins/restrictedPage'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { getPluginHost, initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { installFromEnvelope } from '../src/main/market/installer'
import { createMainWindow } from '../src/main/window'

// 仓库根:打包产物固定落在 <仓库>/out/main/ 下(见文件头),所以由 __dirname 往上两级。
// 截图一类的临时产物都放这儿,别写到家目录去 —— 换个机器就没有了
const REPO = join(__dirname, '..', '..')

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
const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** 表格期望长相:2 列时空行是 `|     |     |`,分隔行是 `| --- | --- |` */
const BLANK_CELL = '     '
const row = (...cells: string[]): string => `|${cells.map(c => `${c}|`).join('')}`
const blank = (cols: number): string => row(...(Array(cols).fill(BLANK_CELL) as string[]))
const sep = (cols: number): string => row(...(Array(cols).fill(' --- ') as string[]))

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])
registerPluginScheme()

/**
 * 一个只声明 template 条目的临时脚本插件。
 *
 * 之所以是**脚本**插件:声明式插件必须挂到内置能力上(webhook),而这里只想放一条
 * 不经过任何插件代码的模板条目。它的 runAction 会抛异常 —— 模板条目本来就该绕开插件,
 * 真被调到了,插入就不会发生,用例 7 的正向断言自己会红。
 */
function templatePackage(): unknown {
  const mainJs = Buffer.from(
    'module.exports = function () {\n' +
      '  return {\n' +
      '    onEnable: function () {},\n' +
      '    runAction: function () { throw new Error("template 条目不该走到插件里") }\n' +
      '  }\n' +
      '}\n',
    'utf8'
  )
  const readme = Buffer.from('# 临时模板插件\n\n只有在 harness 里才会被装。\n', 'utf8')
  const manifest = {
    id: 'tmp-template',
    name: '临时模板',
    description: '验证 template 条目不经过插件往返。',
    version: '1.0.0',
    main: { mode: 'node', entry: 'main.js' },
    permissions: [],
    fields: [],
    actions: [],
    lineMenu: [
      { id: 'quote', label: '引用', template: '> ' },
      // 整行横线:唯一能让插入点**吃掉上一行**的模板形(见用例 7b)
      { id: 'rule', label: '短横线', template: '---' }
    ]
  }
  const files = {
    'main.js': { encoding: 'base64', size: mainJs.byteLength, sha256: sha256(mainJs) },
    'README.md': { encoding: 'base64', size: readme.byteLength, sha256: sha256(readme) }
  }
  const data = {
    'main.js': mainJs.toString('base64'),
    'README.md': readme.toString('base64')
  }
  return {
    format: 'imk-plugin',
    formatVersion: 1,
    manifest,
    files,
    data,
    integrity: sha256(integrityInput(manifest as never, files as never))
  }
}

async function main(): Promise<void> {
  /*
   * 没有 --user-data-dir 就直接退出。
   * 这不是洁癖:harness 会往 userData 里写 settings.json 并把 vaultPath 指过去,
   * 少了这个开关,写的就是**用户真实的那份配置**(~/.config/imarkdown),而开发时
   * `electron-vite dev` 起的实例用的正是同一个目录 —— 两边会互相踩。
   */
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    console.error('拒绝运行:必须带 --user-data-dir(用 `node verify/run.mjs <名字>` 跑会自动带上)')
    app.exit(2)
    return
  }

  await app.whenReady()

  // 原生对话框全部 stub 掉:这一轮不该弹出任何需要人点的东西
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
  // 「全新用户」:插件目录整个抹掉,内置包必须自己补装回来
  await rm(join(ud, 'plugins'), { recursive: true, force: true })

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

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  await initPluginHost(ensureBundledProvisioned)
  buildAppMenu()
  const win: BrowserWindow = createMainWindow(settings)
  const wc = win.webContents
  await new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
  await sleep(1500)

  const evalJs = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

  async function waitFor(code: string, ms = 8000): Promise<boolean> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}) } catch { return false } })()`)) return true
      await sleep(80)
    }
    return false
  }

  /**
   * 每次页面重载后都要重做的事。
   *
   * alert 仍然要换掉:真 alert 会**阻塞**整个渲染进程 —— harness 会卡死在那儿,
   * 看起来像功能坏了。但注意(2026-10-16):失败提示已经不弹 alert 了,
   * 改成右下角的气泡通知(见 src/renderer/src/services/notice.ts)。
   * 所以下面那条"吭声"的断言改为读 DOM 里的 `.toast`,不再看 __alerts。
   */
  async function afterLoad(): Promise<void> {
    await evalJs(`(() => {
      window.__alerts = []
      window.alert = m => { window.__alerts.push(String(m)) }
      return true
    })()`)
    await focusEditor()
  }

  /** 右下角气泡里的文字(宿主与插件失败时都从这儿出来) */
  async function toastTexts(): Promise<string[]> {
    return evalJs<string[]>(
      `Array.from(document.querySelectorAll('.toast')).map(el => el.textContent || '')`
    )
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

  /** sendInputEvent 要的是 W3C 旧键名(`Left`/`Down`),写成 `ArrowLeft` 会被一声不吭地丢掉 */
  async function key(keyCode: string, modifiers: string[] = []): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers as never })
    await sleep(160)
  }

  /**
   * 往**当前焦点**里打字(不碰 .cm-content)。
   *
   * 表格单元格是 contenteditable,焦点本来就该在那儿;老版本这里会先
   * `.cm-content.focus()`,等于把焦点从单元格抢回编辑器 —— 在渲染态下那是
   * 一个**看不见的光标**,打出来的字只会落进隐藏的源码。
   */
  async function typeFocused(text: string): Promise<void> {
    if (!win.isVisible()) win.show()
    if (!win.isFocused()) win.focus()
    await sleep(80)
    for (const ch of text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(20)
    }
    await sleep(220)
  }

  /** 当前焦点如果是渲染表格里的单元格,返回它的行列与可编辑态 */
  const activeTableCell = (): Promise<{
    row: number
    col: number
    editable: string
  } | null> =>
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

  /** 真鼠标点一下某个渲染表格单元格的中心(和用户的手一样) */
  async function clickTableCell(row: number, col: number): Promise<boolean> {
    const spot = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const cell = document.querySelector('.cm-md-table-widget th[data-row="${row}"][data-col="${col}"], .cm-md-table-widget td[data-row="${row}"][data-col="${col}"]')
        if (!cell) return null
        const r = cell.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!spot) return false
    wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(300)
    return true
  }

  const click = (sel: string): Promise<boolean> =>
    evalJs<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`
    )

  /** 「+」当前挂在第几行(1 起;没有按钮返回 -1)—— 「只在光标行」这条全靠它 */
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

  /** 写盘 + 重载窗口,拿到一个光标在文首的干净编辑器 */
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
      console.log(`    (第 ${attempt} 次载入没等到:DOM ${JSON.stringify(dom)})`)
    }
    return false
  }

  /** 落盘内容(触发一次保存再读文件),末尾空行不算行 */
  const readSource = async (): Promise<string[]> => {
    wc.send(IPC.MenuCommand, 'file:save')
    await sleep(700)
    const lines = (await readFile(note, 'utf8')).split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** 打开「+」菜单(已经开着就不重复点 —— 再点一次是收起)并返回条目文案 */
  async function openMenu(): Promise<string[]> {
    if (!(await evalJs<boolean>(`!!document.querySelector('.line-menu')`))) {
      if (!(await click('.line-plus'))) return []
    }
    await sleep(250)
    return menuLabels()
  }

  /** 打开「+」菜单并点某一条;fail-fast 地把中间态报出来 */
  async function openMenuAndPick(label: string): Promise<boolean> {
    const labels = await openMenu()
    if (labels.length === 0) return false
    if (!labels.includes(label)) {
      console.log(`    (菜单里只有 ${JSON.stringify(labels)})`)
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

  // ---------- 1. 全新 userData:内置包补装 + 默认启用 ----------

  console.log('\n【1】全新 userData:Advanced Table 自动补装且默认启用,按钮只在光标行')
  const plugins = (await getPluginHost()!.list()) as unknown as {
    descriptor: { id: string }
    state: { enabled: boolean }
    source?: string
  }[]
  const quick = plugins.find(p => p.descriptor.id === 'quick-edit')
  check('插件列表里有 quick-edit(内置包已补装)', !!quick, JSON.stringify(plugins.map(p => p.descriptor.id)))
  check('它是默认启用的', quick?.state.enabled === true, JSON.stringify(quick?.state))
  check('来源标成内置(bundled)', quick?.source === 'bundled', String(quick?.source))
  check('另一个内置包 git-sync 装上了但**没有**被默认启用', plugins.some(p => p.descriptor.id === 'git-sync' && !p.state.enabled))

  check('光标行(第 1 行)画出了「+」', (await plusLine()) === 1, `按钮在第 ${await plusLine()} 行`)
  check('全文档只有这一个按钮', (await evalJs<number>(`document.querySelectorAll('.line-plus').length`)) === 1)

  await key('ArrowDown') // 光标挪到第 2 行(空行)
  check('光标移到第 2 行后,按钮跟着过去', (await plusLine()) === 2, `按钮在第 ${await plusLine()} 行`)

  // ---------- 2. 菜单 ----------

  console.log('\n【2】点「+」→ 菜单出现,里面有「表格」')
  check('「+」按钮存在', await click('.line-plus'))
  await sleep(250)
  check('菜单出现了', await evalJs<boolean>(`!!document.querySelector('.line-menu')`))
  const labels = await menuLabels()
  check('菜单里有「表格」', labels.includes('表格'), JSON.stringify(labels))
  check('没有对话框同时开着', await evalJs<boolean>(`!document.querySelector('.line-dialog')`))

  console.log('\n【2b】光标一动菜单就收起(它是「那一行」的)')
  await focusEditor()
  await key('ArrowDown')
  await sleep(200)
  check('按方向键后菜单消失', await evalJs<boolean>(`!document.querySelector('.line-menu')`))

  // ---------- 3. 对话框 → 4 行 2 列 → 确定 ----------

  console.log('\n【3】点「表格」→ 只有行数/列数 → 4 行 2 列 → 确定')
  await loadDoc(START)
  check('菜单里的「表格」点得开', await openMenuAndPick('表格'))
  const info = await dialogInfo()
  check('对话框出现了', !!info)
  check('标题是「插入表格」', info?.title === '插入表格', String(info?.title))
  check('只有行数与列数两个字段', JSON.stringify(info?.labels) === JSON.stringify(['行数', '列数']), JSON.stringify(info?.labels))
  check('默认值是 3 / 3', JSON.stringify(info?.values) === JSON.stringify(['3', '3']), JSON.stringify(info?.values))
  check('确定按钮的文案来自清单', info?.confirm === '确定', String(info?.confirm))

  check('填进去了 4 行 2 列', await setNumbers(4, 2))
  check('点得到「确定」', await click('.line-dialog-primary'))
  check('对话框关掉了', await waitFor(`!document.querySelector('.line-dialog')`, 4000))
  await sleep(600)

  // 4 行 = 1 行表头 + 1 行分隔 + 3 行内容(行数含表头,这是用户确认过的口径);
  // 紧贴光标行的下一行(n+1),中间没有空行 —— 这里原本断言的是插到 n+2
  const want = ['第一行', blank(2), sep(2), blank(2), blank(2), blank(2), '', '第三行']
  const got = await readSource()
  check('磁盘上的文档就是 4 行 2 列的表', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
  check('表从光标行的**下一行**开始(不是 n+2)', got[1] === blank(2), JSON.stringify(got.slice(0, 3)))
  check(
    '行数含表头:表头 1 行 + 内容 3 行',
    got.filter(l => l.startsWith('|') && !l.includes('---')).length === 4,
    JSON.stringify(got.filter(l => l.startsWith('|')))
  )
  check('分隔行不带冒号(即默认左对齐)', got.includes(sep(2)))
  // 设置页的「插件日志」是宿主日志文件的尾巴:操作摘要必须和插件自己 log() 的行
  // 一起出现在这里,不能只在磁盘上的日志文件里看得到
  const quickView = (await getPluginHost()!.list()).find(v => v.descriptor.id === 'quick-edit')
  check(
    '这次插入也进了设置页的插件日志',
    quickView?.logs?.some(
      l =>
        l.level === 'operation' &&
        l.message.includes('表格 · 成功') &&
        l.message.includes('已插入 4 × 2 表格')
    ) === true,
    JSON.stringify(quickView?.logs?.slice(-3))
  )

  const rendered = await evalJs<{
    tables: number
    sourceRows: number
    th: number
    td: number
    voids: number
  }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      return {
        tables: document.querySelectorAll('.cm-content .cm-md-table-widget table').length,
        sourceRows: document.querySelectorAll('.cm-content .cm-line.cm-md-table').length,
        th: t ? t.querySelectorAll('th').length : 0,
        td: t ? t.querySelectorAll('td').length : 0,
        voids: document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length
      }
    })()`)
  check(
    '表格以真 <table> 渲染出来(不再铺 Markdown 源码)',
    rendered.tables === 1 && rendered.sourceRows === 0,
    JSON.stringify(rendered)
  )
  check('4 行 2 列 = 2 个表头 + 6 个数据格', rendered.th === 2 && rendered.td === 6, JSON.stringify(rendered))
  // 4 行 = 表头 + 分隔行 + 3 行内容,共 5 行源码;表头那一行承载 widget,剩下 4 行折叠
  check('其余 4 行折叠成零高度的 void 行', rendered.voids === 4, JSON.stringify(rendered))

  console.log('\n【3b】插入后焦点就在第一个表头单元格里 —— 在渲染态直接输入')
  const firstCell = await waitForActiveCell()
  check(
    '焦点落在第一个表头单元格(contenteditable)',
    firstCell?.row === 0 && firstCell?.col === 0 && firstCell?.editable === 'plaintext-only',
    JSON.stringify(firstCell)
  )
  check(
    '表格仍然渲染着(没有退回源码态)',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table').length`)) === 1
  )

  await typeFocused('X')
  await key('Tab')
  const secondCell = await waitForActiveCell(2000)
  check('Tab 把焦点移到第二格', secondCell?.row === 0 && secondCell?.col === 1, JSON.stringify(secondCell))
  await typeFocused('Y')
  // 不按回车:直接保存。第二格的 Y 还只在 contenteditable 里,保存路径必须先把它刷回文档
  const afterTyping = await readSource()
  check(
    '打字进的是表头单元格,Tab 后第二格也在保存时提交了',
    afterTyping[1] === '| X | Y |',
    JSON.stringify(afterTyping.slice(1, 3))
  )
  check(
    '保存没有把表格翻回源码',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table').length`)) === 1
  )

  await key('Enter')
  const moved = await waitForActiveCell(2000)
  check('回车提交并移到下一行同一列', moved?.row === 1 && moved?.col === 1, JSON.stringify(moved))

  // Tab 走到最后一格再按一次:自动补一行(不补的话渲染态下就再也加不了行了)
  for (let i = 0; i < 5; i++) await key('Tab')
  const appended = await waitForActiveCell(2000)
  check('在最后一格按 Tab 自动加一行并落在新行第一格', appended?.row === 4 && appended?.col === 0, JSON.stringify(appended))
  const afterAppend = await readSource()
  check(
    '新行写进了文档(整行序列化,空格子补成 `|  |  |`)',
    afterAppend.includes('|  |  |'),
    JSON.stringify(afterAppend)
  )
  check(
    '加行后表格仍然是渲染态',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table').length`)) === 1
  )

  // 点击:必须留在渲染态就地编辑,而不是整张表翻回 Markdown(这次改动的核心要求)
  await key('Escape')
  check('点击得到表头第一格', await clickTableCell(0, 0))
  const clicked = await activeTableCell()
  check(
    '点击后进入单元格编辑态(没有变回语法格式)',
    clicked?.row === 0 && clicked?.col === 0 && clicked?.editable === 'plaintext-only',
    JSON.stringify(clicked)
  )
  check(
    '点击后表格还在渲染',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table').length`)) === 1
  )
  await key('Escape')

  // ---------- 3c. 下一行是正文(用户实际踩到的那个场景) ----------

  console.log('\n【3c】光标行的下一行是正文:表格仍然紧贴下一行,且不把正文吞进去')
  await loadDoc('第一行\n正文\n第三行\n')
  check('点「表格」', await openMenuAndPick('表格'))
  check('填 2 行 2 列', await setNumbers(2, 2))
  check('点确定', await click('.line-dialog-primary'))
  await sleep(700)
  const beside = await readSource()
  check(
    '表格落在第 2 行(n+1),正文被一个空行正常隔开',
    JSON.stringify(beside) === JSON.stringify(['第一行', blank(2), sep(2), blank(2), '', '正文', '第三行']),
    JSON.stringify(beside)
  )
  const swallowed = await evalJs<boolean>(`
    [...document.querySelectorAll('.cm-content .cm-line')]
      .some(el => el.textContent.includes('正文') && el.className.split(/\s+/).includes('cm-md-table'))`)
  check('「正文」没有被吸进表格(表格行数仍是 3)', !swallowed)
  const besideRendered = await evalJs<{ tables: number; th: number; td: number }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      return {
        tables: document.querySelectorAll('.cm-content .cm-md-table-widget table').length,
        th: t ? t.querySelectorAll('th').length : 0,
        td: t ? t.querySelectorAll('td').length : 0
      }
    })()`)
  check(
    '表格渲染成真表格:2 个表头 + 1 行内容',
    besideRendered.tables === 1 && besideRendered.th === 2 && besideRendered.td === 2,
    JSON.stringify(besideRendered)
  )

  // ---------- 3d. 打开文档时光标落在表格源码里:插入点落到表格后的正文行 ----------

  console.log('\n【3d】打开文档时光标落在表格源码里:护栏送到表格后,新表落在正文行下方')
  await loadDoc('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  check('点「表格」', await openMenuAndPick('表格'))
  check('填 2 行 2 列', await setNumbers(2, 2))
  check('点确定', await click('.line-dialog-primary'))
  await sleep(700)
  const twoTables = await readSource()
  check(
    '两张表各自完整(结构空行不许停光标,光标落到「末尾」,新表在它下面)',
    JSON.stringify(twoTables) ===
      JSON.stringify(['| A | B |', '| --- | --- |', '| 1 | 2 |', '', '末尾', blank(2), sep(2), blank(2)]),
    JSON.stringify(twoTables)
  )
  // 光标走出表格,两张表都该渲染出来 —— 这才是"两张独立的表"的直接证据。
  // 每按一下都停一停:表格折叠/展开会让行高整个变一遍,连着猛按方向键是按旧布局算落点,
  // 光标会留在表里,看起来就像"第二张表没渲染"
  await focusEditor()
  for (let i = 0; i < 8; i++) {
    await key('ArrowDown')
    await sleep(120)
  }
  await sleep(600)
  // 注意按 token 比:`'cm-md-table-void'.includes('cm-md-table')` 也是 true,
  // 用 includes 会把"光标停在折叠行上"误判成"光标在表格里"
  const cursorCls = await evalJs<string>(`
    (() => {
      const sel = document.getSelection()
      if (!sel || !sel.anchorNode) return ''
      const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
      return el?.closest?.('.cm-line')?.className ?? ''
    })()`)
  const stillInside = cursorCls.split(/\s+/).includes('cm-md-table')
  const tableCount = await evalJs<number>(`document.querySelectorAll('.cm-content table').length`)
  check('光标已经走出表格', !stillInside, `光标行 class:${JSON.stringify(cursorCls)}`)
  check(
    'DOM 里是两张独立的表格',
    tableCount === 2,
    `找到 ${tableCount} 张表(DOM 共 ${await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line').length`)} 行)`
  )

  // ---------- 3e. 结构控件:插行 / 插列 / 删行 / 删列 / 删整表 ----------

  console.log('\n【3e】表格四周的控件:插行、插列、删行、删列、删整表')
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)

  const tableInfo = (): Promise<{ th: number; td: number; tr: number; controls: boolean }> =>
    evalJs(`
      (() => {
        const t = document.querySelector('.cm-md-table-widget table')
        return {
          th: t ? t.querySelectorAll('th').length : 0,
          td: t ? t.querySelectorAll('td').length : 0,
          tr: t ? t.querySelectorAll('tr').length : 0,
          controls: !!document.querySelector('.cm-md-table-widget [data-act="add-row"]')
        }
      })()`)

  const clickCtl = (selector: string): Promise<boolean> =>
    evalJs<boolean>(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        el.click()
        return true
      })()`)

  const renderedTableCount = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table').length`)

  let tableMeta = await tableInfo()
  check('控件出现了(行/列插入 + 与删除 ×)', tableMeta.controls)
  check('初始是 2 列、表头 + 1 行内容', tableMeta.th === 2 && tableMeta.td === 2 && tableMeta.tr === 2, JSON.stringify(tableMeta))

  check('点表头下方的 + 插入一行', await clickCtl('[data-act="add-row"][data-after="0"]'))
  const rowCell = await waitForActiveCell(2000)
  check('新行插在表头下方,焦点落在它的第一格', rowCell?.row === 1 && rowCell?.col === 0, JSON.stringify(rowCell))
  tableMeta = await tableInfo()
  check('渲染表多了一行', tableMeta.tr === 3 && tableMeta.td === 4, JSON.stringify(tableMeta))
  let structureSource = await readSource()
  check('源码里多了整行空格子 `|  |  |`', structureSource.includes('|  |  |'), JSON.stringify(structureSource))

  check('点最右侧的 + 插入一列', await clickCtl('[data-act="add-col"][data-before="2"]'))
  const colCell = await waitForActiveCell(2000)
  check('新列的表头格拿到焦点', colCell?.row === 0 && colCell?.col === 2, JSON.stringify(colCell))
  tableMeta = await tableInfo()
  check('渲染表变成 3 列', tableMeta.th === 3 && tableMeta.td === 6, JSON.stringify(tableMeta))
  structureSource = await readSource()
  check(
    '分隔行跟着变成 3 列',
    structureSource.includes('| --- | --- | --- |'),
    JSON.stringify(structureSource)
  )
  check(
    '每行都多了一格',
    structureSource.includes('| A | B |  |'),
    JSON.stringify(structureSource)
  )

  check('点第二行左侧的 × 删除该行', await clickCtl('[data-act="delete-row"][data-row="1"]'))
  await sleep(300)
  tableMeta = await tableInfo()
  check('行数回到 2(表头 + 1 行内容)', tableMeta.tr === 2 && tableMeta.td === 3, JSON.stringify(tableMeta))
  structureSource = await readSource()
  check('空行从源码里消失', !structureSource.includes('|  |  |'), JSON.stringify(structureSource))

  check('点第三列顶部的 × 删除该列', await clickCtl('[data-act="delete-col"][data-col="2"]'))
  await sleep(300)
  tableMeta = await tableInfo()
  check('列数回到 2', tableMeta.th === 2 && tableMeta.td === 2, JSON.stringify(tableMeta))
  structureSource = await readSource()
  check(
    '分隔行也回到 2 列',
    structureSource.includes('| --- | --- |') && !structureSource.includes('| --- | --- | --- |'),
    JSON.stringify(structureSource)
  )

  check('点右上角的 × 删除整张表', await clickCtl('[data-act="delete-table"]'))
  await sleep(400)
  check('渲染表消失', (await renderedTableCount()) === 0)
  structureSource = await readSource()
  check(
    '源码里的表格行都没了,表格外的正文还在',
    !structureSource.some(l => l.trim().startsWith('|')) &&
      structureSource.some(l => l.includes('开头')) &&
      structureSource.some(l => l.includes('末尾')),
    JSON.stringify(structureSource)
  )

  // ---------- 3f. 选中整行 / 整列 / 整表 + Delete / Backspace ----------

  console.log('\n【3f】按住左键拖动选中行/列、点整表把手,再按 Delete / Backspace 删除')
  const TABLE_2x2 = '开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n末尾\n'
  await loadDoc(TABLE_2x2)
  await sleep(500)

  const frameFocused = (): Promise<boolean> =>
    evalJs<boolean>(
      `document.activeElement?.classList?.contains('cm-md-table-frame') === true`
    )
  const selectedCount = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-md-table-widget .cm-md-table-selected').length`)

  /**
   * 真鼠标按住左键,从一条数据行竖着拖到另一条(行参数是 tbody 里的下标)。
   * x 保持不变、y 取目标行靠下的位置:位移以纵向为主,才会判定为"选行"。
   */
  const dragRows = async (fromBody: number, toBody: number): Promise<boolean> => {
    const coords = await evalJs<{ ax: number; ay: number; bx: number; by: number } | null>(`
      (() => {
        const rows = [...document.querySelectorAll('.cm-md-table-widget tbody tr')]
        const a = rows[${fromBody}]?.querySelector('td')
        const b = rows[${toBody}]?.querySelector('td')
        if (!a || !b) return null
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return {
          ax: Math.round(ra.left + 10), ay: Math.round(ra.top + ra.height / 2),
          bx: Math.round(ra.left + 10),
          // 同一行内也要有纵向位移(但别越到下一行):取该格底部往上 3px
          by: Math.round(rb.bottom - 3)
        }
      })()`)
    if (!coords) return false
    wc.sendInputEvent({ type: 'mouseDown', x: coords.ax, y: coords.ay, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseMove', x: coords.bx, y: coords.by })
    await sleep(80)
    wc.sendInputEvent({ type: 'mouseUp', x: coords.bx, y: coords.by, button: 'left', clickCount: 1 })
    await sleep(350)
    return true
  }

  /** 真鼠标按住左键,从一列表头横着拖到另一列(列参数是 thead 里的下标) */
  const dragCols = async (fromCol: number, toCol: number): Promise<boolean> => {
    const coords = await evalJs<{ ax: number; ay: number; bx: number; by: number } | null>(`
      (() => {
        const cells = [...document.querySelectorAll('.cm-md-table-widget thead th')]
        const a = cells[${fromCol}], b = cells[${toCol}]
        if (!a || !b) return null
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return {
          ax: Math.round(ra.left + 10), ay: Math.round(ra.top + ra.height / 2),
          // 同一列内也要有横向位移:拖到该格右侧靠里 10px
          bx: Math.round(rb.right - 10), by: Math.round(ra.top + ra.height / 2)
        }
      })()`)
    if (!coords) return false
    wc.sendInputEvent({ type: 'mouseDown', x: coords.ax, y: coords.ay, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseMove', x: coords.bx, y: coords.by })
    await sleep(80)
    wc.sendInputEvent({ type: 'mouseUp', x: coords.bx, y: coords.by, button: 'left', clickCount: 1 })
    await sleep(350)
    return true
  }

  check(
    '行选中按钮已经去掉',
    (await evalJs<number>(`document.querySelectorAll('[data-act="select-row"]').length`)) === 0
  )
  check('按住左键从第一行拖到第二行', await dragRows(0, 1))
  check('两行共 4 个格子全部高亮', (await selectedCount()) === 4, String(await selectedCount()))
  check('拖完焦点交给表格 frame(能按 Delete)', await frameFocused())
  await key('Delete')
  await sleep(400)
  tableMeta = await tableInfo()
  check(
    '两行一起被删掉(只剩表头)',
    tableMeta.tr === 1 && tableMeta.th === 2 && tableMeta.td === 0,
    JSON.stringify(tableMeta)
  )
  structureSource = await readSource()
  check(
    '两行内容从源码里消失',
    !structureSource.includes('| 1 | 2 |') && !structureSource.includes('| 3 | 4 |'),
    JSON.stringify(structureSource)
  )

  await loadDoc(TABLE_2x2)
  await sleep(500)
  check('列选中也不再有按钮', (await evalJs<number>(`document.querySelectorAll('[data-act="select-col"]').length`)) === 0)
  check('在第一列表头上按住左键横着拖一下', await dragCols(0, 0))
  check('整列三个格子高亮(表头 + 2 行)', (await selectedCount()) === 3, String(await selectedCount()))
  await key('Delete')
  await sleep(400)
  tableMeta = await tableInfo()
  check('整列被删掉(只剩 1 列)', tableMeta.th === 1 && tableMeta.td === 2, JSON.stringify(tableMeta))
  structureSource = await readSource()
  check(
    '第二列顶上来了(B / 2 / 4 还在,A / 1 / 3 被删掉)',
    structureSource.some(l => l.trim() === '| B |') &&
      structureSource.some(l => l.trim() === '| 2 |') &&
      structureSource.some(l => l.trim() === '| 4 |') &&
      !structureSource.some(l => l.trim() === '| A |') &&
      !structureSource.some(l => l.trim() === '| 1 |') &&
      !structureSource.some(l => l.trim() === '| 3 |'),
    JSON.stringify(structureSource)
  )

  check('点左上角的整表选择把手', await clickCtl('[data-act="select-table"]'))
  check('整张表都高亮', (await selectedCount()) === 3, String(await selectedCount()))
  check(
    '整表选区样式落在 frame 上',
    await evalJs<boolean>(`!!document.querySelector('.cm-md-table-frame.is-selected')`)
  )
  await key('Backspace')
  await sleep(400)
  check('整张表被 Backspace 删掉', (await renderedTableCount()) === 0)
  structureSource = await readSource()
  check(
    '源码里没有表格行,正文完好',
    !structureSource.some(l => l.trim().startsWith('|')) &&
      structureSource.some(l => l.includes('开头')) &&
      structureSource.some(l => l.includes('末尾')),
    JSON.stringify(structureSource)
  )

  // ---------- 3g. 删除表头:下一条数据行接替表头 ----------

  console.log('\n【3g】删除表头行:下一条数据行接替表头,表格保持合法')
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n末尾\n')
  await sleep(400)
  check('点表头行左侧的 ×', await clickCtl('[data-act="delete-row"][data-row="0"]'))
  await sleep(300)
  const promoted = await evalJs<string[][]>(`
    [...document.querySelectorAll('.cm-md-table-widget thead th')].map(el => [el.textContent.trim()])`)
  check(
    '原来的第一条数据成了新表头',
    JSON.stringify(promoted) === JSON.stringify([['1'], ['2']]),
    JSON.stringify(promoted)
  )
  structureSource = await readSource()
  check(
    '表头 A/B 行消失,1/2 与 3/4 都还在',
    !structureSource.includes('| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |') &&
      structureSource.some(l => l.trim() === '| 3 | 4 |'),
    JSON.stringify(structureSource)
  )

  // ---------- 3h. 结构删除可以撤销 ----------

  console.log('\n【3h】删行之后 Ctrl+Z 能撤销')
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(400)
  const bodyRows = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-md-table-widget tbody tr').length`)
  check('初始有 1 行内容', (await bodyRows()) === 1, String(await bodyRows()))
  check('在行内按住左键拖一下选中这一行', await dragRows(0, 0))
  check(
    '这一行两个格子高亮',
    (await evalJs<number>(`document.querySelectorAll('.cm-md-table-selected').length`)) === 2,
    String(await evalJs<number>(`document.querySelectorAll('.cm-md-table-selected').length`))
  )
  await key('Delete')
  await sleep(300)
  check('行被删掉', (await bodyRows()) === 0, String(await bodyRows()))
  await key('z', ['control'])
  await sleep(400)
  check('Ctrl+Z 把行撤了回来', (await bodyRows()) === 1, String(await bodyRows()))
  structureSource = await readSource()
  check('源码里 `| 1 | 2 |` 也回来了', structureSource.some(l => l.trim() === '| 1 | 2 |'), JSON.stringify(structureSource))

  // ---------- 3i. 表格上一行行尾按 Delete:先选中整表,再按一次才删 ----------

  console.log('\n【3i】表格上一行行尾按 Delete:第一次选中整表,第二次才删')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  await key('Home', ['control'])
  await key('End') // 光标到「开头」行尾 —— 紧贴表格的上一行
  await sleep(150)
  await key('Delete')
  await sleep(400)
  check('第一次 Delete 后表格仍然渲染着', (await renderedTableCount()) === 1)
  const wholeSelected = await evalJs<number>(
    `document.querySelectorAll('.cm-md-table-widget .cm-md-table-selected').length`
  )
  check('整张表被选中(4 个格子高亮)', wholeSelected === 4, String(wholeSelected))
  check('焦点交给表格 frame', await frameFocused())
  structureSource = await readSource()
  check(
    '第一次按键没有改动源码(没有删掉表格与正文间的换行)',
    structureSource.some(l => l.trim() === '| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |'),
    JSON.stringify(structureSource)
  )
  await key('Delete')
  await sleep(400)
  check('第二次 Delete 删掉整张表', (await renderedTableCount()) === 0)
  structureSource = await readSource()
  check(
    '源码里没有表格行,正文完好',
    !structureSource.some(l => l.trim().startsWith('|')) &&
      structureSource.some(l => l.includes('开头')) &&
      structureSource.some(l => l.includes('末尾')),
    JSON.stringify(structureSource)
  )

  // ---------- 3j. 表格上一行行尾按回车:新增一行,光标留在新行 ----------

  console.log('\n【3j】表格上一行行尾按回车:新增一行,光标不进入表格')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const linesBefore = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  await key('Home', ['control'])
  await key('End')
  await key('Enter')
  await sleep(500)
  check('表格仍然渲染着', (await renderedTableCount()) === 1)
  check(
    '没有单元格被带进编辑态',
    !(await evalJs<boolean>(
      `!!document.querySelector('.cm-md-table-widget [contenteditable]')`
    ))
  )
  check(
    '焦点还在编辑器里',
    await evalJs<boolean>(`document.activeElement?.classList?.contains('cm-content') === true`)
  )
  check(
    '光标没有落进表格',
    !(await evalJs<boolean>(`(() => {
      const s = document.getSelection()
      if (!s || !s.anchorNode) return false
      const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
      return !!el?.closest?.('.cm-md-table-widget')
    })()`))
  )
  const linesAfter = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  // 源码多两行:光标落点(可编辑)+ 表格上方的结构空行(零高度)
  check('源码多了两行(可编辑行 + 结构空行)', linesAfter === linesBefore + 2, `${linesBefore} → ${linesAfter}`)
  const enterCaretLine = await evalJs<{ text: string; cls: string }>(`(() => {
    const s = document.getSelection()
    if (!s || !s.anchorNode) return { text: '', cls: '' }
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
    const line = el?.closest?.('.cm-line')
    if (!line) return { text: '', cls: '' }
    const copy = line.cloneNode(true)
    copy.querySelectorAll('.line-plus').forEach(w => w.remove())
    return { text: copy.textContent.trim(), cls: line.className }
  })()`)
  check(
    '光标停在新行上,而不是表格的结构空行',
    enterCaretLine.text === '' && !enterCaretLine.cls.includes('cm-md-table-gap'),
    JSON.stringify(enterCaretLine)
  )

  // ---------- 3k. 光标紧贴表格上方第一行:Delete 先选中整表 ----------

  console.log('\n【3k】光标紧贴表格上方第一行(中间只有隐藏的结构空行):Delete 先选中整表')
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const blankAbove = await evalJs<{ h: number; cls: string } | null>(`
    (() => {
      const host = document.querySelector('.cm-content .cm-md-table-host')
      const el = host && host.previousElementSibling
      if (!el) return null
      return { h: Math.round(el.getBoundingClientRect().height), cls: el.className }
    })()`)
  check(
    '表格上方的结构空行折成零高度、不占行高',
    !!blankAbove &&
      blankAbove.h <= 1 &&
      blankAbove.cls.includes('cm-md-table-gap') &&
      !blankAbove.cls.includes('cm-md-table-void'),
    JSON.stringify(blankAbove)
  )
  await key('Home', ['control'])
  await key('End') // 光标在「开头」行尾,下一行就是表格上方的隐藏结构空行
  await key('Delete')
  await sleep(400)
  check('表格仍然渲染着', (await renderedTableCount()) === 1)
  const selectedAcrossBlank = await evalJs<number>(
    `document.querySelectorAll('.cm-md-table-widget .cm-md-table-selected').length`
  )
  check(
    '紧贴隐藏结构空行也选中整表(4 个格子高亮)',
    selectedAcrossBlank === 4,
    String(selectedAcrossBlank)
  )
  check('焦点交给表格 frame', await frameFocused())
  structureSource = await readSource()
  check(
    '第一次按键没有改动源码',
    structureSource.some(l => l.trim() === '| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |'),
    JSON.stringify(structureSource)
  )
  await key('Delete')
  await sleep(400)
  check('第二次 Delete 删掉整张表', (await renderedTableCount()) === 0)
  structureSource = await readSource()
  check(
    '源码里没有表格行,正文完好',
    !structureSource.some(l => l.trim().startsWith('|')) &&
      structureSource.some(l => l.includes('开头')) &&
      structureSource.some(l => l.includes('末尾')),
    JSON.stringify(structureSource)
  )

  // ---------- 3l. 方向键越过渲染表格:不进入隐藏源码,能走到表格下面 ----------

  console.log('\n【3l】方向键越过渲染表格:不进入隐藏源码,能走到表格下面')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  await key('Home', ['control'])
  await key('End') // 光标在「开头」行尾 —— 紧贴表格的上一行
  await key('ArrowDown') // 想走到表格那一行(源码是隐藏的)
  await sleep(400)
  const caretInfo = await evalJs<{ inWidget: boolean; lineText: string }>(`(() => {
    const s = document.getSelection()
    if (!s || !s.anchorNode) return { inWidget: false, lineText: '' }
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
    const line = el?.closest?.('.cm-line')
    let text = ''
    if (line) {
      // 「+」按钮也挂在这一行里,先摘掉再取文本
      const copy = line.cloneNode(true)
      copy.querySelectorAll('.line-plus').forEach(w => w.remove())
      text = copy.textContent.trim()
    }
    return { inWidget: !!el?.closest?.('.cm-md-table-widget'), lineText: text }
  })()`)
  console.log('    caret after ArrowDown:', JSON.stringify(caretInfo))
  check('光标没有停在表格的隐藏源码里', !caretInfo.inWidget)
  check(
    '↓ 越过整张表和结构空行,落到表格下方的正文行',
    caretInfo.lineText.includes('末尾'),
    JSON.stringify(caretInfo.lineText)
  )
  await typeFocused('X')
  await sleep(400)
  check('表格仍然渲染着', (await renderedTableCount()) === 1)
  structureSource = await readSource()
  check(
    'X 落在表格下面(与表格之间隔着一条空行),表格源码一个字符都没动',
    structureSource.some(
      (l, i) => l.includes('X') && !l.trim().startsWith('|') && structureSource[i - 1] === ''
    ) &&
      structureSource.some(l => l.trim() === '| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |') &&
      !structureSource.some(l => l.trim().startsWith('|') && l.includes('X')),
    JSON.stringify(structureSource)
  )
  // 反向:从表格下面按 ↑,一次越过整张表回到上一行
  await key('ArrowUp') // X 行 → 越过表格和结构空行 → 「开头」
  await sleep(400)
  const afterUp = await evalJs<{ inWidget: boolean; lineText: string }>(`(() => {
    const s = document.getSelection()
    if (!s || !s.anchorNode) return { inWidget: false, lineText: '' }
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
    const line = el?.closest?.('.cm-line')
    let text = ''
    if (line) {
      // 「+」按钮也挂在这一行里,先摘掉再取文本
      const copy = line.cloneNode(true)
      copy.querySelectorAll('.line-plus').forEach(w => w.remove())
      text = copy.textContent.trim()
    }
    return { inWidget: !!el?.closest?.('.cm-md-table-widget'), lineText: text }
  })()`)
  check(
    '↑ 从表格下方一次越过表格回到上一行',
    !afterUp.inWidget && afterUp.lineText.includes('开头'),
    JSON.stringify(afterUp)
  )

  // ---------- 3m. 表格正下方那一行输入:自动补空行,不会变成表格行 ----------

  console.log('\n【3m】点击表格下方:落到正文行,结构空行保持零高度')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const linesBeforeClick = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  const blankSpot = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const host = document.querySelector('.cm-content .cm-md-table-host')
      let el = host ? host.nextElementSibling : null
      while (el && el.classList.contains('cm-md-table-void')) el = el.nextElementSibling
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }
    })()`)
  check('找到了表格正下方的空行', !!blankSpot, JSON.stringify(blankSpot))
  if (blankSpot) {
    wc.sendInputEvent({ type: 'mouseDown', x: blankSpot.x, y: blankSpot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: blankSpot.x, y: blankSpot.y, button: 'left', clickCount: 1 })
  }
  await sleep(400)
  const linesAfterClick = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  check(
    '只是点击空白处,不会凭空多一行',
    linesAfterClick === linesBeforeClick,
    `${linesBeforeClick} → ${linesAfterClick}`
  )
  const adjacentInfo = await evalJs<{
    spacers: number
    gapH: number
    gapCls: string
    padTop: number
    textTop: number
    textCls: string
  }>(`
    (() => {
      const host = document.querySelector('.cm-content .cm-md-table-host')
      let el = host ? host.nextElementSibling : null
      while (el && el.classList.contains('cm-md-table-void')) el = el.nextElementSibling
      const gap = el
      const text = gap ? gap.nextElementSibling : null
      const f = document.querySelector('.cm-md-table-frame')
      return {
        spacers: document.querySelectorAll('.cm-content .cm-md-table-spacer').length,
        gapH: gap ? Math.round(gap.getBoundingClientRect().height) : -1,
        gapCls: gap ? gap.className : '',
        padTop: f ? parseFloat(getComputedStyle(f).paddingTop) : -1,
        textTop: text ? Math.round(text.getBoundingClientRect().top) : -1,
        textCls: text ? text.className : ''
      }
    })()`)
  check(
    '表格下方紧邻的是零高度结构空行,再往下才是可编辑正文行',
    adjacentInfo.spacers === 0 &&
      adjacentInfo.gapH === 0 &&
      adjacentInfo.gapCls.includes('cm-md-table-gap') &&
      !adjacentInfo.textCls.includes('cm-md-table-gap'),
    JSON.stringify(adjacentInfo)
  )
  check('表格自身仍有 --md-table-gap 留白', adjacentInfo.padTop > 0, JSON.stringify(adjacentInfo))
  await typeFocused('X')
  await sleep(450)
  check('表格仍然渲染着', (await renderedTableCount()) === 1)
  const xVisual = await evalJs<{ top: number; text: string; gapH: number; gapCount: number }>(`
    (() => {
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(l => (l.textContent || '').includes('X'))
      const gaps = [...document.querySelectorAll('.cm-content .cm-md-table-gap')]
      return {
        top: line ? Math.round(line.getBoundingClientRect().top) : -1,
        text: line ? line.textContent : '',
        gapCount: gaps.length,
        gapH: gaps.length ? Math.round(gaps[0].getBoundingClientRect().height) : -1
      }
    })()`)
  check(
    '文字落在点击的正文行上(没有被顶到下一行)',
    xVisual.text.includes('X') && xVisual.top === adjacentInfo.textTop,
    JSON.stringify({ before: adjacentInfo.textTop, after: xVisual.top, line: xVisual.text })
  )
  check(
    '结构空行仍是零高度,源码里仍保留(GFM 需要它)',
    xVisual.gapCount === 1 && xVisual.gapH === 0,
    JSON.stringify(xVisual)
  )
  // 零高的分隔行不能变成方向键的"隐形停靠点":上下都应直接越过整张表
  const caretLineText = (): Promise<{ text: string; inWidget: boolean }> =>
    evalJs(`(() => {
      const s = document.getSelection()
      if (!s || !s.anchorNode) return { text: '', inWidget: false }
      const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
      const line = el?.closest?.('.cm-line')
      let text = ''
      if (line) {
        const copy = line.cloneNode(true)
        copy.querySelectorAll('.line-plus').forEach(w => w.remove())
        text = copy.textContent.trim()
      }
      return { text, inWidget: !!el?.closest?.('.cm-md-table-widget') }
    })()`)
  await key('ArrowUp')
  await sleep(250)
  const upAcross = await caretLineText()
  check(
    '↑ 从表格下方文字越过整张表,没有停在零高的分隔行上',
    upAcross.text.includes('开头') && !upAcross.inWidget,
    JSON.stringify(upAcross)
  )
  await key('ArrowDown')
  await sleep(250)
  const downBack = await caretLineText()
  check(
    '↓ 越过整张表回到表格下方的文字行(跳过零高分隔行)',
    downBack.text.includes('X') && !downBack.inWidget,
    JSON.stringify(downBack)
  )
  structureSource = await readSource()
  check(
    '输入后表格与文字之间保留空行,X 在普通段落里',
    structureSource.some(
      (l, i) => l.includes('X') && !l.trim().startsWith('|') && structureSource[i - 1] === ''
    ) &&
      structureSource.some(l => l.trim() === '| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |') &&
      !structureSource.some(l => l.trim().startsWith('|') && l.includes('X')),
    JSON.stringify(structureSource)
  )
  const tableRowsAfterX = await evalJs<number>(
    `document.querySelectorAll('.cm-md-table-widget tbody tr').length`
  )
  check(
    '表格行数没有增加(X 没被吸进表格)',
    tableRowsAfterX === 1,
    String(tableRowsAfterX)
  )

  // ---------- 3n. 输入法在表格下方空行输入 ----------

  console.log('\n【3n】输入法在表格下方正文行输入:组合期间版式不动')
  type ImeState = {
    text: string
    lines: number
    hostH: number
    voids: number
    voidH: number
    top: number
  }
  /** 表格下方第一条正文行:DOM 文本(去掉行首「+」按钮)+ 文档行数 + 宿主/折叠行的几何 */
  const imeLineState = (): Promise<ImeState> =>
    evalJs(`(() => {
      const all = [...document.querySelectorAll('.cm-content .cm-line')]
      const host = document.querySelector('.cm-content .cm-md-table-host')
      let el = host ? host.nextElementSibling : null
      while (el && (el.classList.contains('cm-md-table-void') || el.classList.contains('cm-md-table-gap')))
        el = el.nextElementSibling
      const r = el ? el.getBoundingClientRect() : { top: -1 }
      const voids = [...document.querySelectorAll('.cm-content .cm-md-table-void')]
      const hr = host ? host.getBoundingClientRect() : { height: 0 }
      return {
        text: el ? el.textContent.replace(/^\\+/, '') : '',
        lines: all.length,
        hostH: Math.round(hr.height),
        voids: voids.length,
        voidH: voids.length ? Math.round(voids[0].getBoundingClientRect().height) : -1,
        top: Math.round(r.top)
      }
    })()`)

  const imeDoc = '开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n'
  let imeBefore: ImeState | null = null
  let imeDuring: ImeState | null = null
  let imeEvents: string[] = []
  let imeCommitted = false
  for (let attempt = 1; attempt <= 3 && !imeCommitted; attempt++) {
    await loadDoc(imeDoc)
    await sleep(500)
    await focusEditor()
    const imeBlank = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const host = document.querySelector('.cm-content .cm-md-table-host')
        let el = host ? host.nextElementSibling : null
        while (el && el.classList.contains('cm-md-table-void')) el = el.nextElementSibling
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (attempt === 1) check('找到表格下方的点击位置', !!imeBlank, JSON.stringify(imeBlank))
    if (!imeBlank) break
    wc.sendInputEvent({ type: 'mouseDown', x: imeBlank.x, y: imeBlank.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: imeBlank.x, y: imeBlank.y, button: 'left', clickCount: 1 })
    await sleep(300)

    // 记录输入法事件:失败时能区分「产品没扛住组合」和「环境根本没派发组合事件」
    await evalJs(`
      (() => {
        window.__imeEvents = []
        // 重试会重新执行本段脚本,监听器只装一次,否则事件会被重复记录
        if (window.__imeListenersReady) return true
        window.__imeListenersReady = true
        const push = e => window.__imeEvents.push(
          e.type + (e.inputType ? ':' + e.inputType : '') + (e.data != null ? ':' + e.data : '')
        )
        for (const t of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
          document.addEventListener(t, push, true)
        }
        return true
      })()`)
    imeBefore = await imeLineState()
    try {
      wc.debugger.attach('1.3')
      const imeStep = async (text: string): Promise<void> => {
        await wc.debugger.sendCommand('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length
        })
        await sleep(350)
      }
      // 多步组合:每次都在上一次的预编辑串上改,而不是重新插入
      await imeStep('n')
      await imeStep('ni')
      await imeStep('n')
      await imeStep('ni')
      /*
       * 状态和事件一次取回,保证是同一个瞬间的快照。环境抖动(窗口瞬时失焦)
       * 会让 Chromium 在第一步之后就把组合 end 掉,后面的预编辑变成多次独立提交 ——
       * 那不是产品的连续组合,重载重试。
       */
      const snap = await evalJs<{ state: ImeState; events: string[] }>(`(() => {
        const all = [...document.querySelectorAll('.cm-content .cm-line')]
        const host = document.querySelector('.cm-content .cm-md-table-host')
        let el = host ? host.nextElementSibling : null
        while (el && (el.classList.contains('cm-md-table-void') || el.classList.contains('cm-md-table-gap')))
          el = el.nextElementSibling
        const r = el ? el.getBoundingClientRect() : { top: -1 }
        const voids = [...document.querySelectorAll('.cm-content .cm-md-table-void')]
        const hr = host ? host.getBoundingClientRect() : { height: 0 }
        return {
          events: window.__imeEvents || [],
          state: {
            text: el ? el.textContent.replace(/^\\+/, '') : '',
            lines: all.length,
            hostH: Math.round(hr.height),
            voids: voids.length,
            voidH: voids.length ? Math.round(voids[0].getBoundingClientRect().height) : -1,
            top: Math.round(r.top)
          }
        }
      })()`)
      const started = snap.events.filter(e => e.startsWith('compositionstart')).length
      const endedEarly = snap.events.some(e => e.startsWith('compositionend'))
      imeEvents = snap.events
      if (started !== 1 || endedEarly) {
        console.log(`    (第 ${attempt} 次组合被环境打断:start=${started}, end=${endedEarly})`)
        continue
      }
      imeDuring = snap.state
      console.log('    during ime:', JSON.stringify(imeDuring))
      await wc.debugger.sendCommand('Input.insertText', { text: '输入文字' })
      imeCommitted = true
    } catch (err) {
      console.log('    ime debugger err:', String(err))
    } finally {
      try {
        wc.debugger.detach()
      } catch {
        /* 没 attach 成功 */
      }
    }
  }
  await sleep(500)
  if (imeCommitted) imeEvents = await evalJs<string[]>(`window.__imeEvents || []`)
  console.log('    ime events:', JSON.stringify(imeEvents))
  check(
    '组合事件按输入法时序送达',
    imeCommitted &&
      imeEvents.some(e => e.startsWith('compositionstart')) &&
      imeEvents.some(e => e.startsWith('compositionend')),
    JSON.stringify(imeEvents)
  )
  const imeRows = await evalJs<number>(
    `document.querySelectorAll('.cm-md-table-widget tbody tr').length`
  )
  check('输入法提交后表格行数没有增加', imeRows === 1, String(imeRows))
  check(
    '组合期间文档行数不变(没有偷偷插行)',
    imeDuring !== null && imeBefore !== null && imeDuring.lines === imeBefore.lines,
    JSON.stringify({ before: imeBefore?.lines, during: imeDuring?.lines })
  )
  check(
    '组合期间表格版式稳定(宿主高度不变、折叠行仍为 0 高)',
    imeDuring !== null &&
      imeBefore !== null &&
      imeDuring.hostH === imeBefore.hostH &&
      imeDuring.voids === imeBefore.voids &&
      imeDuring.voidH === 0 &&
      imeDuring.top === imeBefore.top,
    JSON.stringify({ before: imeBefore, during: imeDuring })
  )
  check(
    '组合文字原地替换、没有重复(落在表格下方正文行行首)',
    imeDuring !== null && imeDuring.text === 'ni末尾',
    JSON.stringify(imeDuring?.text)
  )
  structureSource = await readSource()
  check(
    '输入法文字是独立段落',
    structureSource.some(l => l.includes('输入文字') && !l.trim().startsWith('|')) &&
      !structureSource.some(l => l.trim().startsWith('|') && l.includes('输入文字')),
    JSON.stringify(structureSource)
  )
  const imeLine = structureSource.findIndex(l => l.includes('输入文字'))
  check(
    '表格与输入之间恰好一条空行',
    imeLine > 1 &&
      structureSource[imeLine].startsWith('输入文字') &&
      structureSource[imeLine - 1] === '' &&
      structureSource[imeLine - 2].trim().startsWith('|'),
    JSON.stringify(structureSource)
  )
  const imeAfter = await evalJs<{ top: number; gapH: number; gapCount: number }>(`
    (() => {
      const line = [...document.querySelectorAll('.cm-content .cm-line')]
        .find(l => (l.textContent || '').includes('输入文字'))
      const gaps = [...document.querySelectorAll('.cm-content .cm-md-table-gap')]
      return {
        top: line ? Math.round(line.getBoundingClientRect().top) : -1,
        gapCount: gaps.length,
        gapH: gaps.length ? Math.round(gaps[0].getBoundingClientRect().height) : -1
      }
    })()`)
  check(
    '输入法提交后文字仍停在原来那一行(结构空行折成零高)',
    imeBefore !== null &&
      imeAfter.top === imeBefore.top &&
      imeAfter.gapCount === 1 &&
      imeAfter.gapH === 0,
    JSON.stringify({ before: imeBefore?.top, after: imeAfter })
  )

  // ---------- 3o. 点击表格隐藏行/底部空白:光标不会停进源码 ----------

  console.log('\n【3o】点击表格隐藏行/底部空白:光标不会停进隐藏源码')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const linesBeforeVoidClick = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  const voidSpot = await evalJs<{ x: number; y: number } | null>(`
    (() => {
      const voids = [...document.querySelectorAll('.cm-content .cm-md-table-void')]
      const el = voids[voids.length - 1]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 1) }
    })()`)
  check('找到了表格底部隐藏行', !!voidSpot, JSON.stringify(voidSpot))
  if (voidSpot) {
    wc.sendInputEvent({ type: 'mouseDown', x: voidSpot.x, y: voidSpot.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: voidSpot.x, y: voidSpot.y, button: 'left', clickCount: 1 })
  }
  await sleep(350)
  const linesAfterVoidClick = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  check('点击隐藏行/底部空白不会改文档', linesAfterVoidClick === linesBeforeVoidClick, `${linesBeforeVoidClick} → ${linesAfterVoidClick}`)
  check(
    '光标没有停进表格隐藏源码',
    !(await evalJs<boolean>(`(() => {
      const s = document.getSelection()
      if (!s || !s.anchorNode) return false
      const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
      return !!el?.closest?.('.cm-md-table-widget')
    })()`))
  )
  await typeFocused('X')
  await sleep(400)
  structureSource = await readSource()
  check(
    '随后输入仍是普通段落,表格行数不变',
    structureSource.some(l => l.includes('X') && !l.trim().startsWith('|')) &&
      structureSource.some(l => l.trim() === '| 1 | 2 |') &&
      !structureSource.some(l => l.trim().startsWith('|') && l.includes('X')),
    JSON.stringify(structureSource)
  )

  // ---------- 3p. 表格贴着文末:向下走会自动补出可编辑正文行 ----------

  console.log('\n【3p】表格贴着文末:↓ 补出可编辑正文行,不会把光标塞回表格')
  await loadDoc('开头\n| A | B |\n| --- | --- |\n| 1 | 2 |\n')
  await sleep(500)
  await focusEditor()
  await key('Home', ['control'])
  await key('End') // 「开头」行尾,表格紧贴其下
  const linesBeforeTail = await evalJs<number>(
    `document.querySelectorAll('.cm-content .cm-line').length`
  )
  await key('ArrowDown')
  await sleep(450)
  check('表格仍然渲染着', (await renderedTableCount()) === 1)
  const tailCaret = await evalJs<{ text: string; cls: string; lines: number }>(`(() => {
    const s = document.getSelection()
    const all = document.querySelectorAll('.cm-content .cm-line')
    if (!s || !s.anchorNode) return { text: '', cls: '', lines: all.length }
    const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
    const line = el?.closest?.('.cm-line')
    if (!line) return { text: '', cls: '', lines: all.length }
    const copy = line.cloneNode(true)
    copy.querySelectorAll('.line-plus').forEach(w => w.remove())
    return { text: copy.textContent.trim(), cls: line.className, lines: all.length }
  })()`)
  console.log('    caret below EOF table:', JSON.stringify(tailCaret))
  check(
    '光标落在补出的正文行上(不是表格/结构空行)',
    tailCaret.text === '' &&
      !tailCaret.cls.includes('cm-md-table-gap') &&
      !tailCaret.cls.includes('cm-md-table-void'),
    JSON.stringify(tailCaret)
  )
  check(
    '源码里确实补出了新行',
    tailCaret.lines === linesBeforeTail + 1,
    `${linesBeforeTail} → ${tailCaret.lines}`
  )
  await typeFocused('X')
  await sleep(400)
  structureSource = await readSource()
  check(
    'X 在表格下方独立成段,表格仍完整',
    structureSource.some(
      (l, i) => l.includes('X') && !l.trim().startsWith('|') && structureSource[i - 1] === ''
    ) &&
      structureSource.some(l => l.trim() === '| 1 | 2 |') &&
      !structureSource.some(l => l.trim().startsWith('|') && l.includes('X')),
    JSON.stringify(structureSource)
  )

  // ---------- 3q. 整表对齐按钮 ----------

  console.log('\n【3q】表格左下角的对齐按钮:一次改掉整张表文字的对齐')
  await loadDoc('开头\n\n| A | B |\n| :--- | ---: |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)

  const cellAligns = (): Promise<{ head: string[]; body: string[] }> =>
    evalJs(`
      (() => {
        const t = document.querySelector('.cm-md-table-widget table')
        if (!t || !t.tHead?.rows[0]) return { head: [], body: [] }
        const of = row => [...row.cells].map(c => c.style.textAlign || '')
        return {
          head: of(t.tHead.rows[0]),
          body: [...(t.tBodies[0]?.rows ?? [])].flatMap(of)
        }
      })()`)

  let aligns = await cellAligns()
  check(
    '初始对齐来自分隔行:第一列左、第二列右',
    JSON.stringify(aligns.head) === JSON.stringify(['left', 'right']),
    JSON.stringify(aligns)
  )

  /** 三个整表按钮(选择 / 删除 / 对齐)是不是都常驻可见(不依赖鼠标位置) */
  const pinnedShown = (): Promise<boolean> =>
    evalJs<boolean>(`
      (() => {
        const acts = ['select-table', 'delete-table', 'align-table']
        return acts.every(act => {
          const b = document.querySelector('[data-act="' + act + '"]')
          if (!b) return false
          const s = getComputedStyle(b)
          return s.visibility === 'visible' && Number(s.opacity) === 1
        })
      })()`)

  check('整表选择 / 删除 / 对齐三枚按钮常驻,不用先悬停', await pinnedShown())

  check('点对齐按钮打开菜单', await click('[data-act="align-table"]'))
  await sleep(150)
  const alignMenu = await evalJs<{ open: boolean; labels: string[]; active: string[] } | null>(`
    (() => {
      const m = document.querySelector('.cm-md-table-align-menu')
      if (!m) return null
      return {
        open: m.classList.contains('is-open'),
        labels: [...m.querySelectorAll('.cm-md-table-align-option')].map(el => el.textContent.trim()),
        active: [...m.querySelectorAll('.cm-md-table-align-option.is-active')].map(el => el.dataset.align)
      }
    })()`)
  check(
    '菜单开着,三项齐全',
    alignMenu?.open === true && alignMenu.labels.length === 3,
    JSON.stringify(alignMenu)
  )
  check(
    '各列对齐不一致时,菜单不勾选任何一项',
    alignMenu?.active.length === 0,
    JSON.stringify(alignMenu?.active)
  )

  check('菜单里选「居中」', await click('.cm-md-table-align-option[data-align="center"]'))
  await sleep(400)
  structureSource = await readSource()
  check(
    '分隔行每一列都写成 :---:',
    structureSource.includes('| :---: | :---: |'),
    JSON.stringify(structureSource)
  )
  aligns = await cellAligns()
  check(
    '表头与正文的所有格子都居中了',
    [...aligns.head, ...aligns.body].every(a => a === 'center'),
    JSON.stringify(aligns)
  )
  check(
    '单元格内容没有变动',
    structureSource.some(l => l.trim() === '| A | B |') &&
      structureSource.some(l => l.trim() === '| 1 | 2 |'),
    JSON.stringify(structureSource)
  )
  check(
    '选完菜单自动收起',
    await evalJs<boolean>(`!document.querySelector('.cm-md-table-align-menu.is-open')`)
  )

  check('重新打开菜单', await click('[data-act="align-table"]'))
  await sleep(150)
  const activeAfterCenter = await evalJs<string[]>(
    `[...document.querySelectorAll('.cm-md-table-align-option.is-active')].map(el => el.dataset.align)`
  )
  check(
    '当前对齐(居中)被勾选',
    JSON.stringify(activeAfterCenter) === JSON.stringify(['center']),
    JSON.stringify(activeAfterCenter)
  )

  check('改选「右对齐」', await click('.cm-md-table-align-option[data-align="right"]'))
  await sleep(400)
  structureSource = await readSource()
  check(
    '分隔行每一列都写成 ---:',
    structureSource.includes('| ---: | ---: |'),
    JSON.stringify(structureSource)
  )
  aligns = await cellAligns()
  check(
    '所有格子右对齐',
    [...aligns.head, ...aligns.body].every(a => a === 'right'),
    JSON.stringify(aligns)
  )

  check('再打开菜单', await click('[data-act="align-table"]'))
  await sleep(120)
  await evalJs<boolean>(`(() => { document.querySelector('.cm-md-table-frame')?.focus(); return true })()`)
  await key('Escape')
  await sleep(150)
  check(
    'Esc 只收起菜单',
    await evalJs<boolean>(`!document.querySelector('.cm-md-table-align-menu.is-open')`)
  )
  check('文档没有因为 Esc 变动', JSON.stringify(await readSource()) === JSON.stringify(structureSource))

  wc.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  await sleep(150)
  check(
    '鼠标离开表格后:三枚整表按钮仍然常驻,行列控件收起',
    (await pinnedShown()) &&
      (await evalJs<number>(
        `document.querySelectorAll('.cm-md-table-ctl.is-shown').length`
      )) === 0
  )

  // ---------- 3r. 只有紧贴表格的那一行才触发整表选中 ----------

  console.log('\n【3r】光标与表格之间还隔着空行时,Delete / Backspace 不抢按键')

  // 下方:表格 + 结构空行(隐藏) + 两条可见空行 + 末尾
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const belowLinesBefore = (await readSource()).length
  await key('End', ['control']) // 文末的空行
  await key('ArrowUp') // 末尾
  await key('Home')
  await key('Backspace')
  await sleep(400)
  check(
    '下方隔两行时 Backspace 只是合并空行,不选表',
    (await selectedCount()) === 0 && (await renderedTableCount()) === 1,
    String(await selectedCount())
  )
  let belowLines = await readSource()
  check(
    '文档正常少一行,表格与正文都还在',
    belowLines.length === belowLinesBefore - 1 &&
      belowLines.some(l => l.includes('末尾')) &&
      belowLines.some(l => l.trim() === '| 1 | 2 |'),
    JSON.stringify(belowLines)
  )

  // 下方第一条可见行:紧贴结构空行 → 仍然先选中整表
  await loadDoc('开头\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const belowAdjacentSource = await readSource()
  await key('End', ['control'])
  await key('ArrowUp') // 末尾
  await key('ArrowUp') // 表格下方第一条可见空行
  await key('Backspace')
  await sleep(400)
  check(
    '下方第一行按 Backspace:先选中整表,文档不变',
    (await selectedCount()) === 4 &&
      JSON.stringify(await readSource()) === JSON.stringify(belowAdjacentSource),
    String(await selectedCount())
  )

  // 上方:开头 + 一条可见空行 + 结构空行(隐藏) + 表格
  await loadDoc('开头\n\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const aboveLinesBefore = (await readSource()).length
  await key('Home', ['control'])
  await key('End') // 开头行尾(上方第二条可见行)
  await key('Delete')
  await sleep(400)
  check(
    '上方隔一行时 Delete 只是合并行,不选表',
    (await selectedCount()) === 0 && (await renderedTableCount()) === 1,
    String(await selectedCount())
  )
  let aboveLines = await readSource()
  check(
    '文档正常少一行,表格完好',
    aboveLines.length === aboveLinesBefore - 1 &&
      aboveLines.some(l => l.trim() === '| 1 | 2 |'),
    JSON.stringify(aboveLines)
  )

  // 上方第一条可见行:紧贴结构空行 → Delete 仍然先选中整表
  await loadDoc('开头\n\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  await sleep(500)
  await focusEditor()
  const aboveAdjacentSource = await readSource()
  await key('Home', ['control'])
  await key('ArrowDown') // 表格上方第一条可见空行
  await key('Delete')
  await sleep(400)
  check(
    '上方第一行按 Delete:先选中整表,文档不变',
    (await selectedCount()) === 4 &&
      JSON.stringify(await readSource()) === JSON.stringify(aboveAdjacentSource),
    String(await selectedCount())
  )

  // ---------- 4. 取消 / Esc 什么都不做 ----------

  console.log('\n【4】取消与 Esc:文档一个字符都不动')
  await loadDoc(START)
  check('再点开菜单', await openMenuAndPick('表格'))
  await sleep(150)
  await click('.line-dialog-btn:not(.line-dialog-primary)')
  await sleep(250)
  check('点「取消」后对话框关掉', await evalJs<boolean>(`!document.querySelector('.line-dialog')`))
  check('文档没变', JSON.stringify(await readSource()) === JSON.stringify(['第一行', '', '第三行']))

  check('第三次点开菜单', await openMenuAndPick('表格'))
  await focusEditor()
  await key('Escape')
  await sleep(250)
  check('对话框里按 Esc 也能关', await evalJs<boolean>(`!document.querySelector('.line-dialog')`))
  check('文档仍然没变', JSON.stringify(await readSource()) === JSON.stringify(['第一行', '', '第三行']))

  check('第四次点开菜单(Esc 收菜单这一条)', await click('.line-plus'))
  await sleep(200)
  await focusEditor()
  await key('Escape')
  await sleep(250)
  check('菜单按 Esc 关掉', await evalJs<boolean>(`!document.querySelector('.line-menu')`))
  check('文档还是没变', JSON.stringify(await readSource()) === JSON.stringify(['第一行', '', '第三行']))

  // ---------- 5. 失败路径 ----------

  console.log('\n【5】失败路径:对话框开着的时候插件被停用,确定后文档一个字符都不变')
  await loadDoc(START)
  check('点开菜单', await openMenuAndPick('表格'))
  await getPluginHost()!.save('quick-edit', { enabled: false })
  await sleep(400)
  check('填 5 行 2 列', await setNumbers(5, 2))
  check('点得到「确定」', await click('.line-dialog-primary'))
  await sleep(700)
  check('文档一个字符都没变', JSON.stringify(await readSource()) === JSON.stringify(['第一行', '', '第三行']))
  const toasts = await toastTexts()
  check(
    '并且吭了声(右下角气泡里带上了失败原因)',
    toasts.some(t => /失败/.test(t)),
    JSON.stringify(toasts)
  )
  const alerts = await evalJs<string[]>(`window.__alerts`)
  check('而且不再是会掐断操作的模态 alert', alerts.length === 0, JSON.stringify(alerts))

  check(
    '重新启用插件',
    await getPluginHost()!
      .save('quick-edit', { enabled: true })
      .then(() => true)
  )
  await sleep(500)

  // ---------- 6. 重新初始化宿主(模拟重启) ----------

  console.log('\n【6】重新初始化插件宿主 + 重载渲染层 —— descriptor 从磁盘重建后照旧')
  await initPluginHost(ensureBundledProvisioned)
  await sleep(400)
  await loadDoc(START)
  check('重启后按钮还在', (await plusLine()) === 1, `按钮在第 ${await plusLine()} 行`)
  check('重启后菜单里还有「表格」', await openMenuAndPick('表格'))
  check('重启后还能建表', await setNumbers(2, 3))
  check('点确定', await click('.line-dialog-primary'))
  await sleep(700)
  const afterRestart = await readSource()
  check(
    '重启后建的 2 行 3 列的表落盘正确',
    JSON.stringify(afterRestart) === JSON.stringify(['第一行', blank(3), sep(3), blank(3), '', '第三行']),
    JSON.stringify(afterRestart)
  )

  // ---------- 7. 贡献点的通用性:template 条目 ----------

  console.log('\n【7】另一个插件贡献 template 条目:不过插件往返也能插入')
  const host = getPluginHost()
  if (!host) throw new Error('插件宿主不见了')
  await installFromEnvelope(host, templatePackage(), {
    source: 'local',
    publisher: null,
    registryUrl: null,
    grantedPermissions: []
  })
  await host.save('tmp-template', { enabled: true })
  await sleep(400)

  await loadDoc(START)
  await sleep(500)
  const twoPluginLabels = (await getPluginHost()!.list()).length >= 3
  check('临时插件已装好', await twoPluginLabels)
  const merged = await openMenu()
  check(
    '菜单把两个插件的条目合在了一起',
    merged.includes('表格') && merged.includes('引用') && merged.includes('短横线'),
    JSON.stringify(merged)
  )
  check('点「引用」', await openMenuAndPick('引用'))
  check('template 条目**不弹对话框**', await evalJs<boolean>(`!document.querySelector('.line-dialog')`))
  await sleep(500)
  const quoted = await readSource()
  check(
    '`> ` 直接插到了下一行(插件代码一行都没跑)',
    JSON.stringify(quoted) === JSON.stringify(['第一行', '> ', '', '第三行']),
    JSON.stringify(quoted)
  )

  // ---------- 7b. `---` 模板:不能让插入点吃掉上面那行正文 ----------

  console.log('\n【7b】`---` 模板:上方多补一个空行,免得把上一行读成 setext 标题')
  await loadDoc('第一行\n正文\n第三行\n')
  await focusEditor()
  await key('ArrowDown') // 光标停到「正文」那一行
  check('点「短横线」', await openMenuAndPick('短横线'))
  await sleep(500)
  const ruled = await readSource()
  check(
    '`---` 插在「正文」下方,并且被空行隔开',
    JSON.stringify(ruled) === JSON.stringify(['第一行', '正文', '', '---', '', '第三行']),
    JSON.stringify(ruled)
  )
  const becameHeading = await evalJs<boolean>(`
    [...document.querySelectorAll('.cm-content .cm-line')]
      .some(el => el.textContent.trim() === '正文' && /cm-md-h[12]/.test(el.className))`)
  check('「正文」没有被读成 setext 标题(还是普通段落)', !becameHeading)
  const bodyCls = await evalJs<string[]>(`
    [...document.querySelectorAll('.cm-content .cm-line')]
      .filter(el => el.textContent.trim() === '正文').map(el => el.className)`)
  check(
    '「正文」那一行只有基础的 cm-line(没有任何 cm-md-* 装饰)',
    bodyCls.length > 0 && bodyCls.every(c => c.trim() === 'cm-line'),
    JSON.stringify(bodyCls)
  )

  const tmpPlugin = (await getPluginHost()!.list()).find(
    p => p.descriptor.id === 'tmp-template'
  ) as { state: { failures: number; lastMessage: string } } | undefined
  check(
    '临时插件的 runAction 确实没被调用(没有失败计数)',
    (tmpPlugin?.state.failures ?? 0) === 0,
    JSON.stringify(tmpPlugin?.state)
  )

  await host.uninstall('tmp-template', { removeConfig: true })
  await sleep(300)

  // ---------- 8. 停用 ----------

  console.log('\n【8】在插件页关掉 Advanced Table → 按钮消失')
  await loadDoc(START)
  check('关之前按钮在', (await plusLine()) === 1)
  await getPluginHost()!.save('quick-edit', { enabled: false })
  await sleep(600)
  check('停用后按钮没了', (await plusLine()) === -1, `按钮在第 ${await plusLine()} 行`)
  check('连菜单也打不开', !(await click('.line-plus')))
  await getPluginHost()!.save('quick-edit', { enabled: true })
  await sleep(600)
  check('重新启用后按钮回来', (await plusLine()) === 1)

  // ---------- 9. 插件不存在 ----------

  console.log('\n【9】插件目录整个不在(等于没装)→ 连按钮都不画')
  await rm(join(ud, 'plugins', 'quick-edit'), { recursive: true, force: true })
  // 不带 provision:这一次不补装,模拟「这台机器上根本没有这个插件」
  await initPluginHost()
  await sleep(300)
  await loadDoc(START)
  check('没有插件时编辑器里没有「+」', (await plusLine()) === -1, `按钮在第 ${await plusLine()} 行`)
  check('文档照常可编辑,只是没有 +', (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line').length`)) === 4)

  // 观感只能靠看:截一张落进仓库的 .verify-ud/shots/(已 gitignore)。
  // 截图失败不该把已经全部通过的断言判成崩溃。
  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  try {
    await writeFile(join(shots, 'quick-edit.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    console.warn(`[verify] 截图失败(不影响断言):${err instanceof Error ? err.message : String(err)}`)
  }

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
