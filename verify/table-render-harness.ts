/**
 * 表格渲染(Typora 式)端到端验证。
 *
 * 验的是规则表里 case 'Table' 的那一整套:光标不在表内时整块渲染成真 <table>,
 * 光标进表就退回等宽源码。做法与块级公式一致 —— widget 挂在**表头那一行**上,
 * 其余行清空并折叠成零高度(CM 不允许插件提供跨行 replace)。
 *
 * 因为"折叠成零高度"和"渲染出来"是两件必须同时成立的事,这里除了查 DOM 里的
 * <table>,还要盯一条**不变式**:表格要么整块渲染,要么整块是源码;
 * 绝不能出现"后面的行被清空、widget 却没画出来"的空白 —— 那正是没有视口守卫时的表现。
 *
 * 跑法(在仓库根目录):
 *   node verify/run.mjs table-render
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initPluginHost } from '../src/main/plugins/host'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
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

/** n 行 m 列的表格源码(与 Quick Edit 插件生成的形状一致:行数含表头) */
function makeTable(rows: number, cols: number): string {
  const blank = `|${'     |'.repeat(cols)}`
  const sep = `|${' --- |'.repeat(cols)}`
  return [blank, sep, ...Array<string>(Math.max(rows - 2, 0)).fill(blank)].join('\n')
}

