/**
 * 表格单元格的「新增行列对齐 / 行内 Markdown+LaTeX / 区域复制粘贴」端到端验证。
 *
 * 覆盖三件事:
 *   1. 表头/正文默认居中(quick-edit 插出来的是 `:---:`)时,用表格四周的「+」
 *      新增的行、列也必须是居中的 —— 列的对齐标记在分隔行里,新列不能凭空退成
 *      `---`(左对齐);新行则要按所在列的对齐走。
 *   2. 单元格在渲染态走 markdown-it 行内渲染:粗体/代码/行内公式都该变成真元素,
 *      而不是露出源码;以 `- ` / `1. ` 开头的整格内容折成 <ul>/<ol>。
 *   3. 拖选一块矩形单元格后 Ctrl+C 复制成 TSV;把光标放进某一格再 Ctrl+V,
 *      按原样(几行几列)写进去 —— 超出表格范围时表格跟着长。
 *
 * 跑法(在仓库根目录):
 *   xvfb-run -a node verify/run.mjs table-cells
 */

import { app, clipboard, dialog, protocol, type BrowserWindow } from 'electron'
import MarkdownIt from 'markdown-it'
import { installCellLists } from '../src/renderer/src/services/cellList'
import { APP_VERSION } from './appVersion'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'

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

/** quick-edit 插出来的表长这样:全空的 3×3,所有列居中 */
const CENTERED_3X3 = [
  '|         |         |         |',
  '| :---: | :---: | :---: |',
  '|         |         |         |',
  '|         |         |         |'
].join('\n')

const FILLED_3X3 = [
  '| 姓名 | 年龄 | 城市 |',
  '| :---: | :---: | :---: |',
  '| 张三 | 30 | 北京 |',
  '| 李四 | 25 | 上海 |'
].join('\n')

/** 用户截图里的那一格:一整条列表文本被折在一格里,没有竖线 */
const LIST_CELL =
  '- 双臂（12自由度）：每个臂6自由度；- 升降（1或2自由度）：上下或上下+前后；- 底盘（3自由度）：2线速度、1角速度；'

