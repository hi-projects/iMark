/**
 * 表格列宽拖动端到端验证。
 *
 * 验的是「拖动列边界 → 写入源码 → 重新渲染/导出」这条完整链路:
 *   1. 渲染态表格的每两条列边界之间有一个透明热区(cursor: col-resize);
 *   2. 拖动后表格切成固定布局 + 百分比 <colgroup>,铺满正文宽度;
 *   3. 松手时把宽度写回表格正上方一行 `<!-- imark:table-widths ... -->`
 *      (GFM 没有列宽语法,这是 iMark 自己的约定,见 services/tableWidths.ts);
 *   4. 这行指令在渲染态被隐藏,源码态可见;增删列/删整表会同步维护它;
 *   5. 导出 HTML 时指令被吃掉,宽度落到 <colgroup>,不会露出注释文本。
 *
 * 跑法(在仓库根目录;无头模式不会弹窗):
 *   xvfb-run -a node verify/run.mjs table-widths
 */

import { app, dialog, protocol, type BrowserWindow } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerIpc } from '../src/main/ipc'
import { registerImarkProtocol } from '../src/main/protocol'
import { buildAppMenu } from '../src/main/menu'
import { loadSettings } from '../src/main/settings'
import { initExtensions } from '../src/main/extensions/service'
import { ensureBundledProvisioned } from '../src/main/market/bundled'
import { createMainWindow } from '../src/main/window'
import { renderHtml } from '../src/renderer/src/services/exportHtml'
import {
  fitWidths,
  formatWidthsDirective,
  parseWidthsDirectiveLine
} from '../src/renderer/src/services/tableWidths'
import { APP_VERSION } from './appVersion'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1
  else fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const TABLE = [
  '| 姓名 | 年龄 | 城市 |',
  '| :--- | ---: | :---: |',
  '| 张三 | 30 | 北京 |',
  '| 李四 | 40 | 上海 |'
].join('\n')

