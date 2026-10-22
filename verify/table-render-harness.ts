/**
 * 表格渲染(Typora 式)端到端验证。
 *
 * 验的是规则表里 case 'Table' 的那一整套:整块渲染成真 <table>,**点击/移动光标
 * 都不再翻回 Markdown 源码** —— 单元格在渲染态就地编辑(见 TableWidget)。
 * 做法与块级公式一致 —— widget 挂在**表头那一行**上,其余行清空并折叠成零高度
 * (CM 不允许插件提供跨行 replace)。
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
import { initExtensions } from '../src/main/extensions/service'
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

/** n 行 m 列的表格源码(与 Advanced Table 插件生成的形状一致:行数含表头) */
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
  const service = await initExtensions({ appVersion: '0.1.0' })
  await ensureBundledProvisioned(service)
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
        // 按 token 比:'cm-md-table-host' / 'cm-md-table-void' 都包含 cm-md-table 子串
        const cls = el?.closest?.('.cm-line')?.className ?? ''
        return cls.split(/\\s+/).includes('cm-md-table')
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
    // 页面重载偶尔在 Windows 上等不到 did-finish-load:加超时,免得整轮验收静默挂死
    const done = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        console.log('    (页面重载超时:did-finish-load 没到)')
        resolve()
      }, 15000)
      wc.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
      wc.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        console.log(`    (页面重载失败:${code} ${desc})`)
        resolve()
      })
    })
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

  // 行高:单元格上下各留 8px 内边距,长公式(带上下标)不至于贴边
  const rowBox = await evalJs<{
    padTop: number
    padBottom: number
    rowHeight: number
    lineHeight: number
  } | null>(`
    (() => {
      const td = document.querySelector('.cm-content table tbody td')
      const tr = td && td.closest('tr')
      if (!td || !tr) return null
      const s = getComputedStyle(td)
      return {
        padTop: parseFloat(s.paddingTop),
        padBottom: parseFloat(s.paddingBottom),
        rowHeight: tr.getBoundingClientRect().height,
        lineHeight: parseFloat(s.lineHeight)
      }
    })()`)
  check(
    '单元格上下各留 8px,行高比纯文本行高多出这两段内边距',
    !!rowBox &&
      rowBox.padTop === 8 &&
      rowBox.padBottom === 8 &&
      rowBox.rowHeight >= rowBox.lineHeight + 16 - 0.5,
    JSON.stringify(rowBox)
  )

  // ---------- 1b. 结构控件:数量对、位置在表格外、默认隐藏、靠近才浮现 ----------

  console.log('\n【1b】表格四周的结构控件:只在生效范围内出现')
  // 先把鼠标挪到窗口角落,免得上一次操作留下的悬停把控件点亮
  wc.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
  await sleep(250)

  type ShownCtl = {
    act: string
    row: string | null
    col: string | null
    after: string | null
    before: string | null
  }
  const shownCtl = (): Promise<ShownCtl[]> =>
    evalJs(`
      [...document.querySelectorAll('.cm-md-table-ctl.is-shown')].map(b => ({
        act: b.dataset.act ?? '',
        row: b.dataset.row ?? null,
        col: b.dataset.col ?? null,
        after: b.dataset.after ?? null,
        before: b.dataset.before ?? null
      }))`)
  const summarize = (list: ShownCtl[]): string =>
    list
      .map(
        s =>
          `${s.act}${s.row != null ? `@${s.row}` : ''}${s.col != null ? `#${s.col}` : ''}` +
          `${s.after != null ? `>${s.after}` : ''}${s.before != null ? `<${s.before}` : ''}`
      )
      .sort()
      .join(',')
  const moveTo = async (x: number, y: number): Promise<void> => {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    await sleep(320)
  }

  const ctlInfo = await evalJs<{
    buttons: number
    expected: number
    outside: boolean
    opacity: number
    visibility: string
    trash: boolean
    selectRowButtons: number
    selectColButtons: number
  }>(`
    (() => {
      const frame = document.querySelector('.cm-md-table-frame')
      const table = frame ? frame.querySelector('table') : null
      if (!frame || !table) {
        return {
          buttons: 0, expected: 0, outside: false, opacity: 0, visibility: '',
          trash: false, selectRowButtons: -1, selectColButtons: -1
        }
      }
      const tr = table.getBoundingClientRect()
      const btns = [...frame.querySelectorAll('.cm-md-table-ctl')]
      const rows = table.querySelectorAll('tr').length
      const cols = table.querySelectorAll('thead th').length
      const style = btns.length ? getComputedStyle(btns[0]) : null
      return {
        buttons: btns.length,
        expected: rows * 2 + cols + (cols + 1) + 2 + 1,
        outside: btns.every(b => {
          const r = b.getBoundingClientRect()
          return r.right <= tr.left || r.left >= tr.right || r.bottom <= tr.top || r.top >= tr.bottom
        }),
        opacity: style ? Number(style.opacity) : 0,
        visibility: style ? style.visibility : '',
        trash: !!frame.querySelector('[data-act="delete-table"] svg'),
        selectRowButtons: frame.querySelectorAll('[data-act="select-row"]').length,
        selectColButtons: frame.querySelectorAll('[data-act="select-col"]').length
      }
    })()`)
  check(
    '控件数量 = 每行 2 个(删行 × / 插行 +) + 每列 1 个(删列 ×) + 列间插入 + 整表选择/删除/对齐',
    ctlInfo.buttons === ctlInfo.expected && ctlInfo.buttons > 0,
    JSON.stringify(ctlInfo)
  )
  check(
    '行/列选中都不再有按钮(改为按住左键拖动)',
    ctlInfo.selectRowButtons === 0 && ctlInfo.selectColButtons === 0,
    JSON.stringify(ctlInfo)
  )
  check('控件全在表格外侧的留白里(不盖住任何单元格)', ctlInfo.outside, JSON.stringify(ctlInfo))
  check(
    '鼠标不在表上时:行列控件隐藏,整表选择/删除/对齐三枚常驻',
    ctlInfo.opacity === 1 &&
      ctlInfo.visibility === 'visible' &&
      (await shownCtl()).length === 0,
    JSON.stringify(ctlInfo)
  )
  check('删除整表用的是垃圾桶图标', ctlInfo.trash, JSON.stringify(ctlInfo))

  // 留白必须被等量负外边距抵消:图标浮在四周,但不把表格往右下顶
  const spacing = await evalJs<{
    padLeft: number
    padTop: number
    marginLeft: number
    marginTop: number
  } | null>(`
    (() => {
      const f = document.querySelector('.cm-md-table-frame')
      if (!f) return null
      const s = getComputedStyle(f)
      return {
        padLeft: parseFloat(s.paddingLeft), padTop: parseFloat(s.paddingTop),
        marginLeft: parseFloat(s.marginLeft), marginTop: parseFloat(s.marginTop)
      }
    })()`)
  check(
    '左右留白被负外边距抵消;上下留白(--md-table-gap)就是表格间距',
    !!spacing &&
      spacing.padLeft === -spacing.marginLeft &&
      spacing.padLeft > 0 &&
      spacing.padTop > 0 &&
      spacing.marginTop === 0,
    JSON.stringify(spacing)
  )

  const geom = await evalJs<{
    tableLeft: number
    tableTop: number
    bodyCell: { x: number; y: number }
    headerBottom: number
    col0Right: number
    col1Center: number
    bodyRow1Y: number
  } | null>(`
    (() => {
      const table = document.querySelector('.cm-md-table-frame table')
      if (!table) return null
      const tr = table.getBoundingClientRect()
      const cell = table.querySelector('tbody td[data-row="2"][data-col="1"]')
      const head = table.querySelector('thead tr')
      const th0 = table.querySelector('thead th[data-col="0"]')
      const th1 = table.querySelector('thead th[data-col="1"]')
      const body1 = table.querySelector('tbody td[data-row="1"][data-col="1"]')
      if (!cell || !head || !th0 || !th1 || !body1) return null
      const cr = cell.getBoundingClientRect()
      const hr = head.getBoundingClientRect()
      const t0 = th0.getBoundingClientRect()
      const t1 = th1.getBoundingClientRect()
      const br = body1.getBoundingClientRect()
      return {
        tableLeft: tr.left,
        tableTop: tr.top,
        bodyCell: { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 },
        headerBottom: hr.bottom,
        col0Right: t0.right,
        col1Center: t1.left + t1.width / 2,
        bodyRow1Y: br.top + br.height / 2
      }
    })()`)
  check('拿到了表格几何信息', !!geom, String(geom))
  if (!geom) throw new Error('表格几何信息缺失,后续悬停断言无法进行')

  // 1) 鼠标放在某个单元格:只出现这一行、这一列的删除 ×
  await moveTo(geom.bodyCell.x, geom.bodyCell.y)
  check(
    '放在单元格上:只出现该行 + 该列的删除 ×',
    summarize(await shownCtl()) === 'delete-col#1,delete-row@2',
    summarize(await shownCtl())
  )
  const colGap = await evalJs<number>(`
    (() => {
      const t = document.querySelector('.cm-md-table-frame table')
      const b = document.querySelector('[data-act="delete-col"].is-shown')
      if (!t || !b) return -1
      return Math.round((t.getBoundingClientRect().top - b.getBoundingClientRect().bottom) * 10) / 10
    })()`)
  check('列删除 × 紧贴表格上沿(不再悬得很远)', colGap >= 0 && colGap <= 6, String(colGap))

  // 2) 靠近行边界线:出现这条线的插入行 +
  await moveTo(geom.col1Center, geom.headerBottom - 2)
  check(
    '靠近行边界:出现对应的插入行 +',
    summarize(await shownCtl()) === 'add-row>0,delete-col#1,delete-row@0',
    summarize(await shownCtl())
  )

  // 3) 靠近列边界线:出现这条线的插入列 +
  await moveTo(geom.col0Right - 2, geom.bodyRow1Y)
  check(
    '靠近列边界:出现对应的插入列 +',
    summarize(await shownCtl()) === 'add-col<1,delete-col#0,delete-row@1',
    summarize(await shownCtl())
  )

  // 4) 表格上沿附近:整表三枚按钮本来就常驻,这里只核对行列控件照旧按需出现
  await moveTo(geom.tableLeft + 30, geom.tableTop + 3)
  check(
    '靠近表格上沿:行列控件照旧按需出现(整表按钮不参与悬停显隐)',
    summarize(await shownCtl()) === 'delete-col#0,delete-row@0',
    summarize(await shownCtl())
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

  // ---------- 3b. 行尾空白不能变成一个空列 ----------

  console.log('\n【3b】行尾空白不属于任何单元格(不能凭空多出一列)')
  // 解析器的行节点会把 `| a | b |   ` 的行尾空格一起包进来;按"最后一根竖线在行尾"
  // 判断会把那截空白当成一格,列数凭空 +1
  await loadDoc('| a | b |   \n| --- | --- |\n| c | d |   \n\n末尾\n')
  await sleep(400)
  const trailing = await evalJs<{ th: number; td: number }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      return { th: t ? t.querySelectorAll('th').length : 0, td: t ? t.querySelectorAll('td').length : 0 }
    })()`)
  check('表头还是 2 列', trailing.th === 2, JSON.stringify(trailing))
  check('内容行也是 2 格', trailing.td === 2, JSON.stringify(trailing))

  // ---------- 4. 键盘移动经过表格:保持渲染态 ----------

  console.log('\n【4】键盘移动经过表格:保持渲染,不再翻回 Markdown 源码')
  await focusEditor()
  await key('ArrowDown') // 第 2 行 = 表格(widget 那一行)
  await sleep(400)
  check('表格仍然渲染着', (await tableCount()) === 1, String(await tableCount()))
  check(
    '没有任何一行退回等宽源码',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`)) === 0,
    String(await evalJs<number>(`document.querySelectorAll('.cm-content .cm-line.cm-md-table').length`))
  )

  // 折叠行是 atomic 的,方向键会整体跳过表格,不会把光标卡进隐藏的源码里
  for (let i = 0; i < 8; i++) await key('ArrowDown')
  await sleep(500)
  check('走完表格之后仍然是渲染态', (await tableCount()) === 1, String(await tableCount()))
  check('光标没有落进表格源码行', !(await cursorInTable()), `第 ${await cursorLine()} 行`)

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
  // 压扁之后的最小高度 = 上下 padding 2px×2 + 边框 2px;再低说明表根本没画出来
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

  // ---------- 4e. 行高压扁、列宽拉大 ----------

  console.log('\n【4e】表格外观:行高更矮、列更宽(空表的列也得有可点的宽度)')
  await loadDoc(`开头\n\n${makeTable(3, 3)}\n\n末尾\n`)
  await sleep(400)
  const box = await evalJs<{ w: number; h: number; padX: number; padY: number }>(`
    (() => {
      const el = document.querySelector('.cm-content .cm-md-table-widget th')
      if (!el) return { w: -1, h: -1, padX: -1, padY: -1 }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        padX: parseFloat(cs.paddingLeft),
        padY: parseFloat(cs.paddingTop)
      }
    })()`)
  console.log(`    (表头单元格 ${box.w}px 宽 × ${box.h}px 高,内边距 ${box.padY}px/${box.padX}px)`)
  check('删掉多余的上下内边距(2px)', box.padY === 2, JSON.stringify(box))
  check('左右内边距拉大(16px)', box.padX === 16, JSON.stringify(box))
  check('空表列宽至少 105px(比原来的窄条明显加宽)', box.w >= 105, JSON.stringify(box))
  check('行高压到 30px 以内', box.h > 0 && box.h <= 30, JSON.stringify(box))

  // ---------- 4b. 两张表并存:各自独立渲染 ----------

  console.log('\n【4b】文档里两张表:同时渲染,互不连累')
  await loadDoc(`| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n\n末尾\n`)
  await sleep(500)
  await dump('打开两张表的文档')
  check('两张表都渲染出来了', (await tableCount()) === 2, String(await tableCount()))
  const both = await evalJs<string[][]>(`
    [...document.querySelectorAll('.cm-content table')].map(t =>
      [...t.querySelectorAll('th')].map(el => el.textContent.trim()))`)
  check(
    '内容各归各的(A/B 与 C/D)',
    JSON.stringify(both) === JSON.stringify([['A', 'B'], ['C', 'D']]),
    JSON.stringify(both)
  )

  // ---------- 4c. 鼠标点进表格:渲染态就地编辑 ----------

  console.log('\n【4c】鼠标点表格 → 单元格就地输入,表格不退回源码')
  await loadDoc(`开头\n\n${TABLE_3x3}\n\n末尾\n`)
  const spot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const cell = document.querySelector('.cm-content table tbody td')
      if (!cell) return { x: -1, y: -1 }
      const r = cell.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  check('找到了可点的数据单元格', spot.x > 0, JSON.stringify(spot))
  wc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await sleep(500)
  const clicked = await evalJs<{ row: number; col: number; editable: string } | null>(`
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
  check(
    '点一下单元格就进入编辑态(不是翻回源码)',
    clicked?.editable === 'plaintext-only',
    JSON.stringify(clicked)
  )
  check('表格仍然渲染着', (await tableCount()) === 1, String(await tableCount()))
  check('光标没有落进表格源码行', !(await cursorInTable()), `第 ${await cursorLine()} 行`)

  // ---------- 4f. 引用块里的表格:加行要保住 `> ` 前缀 ----------

  console.log('\n【4f】引用块里的表格:按 Tab 加行后仍然留在引用块里')
  await loadDoc('> | a | b |\n> | --- | --- |\n> | c | d |\n>\n> 后续\n')
  await sleep(400)
  const quoteRows = (): Promise<number> =>
    evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-widget table tbody tr').length`)
  check('引用块里的表格渲染出来了(1 行内容)', (await quoteRows()) === 1, String(await quoteRows()))
  const quoteSpot = await evalJs<{ x: number; y: number }>(`
    (() => {
      const cell = [...document.querySelectorAll('.cm-content .cm-md-table-widget tbody td')].pop()
      if (!cell) return { x: -1, y: -1 }
      const r = cell.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  check('找到了最后一格', quoteSpot.x > 0, JSON.stringify(quoteSpot))
  wc.sendInputEvent({ type: 'mouseDown', x: quoteSpot.x, y: quoteSpot.y, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: quoteSpot.x, y: quoteSpot.y, button: 'left', clickCount: 1 })
  await sleep(300)
  await key('Tab')
  await sleep(500)
  check(
    '最后一格按 Tab 加出一行,新行仍在表格里(引用前缀没丢)',
    (await quoteRows()) === 2,
    String(await quoteRows())
  )

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
  // 具体条数随视口高度与控件留白变化(曾经是 39,也出现过 27),这里只要求
  // "确实挂载了足够多的折叠行",别把环境差异当成代码回归
  check('滚到能看见整张表的位置时,折叠行足够多', maxVoids >= 20, String(maxVoids))
  console.log(`    (各滚动位置:${seen.join(' | ')})`)

  // ---------- 5b. 滚动穿越比视口还高的表格 ----------

  console.log('\n【5b】滚动穿越比视口还高的表格:任何位置都不会留下空白')
  // 表头那一行承载整个 widget。它滚出可见区时规则会退回等宽源码 —— 这一步最容易出现
  // "后续行被清空、widget 又没画出来"的空白,所以沿着表格滚一遍,每个位置都查一次
  await loadDoc(`${filler(5, '前')}\n${makeTable(40, 2)}\n\n${filler(5, '后')}\n`)
  await sleep(500)
  const tableTop = await evalJs<number>(`
    (() => {
      const sc = document.querySelector('.cm-scroller')
      const line = document.querySelector('.cm-content table')?.closest('.cm-line')
      if (!sc || !line) return -1
      return Math.round(line.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop)
    })()`)
  check('找到了高表格的位置', tableTop >= 0, String(tableTop))
  const seen5: string[] = []
  let blank = 0
  for (const delta of [0, 300, 900, 1800, 3600, 5400]) {
    await scrollTo(Math.max(0, tableTop + delta))
    await sleep(350)
    const [tables, voids, sources] = await evalJs<[number, number, number]>(`
      (() => [
        document.querySelectorAll('.cm-content table').length,
        document.querySelectorAll('.cm-content .cm-line.cm-md-table-void').length,
        document.querySelectorAll('.cm-content .cm-line.cm-md-table').length
      ])()`)
    seen5.push(`+${delta}: ${tables} 表 / ${voids} 折叠 / ${sources} 源码行`)
    if (tables === 0 && voids > 0) blank += 1
  }
  check('各滚动位置都没有"清空了却没画表"', blank === 0, seen5.join('; '))
  await scrollTo(0)
  await sleep(500)
  check('滚回顶部后表格重新渲染出来', (await tableCount()) === 1, String(await tableCount()))

  // ---------- 6. 单元格里的 LaTeX ----------

  console.log('\n【6】单元格里的 LaTeX 公式交给 KaTeX 渲染')
  // 单元格的行内渲染走 markdown-it(wysiwyg/inline.ts),不是正文那套 Lezer 解析器;
  // 数学规则漏装时 $...$ 会原样露出来 —— 导出那边却渲染,两处观感不一致
  await loadDoc(
    '| 过程 | 方向 |\n| --- | --- |\n| 前向过程 | $x_0 \\to x_1 \\to \\cdots \\to x_T$ |\n\n末尾\n'
  )
  await sleep(400)
  const mathCell = await evalJs<{ katex: number; text: string; dollar: boolean }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      const td = t?.querySelector('tbody td:nth-child(2)')
      const text = td?.textContent ?? ''
      return {
        katex: td ? td.querySelectorAll('.katex').length : 0,
        text,
        dollar: text.includes('$')
      }
    })()`)
  check('单元格里的 $...$ 渲染出了 KaTeX', mathCell.katex > 0, JSON.stringify(mathCell))
  check(
    '不再露出 $ 定界符与反斜杠命令',
    !mathCell.dollar && !mathCell.text.includes('\\to'),
    JSON.stringify(mathCell.text)
  )

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  await scrollTo(0)
  await sleep(400)
  // 截图里放两张表:「+」菜单插出来的全空表 和 有字的表 —— 两张的行高必须一样
  await loadDoc(`# 表格渲染\n\n${makeTable(3, 3)}\n\n${TABLE_3x3}\n\n上面一张是全空的(「+」插出来的样子),下面一张有字,行高应当一致。\n`)
  // 截图里顺带留一个「选中一列里的几格」的样子,方便人眼核对矩形选区的观感。
  // capturePage 偶发 UnknownVizError(见 verify 记忆):截图是观感产物,不能因此把全绿判成失败
  try {
    // 截图里演示「按住左键纵向拖选一列里的几格」:拖完鼠标停在表上,控件也会浮现
    const shotSpot = await evalJs<{ ax: number; ay: number; bx: number; by: number } | null>(`(() => {
      const frames = [...document.querySelectorAll('.cm-md-table-widget')]
      const frame = frames[frames.length - 1]
      const rows = frame ? [...frame.querySelectorAll('tbody tr')] : []
      const a = rows[0]?.querySelector('td')
      const b = rows[rows.length - 1]?.querySelector('td')
      if (!a || !b) return null
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return {
        // x 不动、只往下拖:选区是一列里的若干格(起点格 ↔ 终点格围出的矩形)
        ax: Math.round(ra.left + 10), ay: Math.round(ra.top + ra.height / 2),
        bx: Math.round(ra.left + 10), by: Math.round(rb.bottom - 3)
      }
    })()`)
    if (shotSpot) {
      wc.sendInputEvent({ type: 'mouseDown', x: shotSpot.ax, y: shotSpot.ay, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseMove', x: shotSpot.bx, y: shotSpot.by })
      await sleep(80)
      wc.sendInputEvent({ type: 'mouseUp', x: shotSpot.bx, y: shotSpot.by, button: 'left', clickCount: 1 })
    }
    await sleep(400)
    await writeFile(join(shots, 'table-render.png'), (await wc.capturePage()).toPNG())
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
