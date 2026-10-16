/**
 * 行首「+」菜单 + 表格插入端到端验证(Quick Edit 插件)。
 *
 * 这条链路横跨四个进程边界:CodeMirror 装饰(渲染层) → 插件贡献点(descriptor,主进程)
 * → 插件运行时(主进程里的用户代码) → 回到渲染层改文档。任何一段接错,现象都是
 * 「点了 + 什么都没发生」,所以这里不看中间态,只钉**最终可见的结果**:
 * DOM 里的行、磁盘上的文件、光标落点(靠往那儿打字来验)。
 *
 * 覆盖:
 *   1 全新 userData:内置包自动补装、默认启用,按钮只在光标行
 *   2 点「+」→ 菜单出现,里面有「表格」
 *   3 点「表格」→ 对话框只有行数/列数 → 改成 4 行 2 列 → 确定 → 文档与磁盘都是 4×2
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
    kind: 'script',
    main: 'main.js',
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

  /** 合成输入偶尔整段丢,落空了就重新聚焦再打(丢了以后报出来的是看着像产品 bug 的假失败) */
  async function type(text: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusEditor()
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(20)
      }
      await sleep(240)
      const doc = await evalJs<string>(`document.querySelector('.cm-content')?.textContent ?? ''`)
      if (doc.includes(text)) return
      console.log(`    (第 ${attempt} 次输入没落进去:${JSON.stringify(text)})`)
    }
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

  /**
   * 每行的文字。**必须把「+」摘掉**:它是这一行 DOM 里的一员,
   * 不摘的话光标所在那行的 textContent 会多出一个 `+`。
   */
  const domLines = (): Promise<string[]> =>
    evalJs<string[]>(`[...document.querySelectorAll('.cm-content .cm-line')].map(el => {
      const c = el.cloneNode(true)
      c.querySelectorAll('.line-plus').forEach(w => w.remove())
      return c.textContent
    })`)

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

  console.log('\n【1】全新 userData:Quick Edit 自动补装且默认启用,按钮只在光标行')
  const plugins = await evalJs<
    { descriptor: { id: string }; state: { enabled: boolean }; source?: string }[]
  >(`window.api.listPlugins()`)
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

  const shown = await domLines()
  check(
    'DOM 里也看得到这张表(WYSIWYG 没把它吃掉)',
    JSON.stringify(shown.slice(0, want.length)) === JSON.stringify(want),
    JSON.stringify(shown.slice(0, 10))
  )
  check(
    '表格行按表格样式渲染(而不是一整段正文)',
    await evalJs<boolean>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length >= 5`)
  )

  console.log('\n【3b】光标落在第一个表头单元格里 —— 直接打字验证')
  await type('X')
  const afterTyping = await readSource()
  check(
    '打出来的字符进了第一个表头单元格',
    afterTyping[1] === row(' X    ', BLANK_CELL),
    JSON.stringify(afterTyping.slice(1, 3))
  )

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
      .some(el => el.textContent.includes('正文') && el.className.includes('cm-md-table'))`)
  check('「正文」没有被吸进表格(表格行数仍是 3)', !swallowed)
  check(
    '表格行数就是 3 行(表头 + 分隔 + 1 行内容)',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`)) === 3,
    String(await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`))
  )

  // ---------- 3d. 光标停在已有表格上:插入点落到整张表之下 ----------

  console.log('\n【3d】光标停在已有表格上点「+」:新表在整张表下方,老表一个字符都没少')
  await loadDoc('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾\n')
  check('点「表格」', await openMenuAndPick('表格'))
  check('填 2 行 2 列', await setNumbers(2, 2))
  check('点确定', await click('.line-dialog-primary'))
  await sleep(700)
  const twoTables = await readSource()
  check(
    '落盘是两张各自完整的表(不是被拆散的一张)',
    JSON.stringify(twoTables) ===
      JSON.stringify(['| A | B |', '| --- | --- |', '| 1 | 2 |', '', blank(2), sep(2), blank(2), '', '末尾']),
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
  await evalJs(`window.api.savePlugin('quick-edit', { enabled: false })`)
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

  check('重新启用插件', await evalJs<boolean>(`window.api.savePlugin('quick-edit', { enabled: true }).then(() => true)`))
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
  const twoPluginLabels = await evalJs<boolean>(`window.api.listPlugins().then(l => l.length >= 3)`)
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

  const tmpPlugin = await evalJs<{ state: { failures: number; lastMessage: string } }>(
    `window.api.listPlugins().then(l => l.find(p => p.descriptor.id === 'tmp-template'))`
  )
  check(
    '临时插件的 runAction 确实没被调用(没有失败计数)',
    (tmpPlugin?.state.failures ?? 0) === 0,
    JSON.stringify(tmpPlugin?.state)
  )

  await host.uninstall('tmp-template', { removeConfig: true })
  await sleep(300)

  // ---------- 8. 停用 ----------

  console.log('\n【8】在插件页关掉 Quick Edit → 按钮消失')
  await loadDoc(START)
  check('关之前按钮在', (await plusLine()) === 1)
  await evalJs(`window.api.savePlugin('quick-edit', { enabled: false })`)
  await sleep(600)
  check('停用后按钮没了', (await plusLine()) === -1, `按钮在第 ${await plusLine()} 行`)
  check('连菜单也打不开', !(await click('.line-plus')))
  await evalJs(`window.api.savePlugin('quick-edit', { enabled: true })`)
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

  // 观感只能靠看:截一张落进仓库的 .verify-ud/shots/(已 gitignore)
  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, 'quick-edit.png'), (await wc.capturePage()).toPNG())

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