protocol.registerSchemesAsPrivileged([
  { scheme: 'imark', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

async function main(): Promise<void> {
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
        autoSaveMode: 'off'
      },
      null,
      2
    ),
    'utf8'
  )

  registerIpc()
  registerImarkProtocol()
  const settings = await loadSettings()
  const service = await initExtensions({ appVersion: APP_VERSION })
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

  /** 写盘 + 重载窗口,拿到一个光标在文首的干净编辑器 */
  async function loadDoc(content: string): Promise<void> {
    await writeFile(note, content, 'utf8')
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
  }

  const tableCount = (): Promise<number> => evalJs(`document.querySelectorAll('.cm-content table').length`)

  /** 点某个「+」/「×」控件(按钮的 click 处理与真实点击一致) */
  async function clickControl(selector: string): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const b = document.querySelector(${JSON.stringify(selector)})
      if (!b) return false
      b.click()
      return true
    })()`)
    await sleep(350)
    return ok
  }

  /** 在正在编辑的格子里写入文字并失焦提交 */
  async function typeActive(text: string): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.activeElement
      const cell = el && el.closest ? el.closest('th,td') : null
      if (!cell || !cell.closest('.cm-md-table-widget')) return false
      cell.textContent = ${JSON.stringify(text)}
      cell.blur()
      return true
    })()`)
    await sleep(450)
    return ok
  }

  const grid = (): Promise<{ th: string[]; rows: string[][]; aligns: string[] }> =>
    evalJs(`
      (() => {
        const t = document.querySelector('.cm-content .cm-md-table-widget table')
        if (!t) return { th: [], rows: [], aligns: [] }
        const cell = el => ({
          text: el.textContent.trim(),
          align: getComputedStyle(el).textAlign
        })
        return {
          th: [...t.querySelectorAll('thead th')].map(el => el.textContent.trim()),
          rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(el => el.textContent.trim())),
          aligns: [...t.querySelectorAll('thead th')].map(el => getComputedStyle(el).textAlign)
        }
      })()`)

  /** 区域内格子的对齐方式(按 data-row/data-col 取) */
  const alignsAt = (positions: Array<[number, number]>): Promise<string[]> =>
    evalJs(`
      (() => {
        const pick = ${JSON.stringify(positions)}
        return pick.map(([r, c]) => {
          const el = document.querySelector('.cm-content .cm-md-table-widget [data-row="' + r + '"][data-col="' + c + '"]')
          return el ? getComputedStyle(el).textAlign : 'missing'
        })
      })()`)

  /**
   * 拖选矩形区域:从一个格子的某个位置按下,拖到另一个格子后松开。
   * 只给格子下标,位置由几何算 —— 与真实鼠标路径一致。
   */
  async function dragSelect(
    from: [number, number],
    to: [number, number]
  ): Promise<void> {
    const pts = await evalJs<{ ax: number; ay: number; bx: number; by: number } | null>(`
      (() => {
        const get = (r, c) => document.querySelector(
          '.cm-content .cm-md-table-widget [data-row="' + r + '"][data-col="' + c + '"]')
        const a = get(${from[0]}, ${from[1]})
        const b = get(${to[0]}, ${to[1]})
        if (!a || !b) return null
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return {
          ax: Math.round(ra.left + ra.width / 2), ay: Math.round(ra.top + ra.height / 2),
          bx: Math.round(rb.left + rb.width / 2), by: Math.round(rb.top + rb.height / 2)
        }
      })()`)
    if (!pts) return
    // 同一格里拖一小段:单击会进入编辑态,1×1 的结构选区只能靠拖动产生
    if (from[0] === to[0] && from[1] === to[1]) pts.bx = pts.ax + 20
    wc.sendInputEvent({ type: 'mouseDown', x: pts.ax, y: pts.ay, button: 'left', clickCount: 1 })
    await sleep(60)
    wc.sendInputEvent({ type: 'mouseMove', x: pts.bx, y: pts.by })
    await sleep(120)
    wc.sendInputEvent({ type: 'mouseUp', x: pts.bx, y: pts.by, button: 'left', clickCount: 1 })
    await sleep(300)
  }

  async function clickCell(row: number, col: number): Promise<boolean> {
    const p = await evalJs<{ x: number; y: number } | null>(`
      (() => {
        const el = document.querySelector(
          '.cm-content .cm-md-table-widget [data-row="${row}"][data-col="${col}"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (!p) return false
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(350)
    return true
  }

  async function hotkey(keyCode: string, modifiers: string[] = ['control']): Promise<void> {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(350)
  }

  /**
   * 合成一次 paste 事件(带 text/plain + text/html)。
   * 主进程 clipboard 在 xvfb 下拿不到 renderer 写的 HTML,而「从聊天软件复制
   * 渲染列表」正好是 HTML 剪贴板 —— 只能在页面里造事件。返回是否被应用接管。
   */
  async function dispatchPaste(
    plain: string,
    html: string,
    selector = '.cm-md-table-widget'
  ): Promise<boolean> {
    return evalJs<boolean>(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)})
      if (!target) return false
      const data = new DataTransfer()
      data.setData('text/plain', ${JSON.stringify(plain)})
      data.setData('text/html', ${JSON.stringify(html)})
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true
      })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })()`)
  }

  // ---------- 1. 新增行的对齐 ----------

  console.log('\n【1】居中表格里用「+」新增行:新行也得居中')
  await loadDoc(`开头\n\n${CENTERED_3X3}\n\n末尾\n`)
  check('表格渲染出来了', (await tableCount()) === 1, String(await tableCount()))
  const before = await grid()
  check(
    '原表所有列都居中',
    before.aligns.every(a => a === 'center'),
    JSON.stringify(before.aligns)
  )

  check(
    '点表头下方「+」插出一行',
    await clickControl('[data-act="add-row"][data-after="0"]'),
    '找不到 add-row 控件'
  )
  check('新行里的第一格直接进入编辑态', await typeActive('新行'), '没有正在编辑的格子')
  const afterRow = await grid()
  check(
    '新行内容写进去了',
    afterRow.rows[0]?.[0] === '新行',
    JSON.stringify(afterRow.rows)
  )
  check(
    '新行三格全部居中(按列对齐走)',
    JSON.stringify(await alignsAt([[1, 0], [1, 1], [1, 2]])) ===
      JSON.stringify(['center', 'center', 'center']),
    JSON.stringify(await alignsAt([[1, 0], [1, 1], [1, 2]]))
  )

  // ---------- 2. 新增列的对齐 ----------

  console.log('\n【2】居中表格里用「+」新增列:新列也得居中,不能退回左对齐')
  await loadDoc(`开头\n\n${CENTERED_3X3}\n\n末尾\n`)
  check(
    '点最右侧「+」插出一列',
    await clickControl('[data-act="add-col"][data-before="3"]'),
    '找不到 add-col 控件'
  )
  check('新列第一格进入编辑态', await typeActive('新列'), '没有正在编辑的格子')
  const afterCol = await grid()
  check('表头从 3 列变成 4 列', afterCol.th.length === 4, JSON.stringify(afterCol.th))
  check('新列表头内容正确', afterCol.th[3] === '新列', JSON.stringify(afterCol.th))
  check(
    '新列表头与正文全部居中',
    JSON.stringify(await alignsAt([[0, 3], [1, 3], [2, 3]])) ===
      JSON.stringify(['center', 'center', 'center']),
    JSON.stringify(await alignsAt([[0, 3], [1, 3], [2, 3]]))
  )

  // ---------- 2b. 用户实际那张表:一列、居中、格子里是长列表 ----------

  console.log('\n【2b】一列的居中标 + 长列表:新增列的表身也要居中')
  await loadDoc(`| 设备 |\n| :---: |\n| ${LIST_CELL} |\n`)
  check(
    '点最右侧「+」新增一列(列表表)',
    await clickControl('[data-act="add-col"][data-before="1"]'),
    '找不到 add-col 控件'
  )
  const oneCol = await alignsAt([[0, 1], [1, 1]])
  check(
    '新列表头与表身都居中',
    JSON.stringify(oneCol) === JSON.stringify(['center', 'center']),
    JSON.stringify(oneCol)
  )
  check('点进新增列的表身', await clickCell(1, 1), '找不到目标格')
  check('在新增列表身里输入内容', await typeActive('内容'), '没有正在编辑的格子')
  const oneColAfter = await alignsAt([[0, 1], [1, 1]])
  check(
    '输入内容后表头与表身仍都居中',
    JSON.stringify(oneColAfter) === JSON.stringify(['center', 'center']),
    JSON.stringify(oneColAfter)
  )

  // 没有对齐标记的普通表(从别处粘来的 `---` 表):表头不能被浏览器
  // 对 <th> 的默认 text-align:center "装成"居中,否则用户会以为整表居中
  await loadDoc('| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 30 |\n')
  const plainAlign = await alignsAt([[0, 0], [1, 0], [0, 1], [1, 1]])
  check(
    '无对齐标记的表:表头与表身视觉一致',
    new Set(plainAlign).size === 1,
    JSON.stringify(plainAlign)
  )

  // 旧版本插列会在居中表末尾留下一个 `---` 列;在它右边继续加列时,
  // 应参照整表的显式对齐,而不是一直继承那个空标记
  await loadDoc('| 姓名 | 年龄 | 城市 |\n| :---: | :---: | --- |\n| 张三 | 30 | 北京 |\n')
  check(
    '点最右侧「+」(末尾是旧版留下的 --- 列)',
    await clickControl('[data-act="add-col"][data-before="3"]'),
    '找不到 add-col 控件'
  )
  const repaired = await alignsAt([[0, 3], [1, 3]])
  check(
    '新列按整表的显式对齐补回(居中)',
    JSON.stringify(repaired) === JSON.stringify(['center', 'center']),
    JSON.stringify(repaired)
  )

  // 邻列有明确对齐时仍然优先:右对齐列的右边,新列也是右对齐
  await loadDoc('| 姓名 | 年龄 |\n| --- | ---: |\n| 张三 | 30 |\n')
  check(
    '点最右侧「+」(右对齐表)',
    await clickControl('[data-act="add-col"][data-before="2"]'),
    '找不到 add-col 控件'
  )
  const rightInherit = await alignsAt([[0, 2], [1, 2]])
  check(
    '新列继承左邻的右对齐',
    JSON.stringify(rightInherit) === JSON.stringify(['right', 'right']),
    JSON.stringify(rightInherit)
  )

  // ---------- 3. 单元格里的 Markdown + LaTeX ----------

  console.log('\n【3】单元格在渲染态解析 Markdown 与 LaTeX')
  await loadDoc(
    '| 名称 | 说明 |\n| :---: | :---: |\n| **粗体**与`代码` | $x^2 + y^2 = z^2$ |\n\n末尾\n'
  )
  const rich = await evalJs<{
    strong: string
    code: string
    katex: number
    raw: string
  }>(`
    (() => {
      const t = document.querySelector('.cm-content .cm-md-table-widget table')
      const first = t?.querySelector('tbody td:nth-child(1)')
      const second = t?.querySelector('tbody td:nth-child(2)')
      return {
        strong: first?.querySelector('strong')?.textContent ?? '',
        code: first?.querySelector('code')?.textContent ?? '',
        katex: second?.querySelectorAll('.katex').length ?? 0,
        raw: (first?.textContent ?? '') + '|' + (second?.textContent ?? '')
      }
    })()`)
  check('**粗体** 渲染成 <strong>', rich.strong === '粗体', JSON.stringify(rich))
  check('`代码` 渲染成 <code>', rich.code === '代码', JSON.stringify(rich))
  check('$...$ 渲染成 KaTeX', rich.katex > 0, JSON.stringify(rich))
  check('不再露出 Markdown/LaTeX 源码', !rich.raw.includes('**') && !rich.raw.includes('$'), rich.raw)

  // 用户真实操作路径:点进格子敲源码 → 离开格子后应当就地渲染
  check('点进数据格编辑', await clickCell(1, 0), '找不到目标格')
  check('在格子里输入 Markdown/LaTeX 源码', await typeActive('**输入**与 $x_1$'), '没有正在编辑的格子')
  const typed = await evalJs<{ strong: boolean; katex: number; raw: string }>(`
    (() => {
      const td = document.querySelector(
        '.cm-content .cm-md-table-widget [data-row="1"][data-col="0"]')
      return {
        strong: !!td?.querySelector('strong'),
        katex: td?.querySelectorAll('.katex').length ?? 0,
        raw: td?.textContent ?? ''
      }
    })()`)
  check('退出编辑后就地渲染成 <strong>', typed.strong, JSON.stringify(typed))
  check('退出编辑后就地渲染出 KaTeX', typed.katex > 0, JSON.stringify(typed))
  check('源码标记已隐藏', !typed.raw.includes('**') && !typed.raw.includes('$'), typed.raw)

  // ---------- 3b. 单元格里的列表 ----------

  console.log('\n【3b】单元格里的列表语法')
  await loadDoc(`| 设备 |\n| :---: |\n| ${LIST_CELL} |\n`)
  const list = await evalJs<{ tag: string; items: string[]; raw: string }>(`
    (() => {
      const td = document.querySelector('.cm-content .cm-md-table-widget tbody td')
      const el = td?.querySelector('.cm-md-cell-list')
      return {
        tag: el?.tagName.toLowerCase() ?? '',
        items: el ? [...el.querySelectorAll('li')].map(li => li.textContent) : [],
        raw: td?.textContent ?? ''
      }
    })()`)
  check('列表标记渲染成 <ul>', list.tag === 'ul', JSON.stringify(list))
  check('拆成 3 个条目', list.items.length === 3, JSON.stringify(list.items))
  check(
    '条目内容正确',
    list.items[0] === '双臂（12自由度）：每个臂6自由度',
    JSON.stringify(list.items)
  )
  check(
    '不再露出列表标记与分隔分号',
    !list.items.some(item => item.startsWith('-')) && !list.raw.includes('；- '),
    JSON.stringify(list)
  )
  const listAlign = await evalJs<{ ul: string; li: string }>(`
    (() => {
      const td = document.querySelector('.cm-content .cm-md-table-widget tbody td')
      const list = td?.querySelector('.cm-md-cell-list')
      if (!list) return { ul: 'missing', li: 'missing' }
      return {
        ul: getComputedStyle(list).textAlign,
        li: getComputedStyle(list.querySelector('li')).textAlign
      }
    })()`)
  check(
    '列表跟随单元格的居中对齐',
    listAlign.ul === 'center' && listAlign.li === 'center',
    JSON.stringify(listAlign)
  )
  // 留一张观感截图:列表缩进/对齐/行高对不对,断言看不出来
  try {
    const shots = join(REPO, '.verify-ud', 'shots')
    await mkdir(shots, { recursive: true })
    await writeFile(join(shots, 'table-cells-list.png'), (await wc.capturePage()).toPNG())
  } catch (err) {
    console.warn(`[verify] 截图失败(不影响断言):${err instanceof Error ? err.message : String(err)}`)
  }

  // 用户真实路径:点进格子敲源码 → 离开格子后就地折成列表
  await loadDoc('| 项 | 说明 |\n| :---: | :---: |\n| 占位 | 占位 |\n')
  check('点进数据格编辑(列表)', await clickCell(1, 0), '找不到目标格')
  check('在格子里输入有序列表', await typeActive('1. 甲；2. 乙'), '没有正在编辑的格子')
  const ordered = await evalJs<{ tag: string; items: string[] }>(`
    (() => {
      const td = document.querySelector(
        '.cm-content .cm-md-table-widget [data-row="1"][data-col="0"]')
      const el = td?.querySelector('.cm-md-cell-list')
      return {
        tag: el?.tagName.toLowerCase() ?? '',
        items: el ? [...el.querySelectorAll('li')].map(li => li.textContent) : []
      }
    })()`)
  check('有序列表渲染成 <ol>', ordered.tag === 'ol', JSON.stringify(ordered))
  check('有序列表有 2 个条目', ordered.items.length === 2, JSON.stringify(ordered.items))

  // 行内公式里的 ` - ` 是内容,不是新条目
  await loadDoc('| 说明 |\n| :---: |\n| - 区间 $a - b$；- 结束 |\n')
  const mathList = await evalJs<{ items: string[]; katex: number }>(`
    (() => {
      const td = document.querySelector('.cm-content .cm-md-table-widget tbody td')
      return {
        items: td ? [...td.querySelectorAll('li')].map(li => li.textContent) : [],
        katex: td?.querySelectorAll('.katex').length ?? 0
      }
    })()`)
  check('公式里的 - 不拆条目', mathList.items.length === 2, JSON.stringify(mathList.items))
  check('条目里的公式照常渲染', mathList.katex > 0, JSON.stringify(mathList))

  // 导出走得是另一个 markdown-it 实例,插件必须给出同样的列表
  const exportMd = new MarkdownIt({ html: false })
  installCellLists(exportMd)
  const exported = exportMd.render('| 设备 |\n| --- |\n| - 甲；- 乙 |\n')
  check(
    '导出的 HTML 同样是列表',
    exported.includes('<ul class="cm-md-cell-list"><li>甲</li><li>乙</li></ul>'),
    exported
  )
  const tight = exportMd.render('| 设备 |\n| --- |\n| -甲；-乙 |\n')
  check(
    '中文习惯的 `-甲` 不带空格也认',
    tight.includes('<li>甲</li><li>乙</li>'),
    tight
  )
  const negative = exportMd.render('| 温度 |\n| --- |\n| -5℃ |\n')
  check('负号不会被当成列表标记', !negative.includes('cm-md-cell-list'), negative)
  const arithmetic = exportMd.render(
    '| 计算 |\n| --- |\n| - 3 * 4 = 12；- 10 - 5 = 5 |\n'
  )
  check(
    '条目里的乘号/减号不拆条',
    arithmetic.includes('<li>3 * 4 = 12</li><li>10 - 5 = 5</li>'),
    arithmetic
  )

  // ---------- 4. 拖选 + Ctrl+C ----------

  console.log('\n【4】拖选一列里的两格 → Ctrl+C 复制成 TSV')
  await loadDoc(`开头\n\n${FILLED_3X3}\n\n末尾\n`)
  await dragSelect([1, 0], [2, 0])
  const selected = await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-selected').length`)
  check('拖出了 2 行 × 1 列的选区', selected === 2, String(selected))
  /*
   * 断言复制**事件**里写进去的内容,而不是主进程的 clipboard.readText():
   * 无窗口管理器的 xvfb 下主进程读不到 renderer 写的那份系统剪贴板。
   * copy 事件的 clipboardData 正是浏览器写系统剪贴板的来源;真正的往返
   * (Ctrl+C → 换格 → Ctrl+V)在【4b】里单独验。
   */
  await evalJs(`(() => {
    window.__copied = null
    const w = document.querySelector('.cm-md-table-widget')
    // 注册在应用自己的 copy 监听器之后(同节点、同捕获阶段),读到的是它写好的数据
    w.addEventListener('copy', e => {
      window.__copied = {
        types: [...e.clipboardData.types],
        text: e.clipboardData.getData('text/plain'),
        html: e.clipboardData.getData('text/html')
      }
    }, true)
    return true
  })()`)
  await hotkey('c')
  const copied = await evalJs<{ types: string[]; text: string; html: string } | null>(
    `window.__copied`
  )
  check(
    'Ctrl+C 把两格按行写成 TSV',
    copied?.text === '张三\n李四',
    JSON.stringify(copied)
  )
  check(
    '同时带一份 HTML 表格(贴到表格外的应用里仍是表)',
    !!copied?.html.includes('<table>') && copied.html.includes('张三'),
    JSON.stringify(copied?.html)
  )

  // 复制 → 换一格 → 粘贴,走的就是用户真实的那条路(Ctrl+C / Ctrl+V)
  console.log('\n【4b】复制后换一格直接 Ctrl+V:内容按原形状回来')
  check('点进表头第 2 列', await clickCell(0, 1), '找不到目标格')
  await hotkey('v')
  const roundTrip = await grid()
  check(
    '两格分别落到 (0,1) 与 (1,1)',
    roundTrip.th[1] === '张三' && roundTrip.rows[0]?.[1] === '李四',
    JSON.stringify({ th: roundTrip.th, rows: roundTrip.rows })
  )

  // ---------- 5. 光标处 Ctrl+V,按原形状粘贴 ----------

  console.log('\n【5】光标放进一格 → Ctrl+V 按 2 行 1 列写回(不够长就长表格)')
  /*
   * 用真实的「从表格里复制」而不是 clipboard.writeText:复制事件同时写 HTML
   * 表格,粘贴时才知道这是表格数据、该按矩形铺开。外部纯文本的两行散文现在
   * 会被当成一格内容(见【7】),不再是这个用例。
   */
  await loadDoc(`开头\n\n${FILLED_3X3}\n\n末尾\n`)
  await dragSelect([1, 0], [2, 0])
  await hotkey('c')
  check('点进第 3 行第 3 列那格', await clickCell(2, 2), '找不到目标格')
  await hotkey('v')
  // 粘贴落点原来只有 2 个数据行;2 行 1 列的块需要第 3 行 → 表格必须长一行
  const pasted = await grid()
  check('表格长出了第 3 个数据行', pasted.rows.length === 3, JSON.stringify(pasted.rows))
  check(
    '粘贴的两格落在光标所在列',
    pasted.rows[1]?.[2] === '张三' && pasted.rows[2]?.[2] === '李四',
    JSON.stringify(pasted.rows)
  )
  check(
    '长出来的新行仍然居中',
    JSON.stringify(await alignsAt([[3, 0], [3, 1], [3, 2]])) ===
      JSON.stringify(['center', 'center', 'center']),
    JSON.stringify(await alignsAt([[3, 0], [3, 1], [3, 2]]))
  )

  // ---------- 6. 多列粘贴:横着也要按原形状铺开 ----------

  console.log('\n【6】2×2 的块粘到表头行:横向纵向都按原形状铺开')
  clipboard.writeText('A\tB\nC\tD')
  check('点进表头第 2 列', await clickCell(0, 1), '找不到目标格')
  await hotkey('v')
  const matrix = await grid()
  check(
    '四个格子分别落位',
    matrix.th[1] === 'A' &&
      matrix.th[2] === 'B' &&
      matrix.rows[0]?.[1] === 'C' &&
      matrix.rows[0]?.[2] === 'D',
    JSON.stringify({ th: matrix.th, rows: matrix.rows })
  )
  check(
    '粘贴过的格子仍保持整表居中的对齐',
    JSON.stringify(await alignsAt([[0, 1], [0, 2], [1, 1], [1, 2]])) ===
      JSON.stringify(['center', 'center', 'center', 'center']),
    JSON.stringify(await alignsAt([[0, 1], [0, 2], [1, 1], [1, 2]]))
  )

  // ---------- 7. 外部渲染列表 → 单个格子 ----------

  console.log('\n【7】外部两行列表粘进单个格子:留在这一格,不扩表')

  const PASTE_PLAIN =
    'FAST Token 的本质：是把连续的动作降维压缩成离散的整数 ID（相当于一种特殊的“词汇”）。\n' +
    '对应的网络分支：它完全由 VLM 主干（Gemma/PaliGemma）处理，使用的是标准的语言模型交叉熵损失（Cross-Entropy）。'
  const PASTE_HTML =
    '<ul><li><strong>FAST Token 的本质</strong>：是把连续的动作降维压缩成离散的整数 ID（相当于一种特殊的“词汇”）。</li>' +
    '<li><strong>对应的网络分支</strong>：它完全由 VLM 主干（Gemma/PaliGemma）处理，使用的是标准的语言模型交叉熵损失（Cross-Entropy）。</li></ul>'

  const readCell = (): Promise<{
    bodyRows: number
    items: string[]
    strong: string[]
    raw: string
    textAlign: string
    itemAlign: string
  }> =>
    evalJs(`
      (() => {
        const td = document.querySelector('.cm-content .cm-md-table-widget tbody td')
        const list = td?.querySelector('.cm-md-cell-list')
        const li = list?.querySelector('li')
        return {
          bodyRows: document.querySelectorAll('.cm-content .cm-md-table-widget tbody tr').length,
          items: list ? [...list.querySelectorAll('li')].map(el => el.textContent.trim()) : [],
          strong: list ? [...list.querySelectorAll('li strong')].map(el => el.textContent.trim()) : [],
          raw: td?.textContent ?? '',
          textAlign: td ? getComputedStyle(td).textAlign : 'missing',
          itemAlign: li ? getComputedStyle(li).textAlign : 'missing'
        }
      })()`)

  // 1×1 结构选区(不是点进编辑态)
  await loadDoc('| 说明 |\n| :---: |\n| 原内容 |\n')
  await dragSelect([1, 0], [1, 0])
  check(
    '同一格里拖动得到 1×1 选区',
    (await evalJs<number>(`document.querySelectorAll('.cm-content .cm-md-table-selected').length`)) === 1,
    '没有选中格'
  )
  check('外部列表粘贴被表格接管', await dispatchPaste(PASTE_PLAIN, PASTE_HTML), 'paste 没有被 preventDefault')
  const singlePaste = await readCell()
  check('表格没有多出行', singlePaste.bodyRows === 1, JSON.stringify(singlePaste))
  check(
    '两段都进了同一格并折成列表',
    singlePaste.items.length === 2,
    JSON.stringify(singlePaste.items)
  )
  check(
    'HTML 里的粗体转成了 Markdown',
    singlePaste.strong[0] === 'FAST Token 的本质' &&
      singlePaste.strong[1] === '对应的网络分支',
    JSON.stringify(singlePaste.strong)
  )
  check('格子里不再露出列表标记', !singlePaste.raw.includes('- FAST'), singlePaste.raw)
  check(
    '列表跟着单元格/列居中',
    singlePaste.textAlign === 'center' && singlePaste.itemAlign === 'center',
    JSON.stringify({ textAlign: singlePaste.textAlign, itemAlign: singlePaste.itemAlign })
  )

  // 点进空格子(编辑态)粘同一份内容,同样只落这一格
  await loadDoc('| 说明 |\n| :---: |\n|  |\n')
  check('点进空格子进入编辑态', await clickCell(1, 0), '找不到目标格')
  check(
    '编辑态粘贴被表格接管',
    await dispatchPaste(PASTE_PLAIN, PASTE_HTML, '[data-row="1"][data-col="0"]'),
    'paste 没有被 preventDefault'
  )
  await evalJs(`(() => {
    const cell = document.querySelector('[data-row="1"][data-col="0"]')
    if (cell instanceof HTMLElement) cell.blur()
    return true
  })()`)
  await sleep(350)
  const activePaste = await readCell()
  check('编辑态粘贴也不扩表', activePaste.bodyRows === 1, JSON.stringify(activePaste))
  check(
    '编辑态粘贴仍折成两段列表',
    activePaste.items.length === 2,
    JSON.stringify(activePaste.items)
  )

  const shots = join(REPO, '.verify-ud', 'shots')
  await mkdir(shots, { recursive: true })
  try {
    await writeFile(join(shots, 'table-cells.png'), (await wc.capturePage()).toPNG())
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