const DOC = `开头\n\n${TABLE}\n\n末尾\n`

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
        // 拖动结果写回源码后要能读到磁盘上的指令行
        autoSaveMode: 'afterDelay',
        autoSaveDelay: 1
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
    await sleep(1200)
    await focusEditor()
  }

  interface TableInfo {
    exists: boolean
    fixed: boolean
    widths: number[]
    grips: Array<{ x: number; y: number; w: number; h: number; cursor: string }>
    tableWidth: number
    editorWidth: number
    hiddenDirectives: number
    visibleDirectiveText: boolean
  }

  const tableInfo = (): Promise<TableInfo> =>
    evalJs(`
      (() => {
        const table = document.querySelector('.cm-content .cm-md-table-widget table')
        const content = document.querySelector('.cm-content')
        const grips = [...document.querySelectorAll('.cm-md-table-col-grip')].map(el => {
          const r = el.getBoundingClientRect()
          return {
            x: r.left + r.width / 2, y: r.top + r.height / 2,
            w: r.width, h: r.height,
            cursor: getComputedStyle(el).cursor
          }
        })
        return {
          exists: !!table,
          fixed: !!table && table.classList.contains('cm-md-table-fixed'),
          widths: table
            ? [...(table.querySelector('colgroup')?.children ?? [])]
                .map(el => parseFloat(el.style.width) || 0)
            : [],
          grips,
          tableWidth: table ? table.getBoundingClientRect().width : 0,
          editorWidth: content ? content.clientWidth : 0,
          hiddenDirectives: document.querySelectorAll('.cm-content .cm-line.cm-md-table-widths').length,
          visibleDirectiveText: (content?.innerText ?? '').includes('imark:table-widths')
        }
      })()`)

  async function dragGrip(index: number, dx: number): Promise<boolean> {
    const info = await tableInfo()
    const grip = info.grips[index]
    if (!grip) return false
    const gx = Math.round(grip.x)
    const gy = Math.round(grip.y)
    wc.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount: 1 })
    await sleep(80)
    for (let step = 1; step <= 4; step++) {
      wc.sendInputEvent({ type: 'mouseMove', x: gx + Math.round((dx * step) / 4), y: gy })
      await sleep(60)
    }
    wc.sendInputEvent({ type: 'mouseUp', x: gx + dx, y: gy, button: 'left', clickCount: 1 })
    await sleep(700)
    return true
  }

  async function dblclickGrip(index: number): Promise<boolean> {
    const info = await tableInfo()
    const grip = info.grips[index]
    if (!grip) return false
    const gx = Math.round(grip.x)
    const gy = Math.round(grip.y)
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x: gx, y: gy, button: 'left', clickCount })
      wc.sendInputEvent({ type: 'mouseUp', x: gx, y: gy, button: 'left', clickCount })
      await sleep(60)
    }
    await sleep(700)
    return true
  }

  /** 等磁盘上出现(或消失)某段文字 —— 自动保存是 1 秒一拍 */
  async function waitForFile(predicate: (text: string) => boolean, timeout = 6000): Promise<string | null> {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const text = await readFile(note, 'utf8').catch(() => '')
      if (predicate(text)) return text
      await sleep(150)
    }
    return null
  }

  async function clickControl(selector: string): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.click()
      return true
    })()`)
    await sleep(500)
    return ok
  }

  interface ActiveInfo {
    tag: string
    cls: string
    inWidget: boolean
    editingCells: number
    widgetCells: number
  }

  const activeInfo = (): Promise<ActiveInfo> =>
    evalJs(`
      (() => {
        const el = document.activeElement
        return {
          tag: el ? el.tagName : '(null)',
          cls: el ? String(el.className || '') : '',
          inWidget: !!(el && el.closest && el.closest('.cm-md-table-widget')),
          editingCells: document.querySelectorAll('.cm-md-table-cell-editing').length,
          widgetCells: document.querySelectorAll('.cm-md-table-widget th, .cm-md-table-widget td').length
        }
      })()`)

  /** 让正在编辑的格子提交(Esc 会取消;这里写内容再失焦提交) */
  async function commitActiveCell(text: string): Promise<boolean> {
    const ok = await evalJs<boolean>(`(() => {
      const el = document.activeElement
      const cell = el && el.closest ? el.closest('th,td') : null
      if (!cell || !cell.closest('.cm-md-table-widget')) return false
      cell.textContent = ${JSON.stringify(text)}
      cell.blur()
      return true
    })()`)
    if (!ok) console.log('    activeElement:', JSON.stringify(await activeInfo()))
    await sleep(500)
    return ok
  }

  const directiveWidths = (text: string, columns: number): number[] | null => {
    const match = /<!--\s*imark:table-widths[^>]*-->/.exec(text)
    if (!match) return null
    const parsed = parseWidthsDirectiveLine(match[0])
    if (!parsed) return null
    return fitWidths(parsed.widths, columns)
  }

  /** 源码里那条指令实际写了几条数值(不能只看 fitWidths:它会自动补齐缺的列) */
  const directiveValueCount = (text: string): number => {
    const match = /<!--\s*imark:table-widths\s+([^>]*?)\s*-->/.exec(text)
    if (!match) return 0
    return (match[1]?.trim().split(/[\s,]+/).filter(Boolean).length ?? 0)
  }

  // ---------- 0. 纯函数的边界情况 ----------

  console.log('\n【0】指令解析/格式化的边界情况')
  check(
    '百分比归一化:33/33/34 → 总和 100',
    Math.abs((parseWidthsDirectiveLine('<!-- imark:table-widths 33% 33% 34% -->')?.widths ?? []).reduce((a, b) => a + b, 0) - 100) < 1e-6
  )
  check(
    '像素式数值也按比例归一化',
    JSON.stringify(parseWidthsDirectiveLine('<!-- imark:table-widths 100 300 -->')?.widths.map(w => Math.round(w))) ===
      JSON.stringify([25, 75]),
    JSON.stringify(parseWidthsDirectiveLine('<!-- imark:table-widths 100 300 -->')?.widths)
  )
  check(
    '混了正文的行不算指令',
    parseWidthsDirectiveLine('正文 <!-- imark:table-widths 20% 80% -->') === null
  )
  check(
    '格式化后总和精确到 100,且能被自己解析回来',
    (() => {
      const line = formatWidthsDirective([10.04, 20.04, 69.92])
      const back = parseWidthsDirectiveLine(line)?.widths ?? []
      return back.length === 3 && Math.abs(back.reduce((a, b) => a + b, 0) - 100) < 1e-6
    })()
  )
  check(
    '条目少于列数时把剩余份额平分给缺的列',
    JSON.stringify(fitWidths([80], 2)?.map(w => Math.round(w))) === JSON.stringify([80, 20]),
    JSON.stringify(fitWidths([80], 2))
  )

  // ---------- 1. 拖动列边界 ----------

  console.log('\n【1】拖动第一条列边界:生成固定布局 + 写回指令')
  await loadDoc(DOC)
  await sleep(600)
  const before = await tableInfo()
  check('表格渲染出来了', before.exists, JSON.stringify(before))
  check('三个列边界之间有两个拖拽热区', before.grips.length === 2, String(before.grips.length))
  check(
    '热区是列宽光标、且覆盖整张表高',
    before.grips.every(g => g.cursor === 'col-resize' && g.h > 0),
    JSON.stringify(before.grips)
  )
  check('初始没有 colgroup(内容自适应)', before.widths.length === 0, JSON.stringify(before.widths))
  check('初始没有隐藏的指令行', before.hiddenDirectives === 0, String(before.hiddenDirectives))

  check('拖动第一个边界 +120px', await dragGrip(0, 120))
  await sleep(400)
  const afterDrag = await tableInfo()
  check('表格切成固定布局', afterDrag.fixed, JSON.stringify(afterDrag))
  check('出现 3 列 colgroup', afterDrag.widths.length === 3, JSON.stringify(afterDrag.widths))
  check(
    '被拖的列变宽、右侧邻列变窄',
    afterDrag.widths[0]! > 34 && afterDrag.widths[1]! < 33,
    JSON.stringify(afterDrag.widths)
  )
  check(
    '宽度总和约 100%',
    Math.abs(afterDrag.widths.reduce((a, b) => a + b, 0) - 100) < 0.3,
    JSON.stringify(afterDrag.widths)
  )
  check(
    '固定布局铺满正文宽度',
    afterDrag.tableWidth >= afterDrag.editorWidth * 0.9,
    `table=${afterDrag.tableWidth} editor=${afterDrag.editorWidth}`
  )
  check(
    '指令行在 DOM 里被隐藏(不是显示成注释文本)',
    afterDrag.hiddenDirectives === 1 && !afterDrag.visibleDirectiveText,
    JSON.stringify({
      hidden: afterDrag.hiddenDirectives,
      visible: afterDrag.visibleDirectiveText
    })
  )

  const savedAfterDrag = await waitForFile(text => text.includes('imark:table-widths'))
  check(
    '拖动结果写回磁盘源码',
    !!savedAfterDrag && directiveWidths(savedAfterDrag, 3) !== null,
    JSON.stringify(savedAfterDrag?.slice(0, 200))
  )
  const dragWidths = savedAfterDrag ? directiveWidths(savedAfterDrag, 3) : null
  check(
    '源码里的百分比与 DOM 一致',
    !!dragWidths &&
      dragWidths.length === 3 &&
      Math.abs(dragWidths[0]! - afterDrag.widths[0]!) < 1.5 &&
      dragWidths[0]! > dragWidths[1]!,
    JSON.stringify({ source: dragWidths, dom: afterDrag.widths })
  )
  check(
    '指令紧贴在表格上一行(GFM 不会把注释读成表格行)',
    !!savedAfterDrag &&
      /<!--\s*imark:table-widths[^>]*-->\n\| 姓名 \|/.test(savedAfterDrag.replace(/\r\n/g, '\n')),
    JSON.stringify(savedAfterDrag?.split('\n').slice(0, 6))
  )

  // ---------- 2. 增删列时同步维护指令 ----------

  console.log('\n【2】增删列时指令跟着改列数')
  check('点最右侧「+」插入一列', await clickControl('[data-act="add-col"][data-before="3"]'))
  check('新列第一格进入编辑态', await commitActiveCell('新列'))
  const afterAdd = await tableInfo()
  check('DOM 变成 4 列', afterAdd.widths.length === 4, JSON.stringify(afterAdd.widths))
  const savedAfterAdd = await waitForFile(text => directiveValueCount(text) === 4)
  check(
    '源码指令同步成 4 条',
    !!savedAfterAdd && directiveValueCount(savedAfterAdd) === 4,
    JSON.stringify(savedAfterAdd?.split('\n').slice(0, 4))
  )

  console.log('\n【3】删列后宽度重新归一化')
  check('删除第二列', await clickControl('[data-act="delete-col"][data-col="1"]'))
  await sleep(400)
  const afterDelete = await tableInfo()
  check('DOM 回到 3 列', afterDelete.widths.length === 3, JSON.stringify(afterDelete.widths))
  check(
    '宽度总和仍约 100%',
    Math.abs(afterDelete.widths.reduce((a, b) => a + b, 0) - 100) < 0.3,
    JSON.stringify(afterDelete.widths)
  )
  const savedAfterDelete = await waitForFile(
    text => directiveValueCount(text) === 3 && !text.includes('| 年龄 |')
  )
  check(
    '源码指令同步成 3 条',
    !!savedAfterDelete && directiveValueCount(savedAfterDelete) === 3,
    JSON.stringify(savedAfterDelete?.split('\n').slice(0, 4))
  )

  // ---------- 3. 已有指令的文档直接渲染 ----------

  console.log('\n【4】打开带指令的文档:直接按百分比渲染')
  await loadDoc(`开头\n\n<!-- imark:table-widths 20% 50% 30% -->\n${TABLE}\n\n末尾\n`)
  await sleep(600)
  const preset = await tableInfo()
  check('表格按固定布局渲染', preset.fixed, JSON.stringify(preset))
  check(
    'colgroup 百分比与指令一致',
    JSON.stringify(preset.widths.map(w => Math.round(w))) === JSON.stringify([20, 50, 30]),
    JSON.stringify(preset.widths)
  )
  check(
    '指令行被隐藏',
    preset.hiddenDirectives === 1 && !preset.visibleDirectiveText,
    JSON.stringify({ hidden: preset.hiddenDirectives, visible: preset.visibleDirectiveText })
  )

  // ---------- 4. 删除整表 ----------

  console.log('\n【5】删除整表时指令一起删掉')
  check('点删除整表', await clickControl('[data-act="delete-table"]'))
  const cleaned = await waitForFile(text => !text.includes('imark:table-widths'))
  check('磁盘上的指令行被删除', !!cleaned, JSON.stringify(cleaned?.slice(0, 160)))
  check('表格也已删除', !!cleaned && !cleaned.includes('| 姓名 |'), JSON.stringify(cleaned?.slice(0, 160)))

  // ---------- 5. 导出 ----------

  console.log('\n【6】导出 HTML:指令不露出,宽度进 colgroup')
  const exported = await renderHtml(
    `<!-- imark:table-widths 20% 50% 30% -->\n${TABLE}\n`,
    '列宽导出'
  )
  check('导出里没有注释指令文本', !exported.includes('imark:table-widths'), exported.slice(0, 200))
  check(
    '导出表格带固定布局与 colgroup',
    exported.includes('<table class="imark-table-fixed">') &&
      exported.includes('<col style="width: 20%">') &&
      exported.includes('<col style="width: 50%">'),
    exported.slice(exported.indexOf('<table'), exported.indexOf('<table') + 200)
  )

  // ---------- 6. 双击恢复内容自适应 ----------

  console.log('\n【7】双击列边界:回到内容自适应并删掉指令行')
  await loadDoc(`开头\n\n<!-- imark:table-widths 20% 50% 30% -->\n${TABLE}\n\n末尾\n`)
  await sleep(600)
  check('双击前是固定布局', (await tableInfo()).fixed)
  check('双击第一条列边界', await dblclickGrip(0))
  await sleep(400)
  const reset = await tableInfo()
  check('colgroup 被移除', reset.widths.length === 0, JSON.stringify(reset.widths))
  check('表格回到内容自适应', !reset.fixed)
  check('指令行不再被隐藏成零高度', reset.hiddenDirectives === 0, String(reset.hiddenDirectives))
  const cleared = await waitForFile(text => !text.includes('imark:table-widths'))
  check('磁盘上的指令行也被删掉', !!cleared, JSON.stringify(cleared?.slice(0, 160)))

  console.log(`\n结果:${pass} 通过,${fail} 失败`)
  app.exit(fail === 0 ? 0 : 1)
}

void main()