const TABLE_3x3 = [
  '| 姓名 | 年龄 | 城市 |',
  '| :--- | ---: | :---: |',
  '| 张三 | 30 | 北京 |',
  '| 转义 \\| 竖线 | `x|y` | 尾 |'
].join('\n')

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

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

  await writeFile(note, '占位\n', 'utf8')
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
  async function key(keyCode: string): Promise<void> {
    const code = KEY_ALIAS[keyCode] ?? keyCode
    wc.sendInputEvent({ type: 'keyDown', keyCode: code })
    wc.sendInputEvent({ type: 'keyUp', keyCode: code })
    await sleep(140)
  }

  const domLines = (): Promise<{ text: string; cls: string }[]> =>
    evalJs(`
      [...document.querySelectorAll('.cm-content .cm-line')].map(el => {
        const c = el.cloneNode(true)
        c.querySelectorAll('.line-plus').forEach(w => w.remove())
        return { text: c.textContent, cls: el.className.replace('cm-line', '').trim() }
      })`)

  const tableCount = (): Promise<number> =>
    evalJs(`document.querySelectorAll('.cm-content table').length`)

  /** 光标在第几行(1 起;读的是 DOM 选区 —— CM 会把它同步到真实文档位置) */
  const cursorLine = (): Promise<number> =>
    evalJs(`
      (() => {
        const sel = document.getSelection()
        if (!sel || !sel.anchorNode) return -1
        let el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
        const line = el?.closest?.('.cm-line')
        if (!line) return -1
        return [...document.querySelectorAll('.cm-content .cm-line')].indexOf(line) + 1
      })()`)

  /** 光标所在的那一行是不是表格行 —— 比钉死行号可靠(表格折叠会让行号不好数) */
  const cursorInTable = (): Promise<boolean> =>
    evalJs(`
      (() => {
        const sel = document.getSelection()
        if (!sel || !sel.anchorNode) return false
        const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
        return !!el?.closest?.('.cm-line')?.className.includes('cm-md-table')
      })()`)

  const scrollTo = (top: number): Promise<void> =>
    evalJs(`(() => { document.querySelector('.cm-scroller').scrollTop = ${top}; return true })()`)

  async function dump(tag: string): Promise<void> {
    const rows = await domLines()
    const tables = await tableCount()
    console.log(`\n  ${tag} —— DOM ${rows.length} 行,${tables} 张渲染出来的表,光标在第 ${await cursorLine()} 行`)
    rows.forEach((r, i) => console.log(`    ${String(i + 1).padStart(3)} | ${r.text}${r.cls ? `   〔${r.cls}〕` : ''}`))
  }

  /** 写盘 + 重载窗口,拿到一个光标在文首的干净编辑器 */
  async function loadDoc(content: string, expectLines?: number): Promise<boolean> {
    await writeFile(note, content, 'utf8')
    const done = new Promise<void>(resolve => wc.once('did-finish-load', () => resolve()))
    wc.reload()
    await done
    await sleep(1000)
    await focusEditor()
    if (expectLines !== undefined) {
      const got = await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line').length`)
      if (got !== expectLines) console.log(`    (文档 ${expectLines} 行,DOM 里是 ${got} 行)`)
    }
    return true
  }

  // ---------- 1. 光标在表外:整块渲染 ----------

  console.log('\n【1】光标不在表内 → 渲染成真表格')
  // 「末尾」前面必须留空行:表格后面紧跟一行非空文本,那一行会被吸收成表里的一格
  // (GFM 的规则,lezer 与 markdown-it 一致),这里要的是一个独立的段落
  await loadDoc(`# 标题\n${TABLE_3x3}\n\n末尾\n`)
  const info = await evalJs<{
    tables: number
    th: string[]
    rows: string[][]
    aligns: string[]
    raw: string
  }>(`
    (() => {
      const t = document.querySelector('.cm-content table')
      if (!t) return { tables: 0, th: [], rows: [], aligns: [], raw: '' }
      return {
        tables: document.querySelectorAll('.cm-content table').length,
        th: [...t.querySelectorAll('th')].map(el => el.textContent),
        rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(el => el.textContent)),
        aligns: [...t.querySelectorAll('th')].map(el => el.style.textAlign),
        raw: document.querySelector('.cm-content').textContent
      }
    })()`)
  check('DOM 里出现了一张 <table>', info.tables === 1, JSON.stringify(info.tables))
  check('表头 3 个单元格,文案与文档一致', JSON.stringify(info.th) === JSON.stringify(['姓名', '年龄', '城市']), JSON.stringify(info.th))
  check('两个数据行', info.rows.length === 2, JSON.stringify(info.rows))
  check('第一行内容正确', JSON.stringify(info.rows[0]) === JSON.stringify(['张三', '30', '北京']), JSON.stringify(info.rows[0]))
  check(
    '原始竖线源码一行都看不见(WYSIWYG 生效,不是等宽降级)',
    !info.raw.includes('| --- |') && !info.raw.includes('| 姓名 |'),
    JSON.stringify(info.raw.slice(0, 200))
  )
  check(
    '表格行只剩表头那一行(其余行折叠成零高度)',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length`)) === 3,
    String(await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length`))
  )

  // ---------- 2. 对齐 ----------

  console.log('\n【2】分隔行里的冒号 → 单元格对齐')
  check(
    '左 / 右 / 居中三列各自对上了',
    JSON.stringify(info.aligns) === JSON.stringify(['left', 'right', 'center']),
    JSON.stringify(info.aligns)
  )

  // ---------- 3. 转义竖线与代码跨度 ----------

  console.log('\n【3】转义竖线 `\\|` 留在同一格;代码跨度里的裸 `|` 按 GFM 拆成两格')
  check(
    '`\\|` 渲染成一个竖线,没有被拆列',
    info.rows[1]?.[0] === '转义 | 竖线',
    JSON.stringify(info.rows[1])
  )
  // GFM 规范要求连代码跨度里的竖线也得转义,markdown-it(iMark 导出 HTML 用的)就是这么拆的,
  // 所以编辑器里也必须这么拆 —— 两边长得一样比"自作聪明地合并"重要
  check(
    '`` `x|y` `` 拆成两格(与 GFM、与导出的 HTML 一致)',
    JSON.stringify(info.rows[1]) === JSON.stringify(['转义 | 竖线', '`x', 'y`']),
    JSON.stringify(info.rows[1])
  )

  // ---------- 4. 光标进表 → 源码态;移开 → 再渲染 ----------

  console.log('\n【4】光标进表 → 退回等宽源码;移开 → 重新渲染')
  await focusEditor()
  await key('ArrowDown') // 第 2 行 = 表头行
  await sleep(400)
  check('光标确实进了表格(第 2 行)', (await cursorLine()) === 2, String(await cursorLine()))
  check('表格没了(退回源码态)', (await tableCount()) === 0, String(await tableCount()))
  check(
    '4 行表格源码都按表格样式显示',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`)) === 4,
    String(await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`))
  )
  const inTable = await domLines()
  check(
    '源码态下 4 行原始竖线都在',
    inTable.filter(r => r.text.trim().startsWith('|')).length === 4,
    JSON.stringify(inTable.map(r => r.text))
  )

  // 光标挪出表格(多按几下,越界会被夹在末行)
  for (let i = 0; i < 8; i++) await key('ArrowDown')
  await sleep(500)
  check('光标确实离开了表格', !(await cursorInTable()), `第 ${await cursorLine()} 行`)
  check('表格重新渲染出来了', (await tableCount()) === 1, String(await tableCount()))

  // ---------- 4a. 全空格子的表格 —— 也就是「+」菜单插出来的那张 ----------

  console.log('\n【4a】全是空格子的表格(「+」菜单的默认产物)也要渲染得出来')
  // 回归用例:`|     |     |` 一格 TableCell 都不会产生(lezer 只给 TableDelimiter),
  // 早先按"表头单元格数"定列数,结果这张最常出现的表永远渲染不出来
  await loadDoc(`开头\n\n${makeTable(3, 3)}\n\n末尾\n`)
  await sleep(300)
  const emptyInfo = await evalJs<{ tables: number; th: number; td: number }>(`
    (() => {
      const t = document.querySelector('.cm-content table')
      return {
        tables: document.querySelectorAll('.cm-content table').length,
        th: t ? t.querySelectorAll('th').length : 0,
        td: t ? t.querySelectorAll('td').length : 0
      }
    })()`)
  check('空表格渲染出来了', emptyInfo.tables === 1, JSON.stringify(emptyInfo))
  check('3 列表头都在(没被当成 0 列)', emptyInfo.th === 3, JSON.stringify(emptyInfo))
  check('1 行内容 = 3 个单元格', emptyInfo.td === 3, JSON.stringify(emptyInfo))

  // ---------- 4d. 空格子的行高要和有字的一样 ----------
  //
  // 空格子没有行盒,高度只剩上下 padding + 边框,比有字的格子矮一截 —— 看上去就是"表格被压扁了"。
  // CSS 上靠给 table-cell 写 height 解决(按规范是"最小高度"语义,内容多了照旧自己长高)。
  // 这里量的是渲染态真实的 border-box 高度,空格子/有字格子两条对照着来。
  console.log('\n【4d】空格子的行高与有字的一致(表格不该被压扁)')
  const cellHeights = (): Promise<{ th: number; td: number }> =>
    evalJs(`
      (() => {
        const t = document.querySelector('.cm-content table')
        if (!t) return { th: -1, td: -1 }
        const h = el => Math.round(el.getBoundingClientRect().height * 10) / 10
        return { th: h(t.querySelector('th')), td: h(t.querySelector('tbody td')) }
      })()`)
  const emptyHeights = await cellHeights()
  console.log(`    (空格子:表头 ${emptyHeights.th}px / 单元格 ${emptyHeights.td}px)`)
  const filled = [
    '| 姓名 | 年龄 | 城市 |',
    '| --- | --- | --- |',
    '| 张三 | 30 | 北京 |'
  ].join('\n')
  await loadDoc(`开头\n\n${filled}\n\n末尾\n`)
  await sleep(300)
  const filledHeights = await cellHeights()
  console.log(`    (有字格子:表头 ${filledHeights.th}px / 单元格 ${filledHeights.td}px)`)
  // 塌到底的样子 = 上下 padding 6px×2 + 边框 2px = 14px。低于这个数说明表根本没画出来
  check('空格子的表头量到了高度', emptyHeights.th > 20, JSON.stringify(emptyHeights))
  check(
    '空表头 / 有字表头 行高一致',
    Math.abs(emptyHeights.th - filledHeights.th) < 0.6,
    `空 ${emptyHeights.th} vs 有字 ${filledHeights.th}`
  )
  check(
    '空单元格 / 有字单元格 行高一致',
    Math.abs(emptyHeights.td - filledHeights.td) < 0.6,
    `空 ${emptyHeights.td} vs 有字 ${filledHeights.td}`
  )

  // ---------- 4b. 两张表并存:一张渲染不会连累另一张 ----------

  console.log('\n【4b】文档里两张表:一张退源码态,另一张照旧渲染')
  await loadDoc(`| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\n末尾\n`)
  // 光标停在文首 = 第 1 行,也就是**第一张表里面**,所以此刻是第二张表在渲染
  check('光标在第 1 行(第一张表里)', (await cursorLine()) === 1, String(await cursorLine()))
  check('第一张表源码态、第二张表渲染态', (await tableCount()) === 1, String(await tableCount()))
  for (let i = 0; i < 5; i++) await key('ArrowDown') // 走到第 6 行 = 第二张表的表头
  await sleep(500)
  check('光标到了第二张表里(第 6 行)', await cursorInTable(), `第 ${await cursorLine()} 行`)
  check('换成第一张表渲染、第二张表源码态', (await tableCount()) === 1, String(await tableCount()))
  for (let i = 0; i < 6; i++) await key('ArrowDown') // 走出第二张表
  await sleep(600)
  check('光标离开了两张表', !(await cursorInTable()), `第 ${await cursorLine()} 行`)
  await dump('光标离开两张表之后')
  check('两张表都渲染出来了', (await tableCount()) === 2, String(await tableCount()))

  // ---------- 4c. 鼠标点进表格(「点进去编辑」那条路) ----------

  console.log('\n【4c】鼠标点表格 → 光标落进表里 → 翻回源码态')
  // widget 的 ignoreEvent() 返回 false,点击交给 CM 按坐标映射;CSS 上还得给内容加
  // pointer-events: none,否则单元格里的 <a> 会把点击抢走(顺带能触发页面跳转)。
  // 这里发的是真鼠标事件,把这两条一起验掉。
  await loadDoc(`开头\n\n${TABLE_3x3}\n\n末尾\n`)
  const spot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const r = document.querySelector('.cm-content table').getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await sleep(600)
  check('点一下表格它就退回源码态', (await tableCount()) === 0, String(await tableCount()))
  check('光标确实进到了表格行上', await cursorInTable(), `第 ${await cursorLine()} 行`)

  // ---------- 5. 不变式:不能出现"后续行被清空、表格却没画出来"的空白 ----------

  console.log('\n【5】折叠行真的是零高度,而且不会脱离 widget 单独出现')
  const bigTable = makeTable(40, 3)
  const filler = (n: number, tag: string): string =>
    Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n')
  await loadDoc(`${filler(3, '前')}\n${bigTable}\n\n${filler(3, '后')}\n`)

  // 「折叠成零高度」是这套做法的前提:折叠行只要有哪怕几 px 高,表格下面就会拖出
  // 一长条空白。CM 的行高是按 DOM 实测的,所以这里直接量。
  // 渲染态下带 widget 的那一行**没有任何 class**(cm-md-table 是源码态才加的),
  // 所以从 <table> 反着找它的行
  const heights = await evalJs<{ widget: number; voids: number[] }>(`
    (() => {
      const table = document.querySelector('.cm-content table')
      const line = table?.closest('.cm-line')
      const voids = [...document.querySelectorAll('.cm-content .cm-line.cm-md-table-void')]
      return {
        widget: line ? Math.round(line.getBoundingClientRect().height) : -1,
        voids: voids.map(el => Math.round(el.getBoundingClientRect().height * 100) / 100)
      }
    })()`)
  check('表头行拿到了 widget(它撑起了整张表的高度)', heights.widget > 400, `${heights.widget}px`)
  // 折叠行的**条数**随视口虚拟化变:表格越高,露在视口外的行越多,CM 就不给它们建 DOM。
  // 所以这里只断言"确实折叠出了零高度行",39 这个数留给下面滚到底那条 —— 那时整张表都在视野里
  check('表格行折叠出了零高度行', heights.voids.length > 0, String(heights.voids.length))
  check(
    '折叠行真的是零高度(最大的一行也不到 1px)',
    heights.voids.every(h => h < 1),
    JSON.stringify([...new Set(heights.voids)])
  )

  // 不变式:折叠行只可能在"widget 已经画出来"的前提下存在。
  // 一旦出现"行被清空了、表却没画出来",屏幕上就是一块空白 —— 那正是没有视口守卫时的表现。
  const scroller = await evalJs<number>(`document.querySelector('.cm-scroller').scrollHeight`)
  const seen: string[] = []
  let violations = 0
  let maxVoids = 0
  for (let step = 0; step <= 8; step++) {
    await scrollTo(Math.round((scroller * step) / 8))
    await sleep(260)
    const [tables, voids, top] = await evalJs<[number, number, number]>(`
      (() => [
        document.querySelectorAll('.cm-content table').length,
        document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length,
        Math.round(document.querySelector('.cm-scroller').scrollTop)
      ])()`)
    seen.push(`top=${top}: ${tables} 表 / ${voids} 折叠行`)
    if (tables === 0 && voids > 0) violations += 1
    maxVoids = Math.max(maxVoids, voids)
  }
  check('9 个滚动位置都没出现"清空了却没画表"', violations === 0, seen.join('; '))
  check('滚到能看见整张表的位置时,39 个折叠行一个不少', maxVoids === 39, String(maxVoids))
  console.log(`    (各滚动位置:${seen.join(' | ')})`)

  // ---------- 5b. 比视口还高的表格:光标从表格深处跳出去 ----------

  console.log('\n【5b】比视口还高的表格:光标从表格深处跳出去,不能留下空白')
  // 这是唯一能逼近视口守卫的路径:光标出去的那一刻,CM 手上还是"表格源码铺了 40 行"
  // 的旧布局,而插件已经把表折成一行了 —— 新旧对不上时,守卫负责别把表清空又不画
  await loadDoc(`${filler(5, '前')}\n${makeTable(40, 2)}\n\n${filler(5, '后')}\n`)
  await focusEditor()
  for (let i = 0; i < 20; i++) {
    await key('ArrowDown')
    await sleep(70)
  }
  await sleep(300)
  check('光标进到了表格深处', await evalJs<boolean>(`
    !!document.getSelection()?.anchorNode?.parentElement?.closest?.('.cm-line')?.className.includes('cm-md-table')`))
  // 直接跳回文首(光标离开表格的那一帧正是守卫要顶住的那一帧)
  await evalJs(`(() => {
    const el = document.querySelector('.cm-content')
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: el.getBoundingClientRect().left + 4, clientY: el.getBoundingClientRect().top + 4 }))
    return true
  })()`)
  await sleep(700)
  const afterJump = await evalJs<{ tables: number; voids: number }>(`
    (() => ({
      tables: document.querySelectorAll('.cm-content table').length,
      voids: document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length
    }))()`)
  check(
    '跳出去之后表格是渲染态(要么表在、要么连折叠行都没有)',
    afterJump.tables > 0 || afterJump.voids === 0,
    JSON.stringify(afterJump)
  )

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  await scrollTo(0)
  await sleep(400)
  // 截图里放两张表:「+」菜单插出来的全空表 和 有字的表 —— 两张的行高必须一样
  await loadDoc(`# 表格渲染\n\n${makeTable(3, 3)}\n\n${TABLE_3x3}\n\n上面一张是全空的(「+」插出来的样子),下面一张有字,行高应当一致。\n`)
  await writeFile(join(shots, 'table-render.png'), (await wc.capturePage()).toPNG())

  console.log(`\n结果:${pass} 通过,${fail} 失败\n`)
  app.exit(fail === 0 ? 0 : 1)
}

void main().catch(err => {
  console.error('\nharness 崩溃:', err)
  app.exit(2)
})
