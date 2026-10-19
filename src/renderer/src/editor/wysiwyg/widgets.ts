import { WidgetType, type EditorView } from '@codemirror/view'
import { type Line, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { redo, undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import katex from 'katex'
import { renderInline } from './inline'
import { mermaidErrorMessage, renderMermaid, type MermaidTheme } from '../../services/mermaid'

/** 单元格对齐方式,取自 GFM 分隔行里的冒号;null = 文档没声明,交给 CSS */
export type TableAlign = 'left' | 'center' | 'right' | null

/** LaTeX 公式:用 KaTeX 渲染成静态 HTML。throwOnError:false 时错误公式由 KaTeX 自己标红显示 */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.displayMode === this.displayMode
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.displayMode
      ? 'cm-md-math cm-md-math-display cm-md-widget'
      : 'cm-md-math cm-md-math-inline cm-md-widget'
    try {
      katex.render(this.tex, el, {
        displayMode: this.displayMode,
        throwOnError: false,
        output: 'html',
        trust: false
      })
    } catch {
      el.textContent = this.displayMode ? `$$${this.tex}$$` : `$${this.tex}$`
      el.classList.add('cm-md-math-error')
    }
    return el
  }

  // 点击交给 CodeMirror 映射到文档位置 → 光标进入公式区间 → 自动翻回源码
  ignoreEvent(): boolean {
    return false
  }
}

/** 任务复选框:点击直接改写文档中的 [ ]/[x],undo 栈自然记录 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly len: number
  ) {
    super()
  }

  // pos 必须参与比较:若忽略 pos,文档变化后装饰虽重建但旧 DOM(携带旧 pos)被复用,点击会写错位置
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos && other.len === this.len
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-checkbox cm-md-widget'
    box.setAttribute('aria-label', '任务')
    box.addEventListener('mousedown', e => e.preventDefault())
    box.addEventListener('click', e => {
      e.preventDefault()
      view.dispatch({
        changes: { from: this.pos, to: this.pos + this.len, insert: this.checked ? '[ ]' : '[x]' }
      })
    })
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** 图片:光标在节点内时显示原始语法,节点外渲染真图。点击交给 CM(映射到节点边缘 → 触发显形) */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image cm-md-widget'
    const img = document.createElement('img')
    img.src = this.src
    if (this.alt) {
      img.alt = this.alt
      img.title = this.alt
    }
    img.addEventListener('load', () => wrap.classList.add('cm-md-image-loaded'))
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image-error')
      const label = document.createElement('span')
      label.textContent = this.alt || this.src
      wrap.appendChild(label)
    })
    wrap.appendChild(img)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ---------- 可编辑的表格 ----------

/** 单元格:语义文本(`\|` 已还原成 `|`,渲染与编辑都用它)与它在文档里的位置 */
export interface TableCellSpec {
  text: string
  from: number
  to: number
}

/** 一行表格:整行源码范围 + 各单元格。提交编辑时按**整行**重写。 */
export interface TableRowSpec {
  from: number
  to: number
  /** 这一行此刻在文档里的原文。文档在编辑期间被整个换掉时(切文件),靠它拦下误写。 */
  raw: string
  cells: TableCellSpec[]
}

export interface TableSpec {
  from: number
  to: number
  columns: number
  align: TableAlign[]
  head: TableRowSpec
  body: TableRowSpec[]
  /** 表头下面那条分隔行(插/删列时必须同步重写) */
  delimiter: { from: number; to: number }
  /**
   * 渲染态下连表格一起"圈起来"的范围:表格上下紧邻的空行也算在内。
   *
   * Markdown 用这两条空行把表格与正文隔开(表格下面尤其不能少:GFM 会把紧贴
   * 表格的非空行读成表格行),所以源码里必须留着它们。渲染态下它们被折成零高度,
   * 由 frame 的 --md-table-gap 提供视觉间距;光标和点击也一律越过这段范围,
   * 不会停在看不见的分隔行上。
   *
   * 没有相邻空行时就等于表格自身的 from/to。
   */
  protectFrom: number
  protectTo: number
}

/**
 * 结构选区:整张表 / 连续若干行 / 连续若干列。
 * 行/列选区由鼠标按住左键拖动产生(上下拖选行、左右拖选列);选中后按 Backspace / Delete 删除。
 */
type TableSelection =
  | { kind: 'table' }
  | { kind: 'row'; from: number; to: number }
  | { kind: 'col'; from: number; to: number }
  | null

/** 围绕表格的浮动控件(插行/删行/插列/删列/选整表/删整表/整表对齐) */
interface TableControls {
  selectTable: HTMLButtonElement
  deleteTable: HTMLButtonElement
  rowDeletes: HTMLButtonElement[]
  /** 下标 = 在这一**模型行**之后插入(0 是表头) */
  addRows: HTMLButtonElement[]
  colDeletes: HTMLButtonElement[]
  /** 下标 = 在第几列之前插入(columns = 最右侧) */
  addCols: HTMLButtonElement[]
  /** 整张表格的文字对齐;点开弹出 alignMenu */
  alignTable: HTMLButtonElement
  alignMenu: HTMLElement
}

/** widget DOM 与模型的对应关系;事件委托与「当前在编辑哪一格」都挂在这里 */
interface TableDomState {
  wrap: HTMLElement
  frame: HTMLElement
  table: HTMLTableElement
  layer: HTMLElement
  /** 行 → 单元格 DOM;下标 0 是表头 */
  rows: HTMLElement[][]
  /** 每格最近一次**渲染**的语义文本,用来跳过没变的格(每次事务都会重建装饰,
      不跳过的话在文档任何地方打字都会把整张表的 innerHTML 重刷一遍) */
  rendered: string[][]
  aligns: TableAlign[]
  view: EditorView
  model: TableSpec
  /** 上一轮模型的表首位置。DOM 被复用给**另一张**表时用它识别 */
  tableFrom: number
  active: { cell: HTMLElement; row: number; col: number } | null
  selection: TableSelection
  controls: TableControls | null
  layoutScheduled: boolean
  /** 上一次鼠标位置(视口坐标);结构重建后据此恢复控件的按需显隐 */
  hover: { x: number; y: number } | null
  /** 正在拖拽选行时,用来在 destroy 时解绑 window 监听 */
  cancelDrag: (() => void) | null
  /** 刚创建、autoFocus 还没跑完:这段时间不要让"光标别停进表格"的守卫抢先挪走选区 */
  autoFocusPending: boolean
}

const tableStates = new WeakMap<HTMLElement, TableDomState>()
/** 当前以渲染态呈现的表格。光标贴边按 Delete/Backspace 时要先找到它,整表选中 */
const renderedTables = new Set<TableDomState>()
/**
 * 正在编辑的表格。保存/切文件时宿主会来这里先把输入框里的文字刷回文档 ——
 * 单元格里的字在提交前只存在于 DOM 里,不刷一遍的话保存动作拿到的是旧文档。
 */
const activeTableStates = new Set<TableDomState>()

function allRows(model: TableSpec): TableRowSpec[] {
  return [model.head, ...model.body]
}

function rowOf(model: TableSpec, index: number): TableRowSpec | undefined {
  return index === 0 ? model.head : model.body[index - 1]
}

/**
 * 两份表格模型是不是同一张表(忽略绝对位置)。
 *
 * 在表格上方打字只会让整张表平移,行的源码内容一字未变;这时 DOM 可以继续用。
 * 内容不一致才可能是复用池拿来了**另一张**表的 DOM,必须拒绝。
 */
function sameTableSource(a: TableSpec, b: TableSpec): boolean {
  if (a.columns !== b.columns || a.align.length !== b.align.length) return false
  if (a.align.some((align, i) => align !== b.align[i])) return false
  const rowsA = allRows(a)
  const rowsB = allRows(b)
  if (rowsA.length !== rowsB.length) return false
  return rowsA.every((row, r) => row.raw === rowsB[r].raw)
}

/**
 * 两份表格模型是否**逐项完全一致**,包括所有绝对位置。
 *
 * 这是 widget 的 `eq` 判据:一致时 CM 会整块复用旧 tile(连 updateDOM 都不调)。
 * 只有位置也完全相同,旧 DOM 里挂的 TableDomState 才和新模型等价 —— 少比一个
 * 位置就会把旧模型留在原地,之后提交单元格会写到错误的偏移上。
 */
function sameTableModel(a: TableSpec, b: TableSpec): boolean {
  if (a.from !== b.from || a.to !== b.to) return false
  if (a.protectFrom !== b.protectFrom || a.protectTo !== b.protectTo) return false
  if (a.delimiter.from !== b.delimiter.from || a.delimiter.to !== b.delimiter.to) return false
  if (!sameTableSource(a, b)) return false
  const rowsA = allRows(a)
  const rowsB = allRows(b)
  return rowsA.every((row, r) => {
    const other = rowsB[r]
    if (row.from !== other.from || row.to !== other.to) return false
    if (row.cells.length !== other.cells.length) return false
    return row.cells.every(
      (cell, i) => cell.from === other.cells[i].from && cell.to === other.cells[i].to
    )
  })
}

/** 单元格里只允许单行:换行一律折成空格(Markdown 表格没法表示换行) */
function normalizeCellText(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ').trim()
}

/** 语义文本 → 源码。竖线必须转义,否则一格会被拆成两格 */
function escapeCell(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      // 文本本身是「反斜杠 + 竖线」:反斜杠和竖线都要转义,得到 `\\\|`
      out += '\\\\\\|'
      i++
    } else if (ch === '|') {
      out += '\\|'
    } else {
      out += ch
    }
  }
  return out
}

function serializeRow(cells: { text: string }[], columns: number): string {
  const parts: string[] = []
  for (let i = 0; i < columns; i++) parts.push(escapeCell(cells[i]?.text ?? ''))
  return `| ${parts.join(' | ')} |`
}

/** 分隔行 → 源码。对齐方式跟着列一起走,删掉一列不能把其余列的对齐弄丢 */
function serializeDelimiter(align: TableAlign[]): string {
  const cell = (a: TableAlign): string =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
  return `| ${align.map(cell).join(' | ')} |`
}

function renderCell(el: HTMLElement, text: string, align: TableAlign): void {
  el.innerHTML = renderInline(text)
  el.style.textAlign = align ?? ''
}

function caretOffsetAt(cell: HTMLElement, x: number, y: number): number | null {
  const range = document.caretRangeFromPoint(x, y)
  if (!range) return null
  const before = document.createRange()
  before.selectNodeContents(cell)
  try {
    before.setEnd(range.startContainer, range.startOffset)
  } catch {
    return null
  }
  return before.toString().length
}

function setCaret(cell: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0
    if (remaining <= len) {
      range.setStart(node, remaining)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    remaining -= len
  }
  range.selectNodeContents(cell)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** 把光标所在的文档位置映射到 (行, 列);落点在竖线或空格上时取最近的一格 */
function locateCell(model: TableSpec, pos: number): { row: number; col: number } | null {
  const rows = allRows(model)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    if (pos < row.from || pos > row.to) continue
    for (let c = 0; c < row.cells.length; c++) {
      const cell = row.cells[c]
      if (pos >= cell.from && pos <= cell.to) return { row: r, col: c }
    }
    for (let c = row.cells.length - 1; c >= 0; c--) {
      if (row.cells[c].from <= pos) return { row: r, col: c }
    }
    return { row: r, col: 0 }
  }
  return null
}

/** 结束编辑态(不写文档) */
function releaseActive(state: TableDomState): void {
  const active = state.active
  if (!active) return
  state.active = null
  activeTableStates.delete(state)
  active.cell.removeAttribute('contenteditable')
  active.cell.classList.remove('cm-md-table-cell-editing')
}

/**
 * 把当前单元格里的文字刷回文档,但**保持编辑态**。
 *
 * 保存、切换文件这类动作发生在用户还停在单元格里的时候:不刷一遍,写盘拿到的
 * 是旧文档。刷完不能收起输入框 —— 用户还得接着打字。返回是否真的改了文档。
 */
function flushActive(state: TableDomState): boolean {
  const active = state.active
  if (!active) return false
  const row = rowOf(state.model, active.row)
  const cell = row?.cells[active.col]
  const text = normalizeCellText(active.cell.innerText ?? '')
  if (!row || !cell || text === cell.text) return false
  // 编辑期间文档可能已被整个换掉(setState):位置对不上就绝不落笔
  if (state.view.state.doc.sliceString(row.from, row.to) !== row.raw) return false

  cell.text = text
  state.view.dispatch({
    changes: { from: row.from, to: row.to, insert: serializeRow(row.cells, state.model.columns) }
  })
  return true
}

function finishEdit(state: TableDomState, rerender: boolean): void {
  const active = state.active
  if (!active) return
  flushActive(state)
  releaseActive(state)
  if (!rerender) return
  // 模型在 flush 的 dispatch 里已经换过一份;仍在使用同一个 DOM 时按新模型重画
  if (state.rows[active.row]?.[active.col] !== active.cell) return
  const row = rowOf(state.model, active.row)
  paintCell(state, active.row, active.col, row?.cells[active.col]?.text ?? '')
}

function startEdit(state: TableDomState, row: number, col: number, x?: number, y?: number): void {
  if (state.active) finishEdit(state, true)
  const cell = state.rows[row]?.[col]
  const spec = rowOf(state.model, row)?.cells[col]
  if (!cell || !spec) return

  cell.textContent = spec.text
  cell.setAttribute('contenteditable', 'plaintext-only')
  cell.classList.add('cm-md-table-cell-editing')
  state.active = { cell, row, col }
  activeTableStates.add(state)
  // 直接挂在单元格上:切文件时 DOM 被移除,委托到 wrap 的监听可能已经收不到,
  // 而挂在目标上的 blur 监听一定会响。此时 stale 检查会拦下对**新**文档的误写。
  cell.addEventListener(
    'blur',
    () => {
      if (state.active?.cell === cell) finishEdit(state, true)
    },
    { once: true }
  )
  cell.focus()
  // 光标位置要在**换成源码文本之后**再按坐标算:点的是渲染后的字,落点该落在源码里
  const offset = x != null && y != null ? caretOffsetAt(cell, x, y) : null
  setCaret(cell, offset ?? spec.text.length)
}

function cancelEdit(state: TableDomState): void {
  const active = state.active
  if (!active) return
  releaseActive(state)
  const row = rowOf(state.model, active.row)
  paintCell(state, active.row, active.col, row?.cells[active.col]?.text ?? '')
}

/** 在表格最后一行下面追加一行空行(Tab/回车走到末行时),并进入第一格 */
function appendRow(state: TableDomState): void {
  insertRowAfter(state, allRows(state.model).length - 1)
}

function buildStructure(state: TableDomState): void {
  const model = state.model
  const thead = document.createElement('thead')
  const tbody = document.createElement('tbody')
  const rows: HTMLElement[][] = []
  const rendered: string[][] = []

  const buildRow = (rowSpec: TableRowSpec, tag: 'th' | 'td', rowIndex: number): HTMLTableRowElement => {
    const tr = document.createElement('tr')
    const cells: HTMLElement[] = []
    const texts: string[] = []
    for (let c = 0; c < model.columns; c++) {
      const el = document.createElement(tag)
      const text = rowSpec.cells[c]?.text ?? ''
      el.dataset.row = String(rowIndex)
      el.dataset.col = String(c)
      renderCell(el, text, model.align[c])
      tr.appendChild(el)
      cells.push(el)
      texts.push(text)
    }
    rows.push(cells)
    rendered.push(texts)
    return tr
  }

  thead.appendChild(buildRow(model.head, 'th', 0))
  model.body.forEach((row, i) => tbody.appendChild(buildRow(row, 'td', i + 1)))
  state.table.replaceChildren(thead, tbody)
  state.rows = rows
  state.rendered = rendered
  state.aligns = [...model.align]
  buildControlLayer(state)
  scheduleLayout(state)
}

function paintCell(state: TableDomState, row: number, col: number, text: string): void {
  const el = state.rows[row]?.[col]
  if (!el) return
  const align = state.model.align[col] ?? null
  renderCell(el, text, align)
  state.rendered[row][col] = text
  state.aligns[col] = align
}

function syncCells(state: TableDomState): void {
  const model = state.model
  const shapes = allRows(model)
  const sameShape =
    state.rows.length === shapes.length &&
    state.rows.every((cells, i) => cells.length === shapes[i].cells.length)
  if (!sameShape) {
    releaseActive(state)
    buildStructure(state)
    return
  }
  /*
   * 对齐是**按列**的:同一列的所有行必须看到同一个"旧对齐"才能各自判断要不要重画。
   * 若在逐格循环里立刻写回 state.aligns[c],第一行(表头)画完就把旧值覆盖了,
   * 后面的正文行会以为对齐没变而跳过 —— 整表对齐时表头变了、正文没变。
   * 所以先拿一份旧值做比较,循环结束后再整体更新。
   */
  const prevAligns = state.aligns
  for (let r = 0; r < shapes.length; r++) {
    for (let c = 0; c < shapes[r].cells.length; c++) {
      const el = state.rows[r][c]
      // 正在输入的那一格保持原样:重画会把光标和输入法组合状态一起冲掉
      if (state.active?.cell === el) continue
      const text = shapes[r].cells[c]?.text ?? ''
      const align = model.align[c] ?? null
      if (state.rendered[r]?.[c] === text && prevAligns[c] === align) continue
      renderCell(el, text, align)
      state.rendered[r][c] = text
    }
  }
  state.aligns = model.align.slice()
  applySelectionClasses(state)
  // 内容变长/变短会改行高,控件的落点要跟着重新算
  scheduleLayout(state)
}

/**
 * 表格以渲染态出现时,光标可能在它里面(刚插入、重做、打开文档)。
 *
 * 此时不能把光标留在隐藏的源码区:渲染态下那几行是不可见的,聚焦编辑器再打字
 * 会**悄悄改到看不见的地方**。所以做两件事:
 *   1. 把编辑器选区挪到表格外面(表格前的换行或表格后的下一行);
 *   2. 如果光标原来在表内,把焦点放进对应的单元格,接着输入。
 * 顺序不能反:先挪选区,再让单元格拿走焦点。
 */
function autoFocus(state: TableDomState): void {
  if (state.active) return
  state.autoFocusPending = true
  const run = (attempt = 0): void => {
    if (state.active) {
      state.autoFocusPending = false
      return
    }
    if (!state.wrap.isConnected) {
      // widget DOM 还没插进编辑器(或这一轮被重建了):稍后再试。
      // 不用 requestAnimationFrame 等首帧 —— 窗口被遮挡时它可能一直不触发。
      if (attempt < 20) setTimeout(() => run(attempt + 1), 32)
      else state.autoFocusPending = false
      return
    }
    const view = state.view
    const head = view.state.selection.main.head
    const model = state.model
    state.autoFocusPending = false
    if (head < model.protectFrom || head > model.protectTo) return
    const loc = locateCell(model, head)
    // 表格前后各有一个可用落点时优先用**前面**那个:它不依赖表格后面有没有空行
    let safe = -1
    if (model.protectFrom > 0) safe = model.protectFrom - 1
    else if (model.protectTo < view.state.doc.length) safe = model.protectTo + 1
    if (safe >= 0) view.dispatch({ selection: { anchor: safe } })
    if (loc) startEdit(state, loc.row, loc.col)
  }
  // 微任务时机:CM 已在同一个任务里把 widget DOM 插进文档,焦点能立刻落进单元格
  queueMicrotask(() => run())
}

// ---------- 表格结构控件(插/删行、列、整表) ----------

/** 让 CodeMirror 知道 widget 的高度变了(加行/删行后行高缓存不能停在旧值) */
function remeasureWidget(view: EditorView): void {
  requestAnimationFrame(() => {
    const viewState = (view as unknown as { viewState?: { mustMeasureContent?: boolean } })
      .viewState
    if (viewState) viewState.mustMeasureContent = true
    view.requestMeasure()
  })
}

/** 垃圾桶图标:内置 SVG,不依赖字体里有没有对应字形 */
function trashIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML =
    '<path d="M3 6h18"/>' +
    '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/>'
  return svg
}

/**
 * `pinned` = 常驻按钮(整表选择 / 删除 / 对齐):不参与悬停显隐,
 * 表格渲染出来就一直可见。行/列的增删控件仍由 applyHoverControls 按需浮现。
 */
function controlButton(
  act: string,
  cls: string,
  glyph: string,
  title: string,
  pinned = false
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `cm-md-table-ctl ${cls}`
  if (pinned) btn.classList.add('cm-md-table-ctl-pinned')
  btn.dataset.act = act
  btn.textContent = glyph
  btn.title = title
  btn.setAttribute('aria-label', title)
  return btn
}

/** 所有控件按钮:按下时别把焦点/选区弄丢,点击时先提交正在编辑的格子 */
function bindControl(state: TableDomState, btn: HTMLButtonElement, action: () => void): void {
  btn.addEventListener('mousedown', e => e.preventDefault())
  btn.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    if (state.active) finishEdit(state, true)
    action()
  })
}

type TableAlignValue = Exclude<TableAlign, null>

const ALIGN_OPTIONS: Array<{ align: TableAlignValue; label: string }> = [
  { align: 'left', label: '左对齐' },
  { align: 'center', label: '居中' },
  { align: 'right', label: '右对齐' }
]

function isAlignMenuOpen(state: TableDomState): boolean {
  return state.controls?.alignMenu.classList.contains('is-open') ?? false
}

/** 收起对齐菜单;返回收起之前它是否开着 */
function closeAlignMenu(state: TableDomState): boolean {
  const menu = state.controls?.alignMenu
  if (!menu?.classList.contains('is-open')) return false
  menu.classList.remove('is-open')
  return true
}

/** 打开菜单前按模型刷新勾选:只有每一列都对得齐时,才认为整张表有一个统一对齐 */
function syncAlignMenu(state: TableDomState): void {
  const menu = state.controls?.alignMenu
  if (!menu) return
  const align = state.model.align
  const shared = align.length > 0 && align.every(a => a === align[0]) ? align[0] : null
  for (const item of menu.querySelectorAll<HTMLElement>('[data-align]')) {
    const on = item.dataset.align === shared
    item.classList.toggle('is-active', on)
    item.setAttribute('aria-checked', String(on))
  }
}

/**
 * 整表对齐 = 把分隔行里**每一列**的对齐标记改成同一个值。
 *
 * GFM 的对齐是按列存在分隔行上的,没有"整张表对齐"这个语法;想统一整张表,
 * 只能逐列重写 `:---` / `:---:` / `---:`。表头和数据行读的是同一份 model.align,
 * 所以一次改动同时作用于表头与正文。已是该对齐时不派发,免得留下空的撤销步骤。
 */
function setTableAlign(state: TableDomState, align: TableAlignValue): void {
  const model = state.model
  if (model.align.length > 0 && model.align.every(a => a === align)) return
  state.view.dispatch({
    changes: {
      from: model.delimiter.from,
      to: model.delimiter.to,
      insert: serializeDelimiter(Array.from({ length: model.columns }, () => align))
    }
  })
}

function buildControlLayer(state: TableDomState): void {
  const model = state.model
  const rows = allRows(model)
  const layer = state.layer
  layer.replaceChildren()

  const selectTable = controlButton(
    'select-table',
    'cm-md-table-select',
    '▦',
    '选中整张表格（按 Delete 删除）',
    true
  )
  bindControl(state, selectTable, () => selectStructure(state, { kind: 'table' }))

  const deleteTableBtn = controlButton(
    'delete-table',
    'cm-md-table-del cm-md-table-trash',
    '',
    '删除整张表格',
    true
  )
  deleteTableBtn.replaceChildren(trashIcon())
  bindControl(state, deleteTableBtn, () => deleteTable(state))

  const rowDeletes: HTMLButtonElement[] = []
  const addRows: HTMLButtonElement[] = []

  rows.forEach((_, r) => {
    // 行选中不再用按钮:按住左键在表格里上下拖动即可选中连续行
    const del = controlButton(
      'delete-row',
      'cm-md-table-del',
      '×',
      r !== 0 ? '删除整行' : rows.length === 1 ? '删除整张表格' : '删除表头行（下一行接替表头）'
    )
    del.dataset.row = String(r)
    bindControl(state, del, () => deleteRow(state, r))
    rowDeletes.push(del)

    const add = controlButton(
      'add-row',
      'cm-md-table-add',
      '+',
      r === 0 ? '在表头下方插入行' : '在此行下方插入行'
    )
    add.dataset.after = String(r)
    bindControl(state, add, () => insertRowAfter(state, r))
    addRows.push(add)
  })

  const colDeletes: HTMLButtonElement[] = []
  for (let c = 0; c < model.columns; c++) {
    // 列选中不再用按钮:按住左键左右拖动即可选中连续列
    const del = controlButton(
      'delete-col',
      'cm-md-table-del',
      '×',
      model.columns === 1 ? '删除整张表格（仅剩一列）' : '删除整列'
    )
    del.dataset.col = String(c)
    bindControl(state, del, () => deleteColumn(state, c))
    colDeletes.push(del)
  }

  const addCols: HTMLButtonElement[] = []
  for (let b = 0; b <= model.columns; b++) {
    const add = controlButton(
      'add-col',
      'cm-md-table-add',
      '+',
      b === 0 ? '在最左侧插入列' : b === model.columns ? '在最右侧插入列' : '在此处插入列'
    )
    add.dataset.before = String(b)
    bindControl(state, add, () => insertColumnBefore(state, b))
    addCols.push(add)
  }

  /*
   * 整表对齐:按钮和「选择整表 / 删除整表」一起放在右上角,点开从按钮左侧展开菜单。
   * 对齐是整张表的属性,所以入口不挂在某一格/某一行上。
   */
  const alignTable = controlButton(
    'align-table',
    'cm-md-table-align',
    '≡',
    '选择整张表格文字的对齐方式',
    true
  )
  const alignMenu = document.createElement('div')
  alignMenu.className = 'cm-md-table-align-menu'
  alignMenu.setAttribute('role', 'menu')
  alignMenu.setAttribute('aria-label', '整张表格文字对齐')
  for (const { align, label } of ALIGN_OPTIONS) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'cm-md-table-align-option'
    item.dataset.align = align
    item.setAttribute('role', 'menuitemradio')
    item.textContent = label
    // 和控件按钮一样:按下别把焦点从 frame / 输入框上抢走
    item.addEventListener('mousedown', e => e.preventDefault())
    item.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      setTableAlign(state, align)
      closeAlignMenu(state)
    })
    alignMenu.appendChild(item)
  }
  bindControl(state, alignTable, () => {
    const menu = state.controls?.alignMenu
    if (!menu) return
    if (isAlignMenuOpen(state)) {
      closeAlignMenu(state)
      return
    }
    syncAlignMenu(state)
    menu.classList.add('is-open')
    scheduleLayout(state)
  })

  layer.append(
    selectTable,
    deleteTableBtn,
    alignTable,
    alignMenu,
    ...rowDeletes,
    ...addRows,
    ...colDeletes,
    ...addCols
  )
  state.controls = {
    selectTable,
    deleteTable: deleteTableBtn,
    rowDeletes,
    addRows,
    colDeletes,
    addCols,
    alignTable,
    alignMenu
  }
  applySelectionClasses(state)
  // 重建后按上一次鼠标位置恢复"只在生效范围内显示"的状态
  applyHoverControls(state)
}

/**
 * 行/列控件的按需显隐(整表选择 / 删除 / 对齐三枚按钮常驻,不走这里):
 *   - 鼠标在哪一行/哪一列,只显示那一行/那一列的删除 ×;
 *   - 鼠标靠近某条行/列边界线(10px 内),才显示那条线对应的插入 +。
 */
function applyHoverControls(state: TableDomState): void {
  const ctl = state.controls
  if (!ctl) return
  const hideAll = (): void => {
    for (const b of ctl.rowDeletes) b.classList.remove('is-shown')
    for (const b of ctl.addRows) b.classList.remove('is-shown')
    for (const b of ctl.colDeletes) b.classList.remove('is-shown')
    for (const b of ctl.addCols) b.classList.remove('is-shown')
  }
  const hover = state.hover
  if (!hover || !state.wrap.isConnected) {
    hideAll()
    return
  }
  const headRow = state.table.tHead?.rows[0]
  if (!headRow) {
    hideAll()
    return
  }
  const tableRect = state.table.getBoundingClientRect()
  const { x, y } = hover

  const trs = [headRow, ...Array.from(state.table.tBodies[0]?.rows ?? [])]
  const headCells = Array.from(headRow.cells)

  let hoverRow = -1
  for (let r = 0; r < trs.length; r++) {
    const rect = trs[r].getBoundingClientRect()
    if (y >= rect.top && y <= rect.bottom) {
      hoverRow = r
      break
    }
  }
  let hoverCol = -1
  for (let c = 0; c < headCells.length; c++) {
    const rect = headCells[c].getBoundingClientRect()
    if (x >= rect.left && x <= rect.right) {
      hoverCol = c
      break
    }
  }

  const EDGE = 10
  let nearRow = -1
  let bestRow = EDGE + 0.01
  for (let r = 0; r < trs.length; r++) {
    const d = Math.abs(y - trs[r].getBoundingClientRect().bottom)
    if (d < bestRow) {
      bestRow = d
      nearRow = r
    }
  }
  const boundaries = [tableRect.left, ...headCells.map(cell => cell.getBoundingClientRect().right)]
  let nearCol = -1
  let bestCol = EDGE + 0.01
  boundaries.forEach((bx, b) => {
    const d = Math.abs(x - bx)
    if (d < bestCol) {
      bestCol = d
      nearCol = b
    }
  })

  ctl.rowDeletes.forEach((b, r) => b.classList.toggle('is-shown', hoverRow === r))
  ctl.colDeletes.forEach((b, c) => b.classList.toggle('is-shown', hoverCol === c))
  ctl.addRows.forEach((b, r) => b.classList.toggle('is-shown', nearRow === r))
  ctl.addCols.forEach((b, bnd) => b.classList.toggle('is-shown', nearCol === bnd))
}

/**
 * 控件放在表格四周。顶部控件浮在表格顶边之上(负坐标),
 * 底边正好贴住表格上沿 —— 和表格之间没有空隙,鼠标移上去不会先掉出去。
 */
/** 行删除 × 在左留白居中 */
const CTL_LEFT = 12
/** 右侧留白里行插入 + 的中心 */
const CTL_RIGHT = 14
/**
 * 右上角整表按钮组:相对表格右边缘的横向偏移、组内纵向间距。
 * 横向偏移 32 是为了让开行插入 + (中心 +14,占 6..22),两组按钮不会叠在一起。
 */
const CTL_GROUP_X = 32
const CTL_GROUP_GAP = 20

function layoutControls(state: TableDomState): void {
  const { frame, table, controls } = state
  const headRow = table.tHead?.rows[0]
  if (!controls || !headRow || !table.isConnected) return
  const frameRect = frame.getBoundingClientRect()
  if (frameRect.width === 0) return
  const tableRect = table.getBoundingClientRect()
  const trs = [headRow, ...Array.from(table.tBodies[0]?.rows ?? [])]
  const place = (el: HTMLElement, x: number, y: number): void => {
    el.style.left = `${Math.round(x)}px`
    el.style.top = `${Math.round(y)}px`
  }
  const tableRight = tableRect.right - frameRect.left

  // 顶部控件底边贴住表格上沿(控件高度 16 → 中心再上移 8),不占用上下留白
  const topY = tableRect.top - frameRect.top - 8
  // 整表级三枚按钮统一放在右上角,纵向排一列:选择 → 对齐 → 删除
  const groupX = tableRight + CTL_GROUP_X
  place(controls.selectTable, groupX, topY)
  place(controls.alignTable, groupX, topY + CTL_GROUP_GAP)
  place(controls.deleteTable, groupX, topY + CTL_GROUP_GAP * 2)

  // 对齐菜单从按钮左侧展开;这里给的是菜单右上角坐标(见 .cm-md-table-align-menu)
  controls.alignMenu.style.left = `${Math.round(groupX - 10)}px`
  controls.alignMenu.style.top = `${Math.round(topY + CTL_GROUP_GAP - 10)}px`

  trs.forEach((tr, r) => {
    const rect = tr.getBoundingClientRect()
    const centerY = rect.top + rect.height / 2 - frameRect.top
    place(controls.rowDeletes[r], CTL_LEFT, centerY)
    place(controls.addRows[r], tableRight + CTL_RIGHT, rect.bottom - frameRect.top)
  })

  const headCells = Array.from(headRow.cells)
  headCells.forEach((cell, c) => {
    const rect = cell.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2 - frameRect.left
    place(controls.colDeletes[c], centerX, topY)
  })
  controls.addCols.forEach((btn, b) => {
    const x = b === 0 ? tableRect.left : headCells[b - 1]?.getBoundingClientRect().right ?? tableRect.right
    // 与列删除 × 同一带,紧贴表格上沿:列 × 不再悬得老远
    place(btn, x - frameRect.left, topY)
  })
}

/** 指针的 y 落在第几行(超出表格时夹到首/末行)—— 按住左键拖动选行用 */
function rowAtPointer(state: TableDomState, y: number): number | null {
  const head = state.table.tHead?.rows[0]
  if (!head) return null
  const trs = [head, ...Array.from(state.table.tBodies[0]?.rows ?? [])]
  for (let r = 0; r < trs.length; r++) {
    if (y <= trs[r].getBoundingClientRect().bottom) return r
  }
  return trs.length - 1
}

/** 指针的 x 落在第几列(超出表格时夹到首/末列)—— 按住左键拖动选列用 */
function colAtPointer(state: TableDomState, x: number): number | null {
  const head = state.table.tHead?.rows[0]
  if (!head) return null
  const cells = Array.from(head.cells)
  for (let c = 0; c < cells.length; c++) {
    if (x <= cells[c].getBoundingClientRect().right) return c
  }
  return cells.length - 1
}

function scheduleLayout(state: TableDomState): void {
  if (state.layoutScheduled) return
  state.layoutScheduled = true
  requestAnimationFrame(() => {
    state.layoutScheduled = false
    if (state.wrap.isConnected) layoutControls(state)
  })
}

function applySelectionClasses(state: TableDomState): void {
  const sel = state.selection
  if (sel?.kind === 'row' && (sel.from < 0 || sel.to >= state.rows.length)) state.selection = null
  if (sel?.kind === 'col' && (sel.from < 0 || sel.to >= state.model.columns)) state.selection = null
  const active = state.selection
  for (let r = 0; r < state.rows.length; r++) {
    for (let c = 0; c < state.rows[r].length; c++) {
      const on =
        !!active &&
        (active.kind === 'table' ||
          (active.kind === 'row' && r >= active.from && r <= active.to) ||
          (active.kind === 'col' && c >= active.from && c <= active.to))
      state.rows[r][c].classList.toggle('cm-md-table-selected', on)
    }
  }
  const ctl = state.controls
  if (!ctl) return
  ctl.selectTable.classList.toggle('is-active', active?.kind === 'table')
  // 整表选区才给整圈描边;选一行/一列时只高亮那一行/列,别让人误以为整张表被选中
  state.frame.classList.toggle('is-selected', active?.kind === 'table')
}

function selectStructure(state: TableDomState, sel: TableSelection): void {
  state.selection = sel
  applySelectionClasses(state)
  state.frame.focus({ preventScroll: true })
}

function clearSelection(state: TableDomState): void {
  if (!state.selection) return
  state.selection = null
  applySelectionClasses(state)
}

function containerPrefix(doc: Text, model: TableSpec): string {
  const line = doc.lineAt(model.head.from)
  return doc.sliceString(line.from, model.head.from)
}

/** 删除一整行源码(连同容器前缀与一个换行) */
function lineRemoval(doc: Text, row: TableRowSpec): { from: number; to: number } {
  const line = doc.lineAt(row.from)
  if (line.number < doc.lines) return { from: line.from, to: line.to + 1 }
  return { from: line.from > 0 ? line.from - 1 : line.from, to: line.to }
}

function sortedChanges<T extends { from: number }>(changes: T[]): T[] {
  return changes.slice().sort((a, b) => a.from - b.from)
}

function deleteTable(state: TableDomState): void {
  const view = state.view
  const doc = view.state.doc
  const first = doc.lineAt(state.model.from)
  const last = doc.lineAt(state.model.to)
  let from = first.from
  let to = last.to
  if (to < doc.length) to += 1
  else if (from > 0) from -= 1
  state.selection = null
  if (from >= to) return
  view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
  view.focus()
}

function deleteRow(state: TableDomState, index: number): void {
  deleteRows(state, [index])
}

/**
 * 删除连续/多行(拖动选中后按 Delete,或点某一行的 ×)。
 *
 * 表头是 Markdown 表格的必需行:
 *   - 选中了表头且有没被选中的数据行 → 让第一条没被选中的数据行接替表头;
 *   - 所有行都被选中(或选中表头但已经没有数据行)→ 整张表删掉。
 */
function deleteRows(state: TableDomState, indices: number[]): void {
  const model = state.model
  const doc = state.view.state.doc
  const rows = allRows(model)
  const selected = [...new Set(indices)]
    .filter(i => Number.isInteger(i) && i >= 0 && i < rows.length)
    .sort((a, b) => a - b)
  if (selected.length === 0) return
  if (selected.length === rows.length) {
    deleteTable(state)
    return
  }

  const isSelected = new Set(selected)
  const headerSelected = isSelected.has(0)
  let promote: number | null = null
  if (headerSelected) {
    promote = rows.findIndex((_, i) => i > 0 && !isSelected.has(i))
    if (promote < 0) {
      deleteTable(state)
      return
    }
  }

  state.selection = null
  const changes: Array<{ from: number; to: number; insert: string }> = []
  if (promote !== null) {
    changes.push({
      from: model.head.from,
      to: model.head.to,
      insert: serializeRow(rows[promote].cells, model.columns)
    })
  }
  for (const i of selected) {
    if (i === 0) continue
    changes.push({ ...lineRemoval(doc, rows[i]), insert: '' })
  }
  if (promote !== null) {
    // 接替表头的那一行原来那行也要删掉(内容已经搬到表头上了)
    changes.push({ ...lineRemoval(doc, rows[promote]), insert: '' })
  }
  state.view.dispatch({ changes: sortedChanges(changes) })
}

function deleteColumn(state: TableDomState, col: number): void {
  deleteColumns(state, [col])
}

/** 删除连续/多列(拖动选中后按 Delete,或点某一列的 ×) */
function deleteColumns(state: TableDomState, cols: number[]): void {
  const model = state.model
  const selected = [...new Set(cols)]
    .filter(i => Number.isInteger(i) && i >= 0 && i < model.columns)
    .sort((a, b) => a - b)
  if (selected.length === 0) return
  // 一列都不剩的表格不成立:所有列都被选中 = 删整张表
  if (selected.length === model.columns) {
    deleteTable(state)
    return
  }
  const isSelected = new Set(selected)
  const remaining = model.columns - selected.length
  const nextAlign = model.align.filter((_, i) => !isSelected.has(i))
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (const row of allRows(model)) {
    const cells: Array<{ text: string }> = []
    for (let i = 0; i < model.columns; i++) {
      if (!isSelected.has(i)) cells.push({ text: row.cells[i]?.text ?? '' })
    }
    changes.push({ from: row.from, to: row.to, insert: serializeRow(cells, remaining) })
  }
  changes.push({
    from: model.delimiter.from,
    to: model.delimiter.to,
    insert: serializeDelimiter(nextAlign)
  })
  state.selection = null
  state.view.dispatch({ changes: sortedChanges(changes) })
}

function insertRowAfter(state: TableDomState, after: number): void {
  const model = state.model
  const doc = state.view.state.doc
  const rows = allRows(model)
  if (after < 0 || after >= rows.length) return
  const empty = Array.from({ length: model.columns }, () => ({ text: '' }))
  const text = serializeRow(empty, model.columns)
  let change: { from: number; insert: string }
  if (after + 1 < rows.length) {
    const target = rows[after + 1]
    const line = doc.lineAt(target.from)
    const prefix = doc.sliceString(line.from, target.from)
    change = { from: line.from, insert: `${prefix}${text}\n` }
  } else {
    const line = doc.lineAt(model.to)
    change = { from: line.to, insert: `\n${containerPrefix(doc, model)}${text}` }
  }
  state.selection = null
  state.view.dispatch({ changes: change })
  startEdit(state, after + 1, 0)
}

function insertColumnBefore(state: TableDomState, before: number): void {
  const model = state.model
  if (before < 0 || before > model.columns) return
  const nextAlign = [...model.align.slice(0, before), null, ...model.align.slice(before)]
  const changes: Array<{ from: number; to: number; insert: string }> = []
  for (const row of allRows(model)) {
    const cells: Array<{ text: string }> = []
    for (let i = 0; i < model.columns; i++) {
      if (i === before) cells.push({ text: '' })
      cells.push({ text: row.cells[i]?.text ?? '' })
    }
    if (before === model.columns) cells.push({ text: '' })
    changes.push({ from: row.from, to: row.to, insert: serializeRow(cells, model.columns + 1) })
  }
  changes.push({
    from: model.delimiter.from,
    to: model.delimiter.to,
    insert: serializeDelimiter(nextAlign)
  })
  state.selection = null
  state.view.dispatch({ changes: sortedChanges(changes) })
  startEdit(state, 0, before)
}

function deleteSelection(state: TableDomState): void {
  const sel = state.selection
  if (!sel) return
  if (sel.kind === 'table') deleteTable(state)
  else if (sel.kind === 'row') {
    const indices: number[] = []
    for (let i = sel.from; i <= sel.to; i++) indices.push(i)
    deleteRows(state, indices)
  } else {
    const indices: number[] = []
    for (let i = sel.from; i <= sel.to; i++) indices.push(i)
    deleteColumns(state, indices)
  }
}

/**
 * GFM 表格:整块渲染成真表格,并支持**在渲染态直接编辑单元格**。
 *
 * 这个 widget 只替换**表头那一行**,其余行由 cm-md-table-void 折叠成零高度
 * (与块级公式同一套做法 —— CM 不允许插件提供跨行 replace)。
 *
 * 与 Math/Image 那些 widget 不同,这里 `ignoreEvent` 为真:点击不再交给 CodeMirror
 * 映射进源码区(那会整张表翻回 Markdown),而是自己把单元格切成 contenteditable。
 * 提交(回车/Tab/失焦)时按**整行**重写源码里的那一行 —— 单元格里的 `|` 会被转义,
 * 空单元格、缺列都由序列化统一补齐。
 */
export class TableWidget extends WidgetType {
  constructor(readonly spec: TableSpec) {
    super()
  }

  /**
   * 只有**位置和内容逐项完全一致**时才认为相等(见 sameTableModel)。
   *
   * 相等时 CM 整块复用旧 tile,连 updateDOM 都不调用 —— 因为两个模型连绝对
   * 偏移都相同,DOM 里挂的旧 TableDomState 依然正确,跳过更新不会让模型过期。
   * 只要内容或任何一个位置变了就返回 false,走 updateDOM 就地刷新。
   *
   * 不能只比内容:在表格上方打字会让整张表平移,内容没变但偏移全变了,
   * 复用旧状态会让之后的单元格提交写到错误的偏移上。
   */
  eq(other: TableWidget): boolean {
    return sameTableModel(this.spec, other.spec)
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-widget cm-md-widget'
    // 表格四周要留出放控件的位置:顺序是「上留白 → 表格 → 右留白」,左留白在 frame 的 padding 里
    const frame = document.createElement('div')
    frame.className = 'cm-md-table-frame'
    frame.tabIndex = -1
    const table = document.createElement('table')
    const layer = document.createElement('div')
    layer.className = 'cm-md-table-ctl-layer'
    frame.append(table, layer)
    wrap.appendChild(frame)

    const state: TableDomState = {
      wrap,
      frame,
      table,
      layer,
      rows: [],
      rendered: [],
      aligns: [],
      view,
      model: this.spec,
      tableFrom: this.spec.from,
      active: null,
      selection: null,
      controls: null,
      layoutScheduled: false,
      hover: null,
      cancelDrag: null,
      autoFocusPending: false
    }
    tableStates.set(wrap, state)
    renderedTables.add(state)
    bindTableEvents(state)
    buildStructure(state)
    /*
     * 表格高度会随内容/增删行变化。CM 的行高缓存按 DOM 实测,不通知它就还按旧高度
     * 算滚动与点击位置(点表格中心会把光标映射到别处)。Mermaid 那块也用了同一套。
     */
    const observer = new ResizeObserver(() => {
      scheduleLayout(state)
      remeasureWidget(view)
    })
    observer.observe(wrap)
    resizeObservers.set(wrap, observer)
    autoFocus(state)
    return wrap
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const state = tableStates.get(dom)
    if (!state) return false
    /*
     * 表首位置是这块 DOM 的**身份**。CM 的 widget 复用池是跨位置共享的:
     * 文档里有两张表时,它可能拿 B 的 DOM 来问"能不能改成 A"。位置对不上就
     * 直接拒绝(返回 false,CM 会给这张表新造 DOM)—— 否则两张表的 DOM 会互换,
     * 正在输入的那一格会被整块抽走。
     *
     * 但位置变化**不等于换了一张表**:在表格上方打字时,整张表只是往后平移,
     * 源码一字未改。以前这里一律拒绝,结果每敲一个字 CM 都要把整块表格 DOM
     * (所有行/单元格/控件)重新造一遍 —— 表格越大,打字越卡。所以位置不同时
     * 再比一次内容:完全一致就是同一张表平移了,接受它并更新位置。
     * 内容不同才可能真的是别的表,仍然拒绝。
     */
    if (state.tableFrom !== this.spec.from && !sameTableSource(state.model, this.spec)) return false
    state.tableFrom = this.spec.from
    state.view = view
    state.model = this.spec
    syncCells(state)
    return true
  }

  // 点击由单元格自己处理;返回 true 让 CodeMirror 不要把它映射成文档位置
  ignoreEvent(): boolean {
    return true
  }

  destroy(dom: HTMLElement): void {
    const state = tableStates.get(dom)
    if (!state) return
    state.cancelDrag?.()
    releaseActive(state)
    state.selection = null
    resizeObservers.get(dom)?.disconnect()
    resizeObservers.delete(dom)
    tableStates.delete(dom)
    renderedTables.delete(state)
  }
}

function bindTableEvents(state: TableDomState): void {
  const wrap = state.wrap

  // 鼠标位置决定哪个控件该出现(见 applyHoverControls)
  wrap.addEventListener('mousemove', (e: MouseEvent) => {
    state.hover = { x: e.clientX, y: e.clientY }
    applyHoverControls(state)
  })
  wrap.addEventListener('mouseleave', () => {
    state.hover = null
    closeAlignMenu(state)
    applyHoverControls(state)
  })

  wrap.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    // 点到对齐菜单/对齐按钮以外的地方 → 收起菜单(按钮自身由 click 负责开合)
    const keepAlignMenu =
      !!target?.closest('.cm-md-table-align-menu') ||
      !!target?.closest('[data-act="align-table"]')
    if (!keepAlignMenu) closeAlignMenu(state)
    // 结构控件自己处理点击;别让它触发单元格编辑,也别让焦点从表格上跑掉
    if (target?.closest('[data-act]')) {
      e.preventDefault()
      return
    }
    const cell = target?.closest<HTMLElement>('th, td')
    if (!cell || !wrap.contains(cell)) return
    if (state.active?.cell === cell) return // 已经在编辑:让浏览器自己处理选词/拖选
    const startRow = Number(cell.dataset.row)
    const startCol = Number(cell.dataset.col)
    if (!Number.isFinite(startRow) || !Number.isFinite(startCol)) return
    e.preventDefault()
    state.cancelDrag?.()

    /*
     * 单击 = 编辑这一格;上下拖动 = 选中经过的连续行,左右拖动 = 选中连续列。
     * 编辑推迟到 mouseup 才发生 —— 否则 mousedown 一进 contenteditable,
     * 拖动就变成了在格子里选字。窗口级的 mousemove/mouseup 保证拖出表格
     * (甚至拖到窗口边缘)也能继续选中。
     */
    const downX = e.clientX
    const downY = e.clientY
    let moved = false
    let axis: 'row' | 'col' | null = null
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - downX
      const dy = ev.clientY - downY
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 5) return
        moved = true
        // 第一次超过阈值时定方向:横向为主选列,纵向为主选行
        axis = Math.abs(dx) >= Math.abs(dy) ? 'col' : 'row'
      }
      if (axis === 'col') {
        const col = colAtPointer(state, ev.clientX)
        if (col === null) return
        state.selection = { kind: 'col', from: Math.min(startCol, col), to: Math.max(startCol, col) }
      } else {
        const row = rowAtPointer(state, ev.clientY)
        if (row === null) return
        state.selection = { kind: 'row', from: Math.min(startRow, row), to: Math.max(startRow, row) }
      }
      applySelectionClasses(state)
    }
    const cleanup = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('blur', cancel)
      state.cancelDrag = null
    }
    const cancel = (): void => cleanup()
    const up = (ev: MouseEvent): void => {
      cleanup()
      if (moved) {
        // 选区已经画好,把焦点交给 frame,接下来按 Delete 就能删这几行
        state.frame.focus({ preventScroll: true })
        return
      }
      clearSelection(state)
      startEdit(state, startRow, startCol, ev.clientX, ev.clientY)
    }
    state.cancelDrag = cleanup
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('blur', cancel)
  })

  wrap.addEventListener('keydown', (e: KeyboardEvent) => {
    const active = state.active
    if (active) {
      // 单元格里的按键不要再冒泡给 CodeMirror —— 否则 Backspace/Delete
      // 可能落到编辑器那个**被隐藏的**选区上,删掉看不见的源码
      e.stopPropagation()
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelEdit(state)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const row = active.row
        const col = active.col
        if (row + 1 < allRows(state.model).length) {
          finishEdit(state, true)
          startEdit(state, row + 1, col)
        } else {
          finishEdit(state, true)
          appendRow(state)
        }
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const row = active.row
        const col = active.col
        const columns = state.model.columns
        const total = allRows(state.model).length
        if (e.shiftKey) {
          if (col > 0) {
            finishEdit(state, true)
            startEdit(state, row, col - 1)
          } else if (row > 0) {
            finishEdit(state, true)
            startEdit(state, row - 1, columns - 1)
          }
          return
        }
        finishEdit(state, true)
        if (col + 1 < columns) startEdit(state, row, col + 1)
        else if (row + 1 < total) startEdit(state, row + 1, 0)
        else appendRow(state)
      }
      return
    }

    /*
     * 撤销/重做:焦点在 frame/控件上时,CM 的 keymap 不会处理(事件来自 widget,
     * ignoreEvent 为真),所以直接调 CM 的命令。删了行/列之后按 Ctrl+Z 是刚需。
     */
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'z' || key === 'y') {
        e.preventDefault()
        e.stopPropagation()
        if (key === 'z' && !e.shiftKey) undo(state.view)
        else redo(state.view)
        return
      }
    }
    /*
     * 没有正在编辑的格子:焦点可能在 frame(选中了行/列/整表)或某个控件按钮上。
     * 这些位置在 CM 的 contentDOM 里,不拦住的话字符/Backspace 会落到编辑器那个
     * **看不见的**选区上。
     */
    e.stopPropagation()
    // 菜单开着时 Esc 先只收菜单,和普通弹出菜单一致
    if (e.key === 'Escape' && closeAlignMenu(state)) {
      e.preventDefault()
      return
    }
    if (state.selection && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault()
      deleteSelection(state)
      return
    }
    if (state.selection && e.key === 'Escape') {
      e.preventDefault()
      clearSelection(state)
      state.view.focus()
      return
    }
    // 按钮不拦:Enter / Space 要能触发它的 click
    if (e.target instanceof HTMLButtonElement) return
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault()
  })

  // 焦点离开表格(点到正文/其它面板)→ 结构选区作废
  state.frame.addEventListener('focusout', e => {
    if (e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return
    clearSelection(state)
  })

  wrap.addEventListener('paste', (e: ClipboardEvent) => {
    const active = state.active
    if (!active) return
    if (!(e.target instanceof Node) || !active.cell.contains(e.target)) return
    e.preventDefault()
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ')
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !text) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  })
}

/**
 * 把还在编辑中的单元格文字刷回文档(不收起输入框)。
 * 保存、导出、切换文件前调用 —— 否则这些动作读到的是没有最后一笔的旧文档。
 */
export function flushTableEdits(): void {
  for (const state of [...activeTableStates]) flushActive(state)
}

/**
 * 光标在表格**上一行行尾**按回车:自己插入空行,光标停在上面那条。
 *
 * 表格上方紧邻的空行是 Markdown 的结构行,渲染态下折成零高度、不接受光标
 * (见 TableSpec.protectFrom)。表格上方还没有结构行时,只插一个换行的话,
 * 光标刚落到的就是这条结构行,守卫会立刻把它送出表格 —— 用户按一次回车却
 * "跳"到了别处;这时要一起插两条(可编辑行 + 结构行)。
 * 已经有结构行时,光标落点不会挨着表格,照常只插一条。
 * 引用块/缩进前缀照抄,新行仍留在同一个容器里。
 */
export function enterAboveTable(view: EditorView): boolean {
  const sel = view.state.selection
  if (!sel.main.empty) return false
  const line = view.state.doc.lineAt(sel.main.head)
  if (sel.main.head !== line.to) return false
  const nextNo = line.number + 1
  if (nextNo > view.state.doc.lines) return false
  const next = view.state.doc.line(nextNo)
  for (const state of renderedTables) {
    const model = state.model
    if (model.protectFrom < next.from || model.protectFrom > next.to) continue
    const prefix = /^[\s>]*/.exec(line.text)?.[0] ?? ''
    // 下一行本身就是表格上方的结构空行时,一条新行就够
    const insert = model.protectFrom > model.from ? `\n${prefix}` : `\n${prefix}\n${prefix}`
    const pos = sel.main.head
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + 1 + prefix.length },
      scrollIntoView: true
    })
    return true
  }
  return false
}

/** 只含空白 / `>` 的行视为空行(引用块里的空行看起来就是一根 `>`) */
export function isBlankLine(text: string): boolean {
  return /^[\s>]*$/.test(text)
}

/**
 * 表格贴着文末、下面没有正文行时,算出让光标可以停靠的补行。
 *
 * 表格下面必须空一行(GFM 否则会把新行读成表格行),所以:
 *   - 已经有一条结构空行(protectTo > to)时补一条换行即可;
 *   - 表格行就是文末时,结构空行和正文行要一起补。
 * 返回的 anchor 落在补出的**正文行**上,不会又落回结构空行。
 */
function tailLineAfterTable(
  model: TableSpec,
  docLength: number
): { anchor: number; insert: string } {
  const insert = model.protectTo > model.to ? '\n' : '\n\n'
  return { anchor: docLength + insert.length, insert }
}

/**
 * 渲染态表格的光标护栏。
 *
 * [protectFrom, protectTo] 是整张表连同上下紧邻的结构空行(见 TableSpec):
 *   - 隐藏源码行不能停光标,否则打字/删除会改到看不见的内容,表格当场散架;
 *   - 结构空行被折成零高度(见 .cm-md-table-gap),光标停上去就"消失"了,
 *     方向键也会卡住。
 * 所以这里把这段范围当成一整块,按光标来向送到另一侧真正可见的正文行。
 *
 * 表格贴着文末、下面没有可落的行时,补一个换行让光标有地方可去 ——
 * 否则用户永远走不到表格下面。
 */
export function keepCaretOutOfTables(view: EditorView, fromHead?: number): void {
  const sel = view.state.selection
  if (!sel.main.empty) return
  // 单元格正在编辑时,CM 选区只是备份:不要在表格里主动改文档
  const active = document.activeElement
  if (active instanceof Element && active.closest('.cm-md-table-widget')) return
  const head = sel.main.head
  const doc = view.state.doc
  for (const state of renderedTables) {
    // 刚插入的表格:autoFocus 正准备把焦点放进单元格,别在这里先把选区挪走
    if (state.autoFocusPending) continue
    const model = state.model
    if (head < model.protectFrom || head > model.protectTo) continue
    const before = model.protectFrom > 0 ? model.protectFrom - 1 : -1
    const after = model.protectTo < doc.length ? model.protectTo + 1 : -1
    /*
     * 往哪一侧挪,取决于光标**从哪边来**:
     *   - 从表格上方往下(方向键/回车后继续下移):送到表格后面,否则永远翻不过表格;
     *   - 从表格下方往上:送到表格前面;
     *   - 其它情况(比如落在隐藏源码中间):维持旧的向后规则。
     * 只看 head 是分不出上下的 —— 表格首行起点既可能是"从上面下来",
     * 也可能是"从下面上去"的落点。
     */
    const fromAbove = fromHead !== undefined && fromHead < model.protectFrom
    const fromBelow = fromHead !== undefined && fromHead > model.protectTo
    const forward = fromBelow ? false : fromAbove ? true : head > model.protectFrom
    if (forward && fromAbove && after < 0) {
      // 表格在文末,下面一行都没有:补出结构空行 + 正文行,光标落到正文行
      const tail = tailLineAfterTable(model, doc.length)
      view.dispatch({
        changes: { from: doc.length, insert: tail.insert },
        selection: { anchor: tail.anchor }
      })
      return
    }
    const primary = forward ? after : before
    const fallback = forward ? before : after
    const safe = primary >= 0 ? primary : fallback
    if (safe >= 0 && safe !== head) view.dispatch({ selection: { anchor: safe } })
    return
  }
}

/**
 * 硬护栏:用户输入(打字/输入法组合/粘贴)如果要落进渲染态表格的
 * [protectFrom, protectTo] 范围,直接丢弃这次文字变更,只把光标挪到表格外。
 *
 * 光标守卫已经不让光标停进去;但输入法组合(start→update→commit)有自己的
 * 时序,万一组合目标落在隐藏行上,等守卫下一次执行就晚了 —— 这里在事务层面兜底。
 * 只拦 `input` 类用户事件:表格自己的单元格提交、增删行列都是程序派发的
 * 事务(没有 userEvent),不会误伤。
 */
export function tableInputFilter(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
  // 放行:把原事务原样返回 —— 运行时按 `instanceof Transaction` 处理,类型声明里没有它
  const pass = tr as unknown as TransactionSpec
  if (!tr.docChanged || !tr.isUserEvent('input')) return pass

  let inside = false
  tr.changes.iterChangedRanges(fromA => {
    if (inside) return
    for (const state of renderedTables) {
      const model = state.model
      if (fromA >= model.protectFrom && fromA <= model.protectTo) {
        inside = true
        return
      }
    }
  })
  if (!inside) return pass

  const head = tr.startState.selection.main.head
  const docLen = tr.startState.doc.length
  let safe = -1
  for (const state of renderedTables) {
    const model = state.model
    if (head < model.protectFrom || head > model.protectTo) continue
    const before = model.protectFrom > 0 ? model.protectFrom - 1 : -1
    const after = model.protectTo < docLen ? model.protectTo + 1 : -1
    safe =
      head <= model.protectFrom ? (before >= 0 ? before : after) : after >= 0 ? after : before
    break
  }
  return safe >= 0 ? { selection: { anchor: safe } } : []
}

/**
 * 鼠标点在渲染态表格的 [protectFrom, protectTo] 区间时,返回表格外最近的落点
 * (否则 null)。insert 非空表示表格贴着文末、下方没有可落的行,
 * 调用方需要在同一笔事务里插入它,点击才能真正落到表格后面。
 *
 * 隐藏的表头行/末尾行以及上下结构空行在文档里仍然是 CM 行,按坐标点击可能
 * 把光标放进去;这里在 CM 处理 mousedown 之前把它改成表格外的正文行,
 * 所以这些行实际上点不进去。
 */
export function caretOutsideRenderedTable(
  view: EditorView,
  pos: number,
  clientY: number
): { anchor: number; insert: string } | null {
  const doc = view.state.doc
  for (const state of renderedTables) {
    const model = state.model
    if (pos < model.protectFrom || pos > model.protectTo) continue
    const before = model.protectFrom > 0 ? model.protectFrom - 1 : -1
    const after = model.protectTo < doc.length ? model.protectTo + 1 : -1
    // 点在表格可见区域上方 → 光标落到表格前;否则落到表格后
    const rect = state.table.getBoundingClientRect()
    const preferBefore = clientY <= rect.top
    if (!preferBefore) {
      if (after >= 0) return { anchor: after, insert: '' }
      return tailLineAfterTable(model, doc.length)
    }
    if (before >= 0) return { anchor: before, insert: '' }
    if (after >= 0) return { anchor: after, insert: '' }
  }
  return null
}

export function selectAdjacentTable(view: EditorView, side: 'after' | 'before'): boolean {
  const sel = view.state.selection
  if (!sel.main.empty) return false
  const doc = view.state.doc
  const line = doc.lineAt(sel.main.head)
  if (side === 'after' ? sel.main.head !== line.to : sel.main.head !== line.from) return false

  /*
   * 只认**紧贴表格的那一行**:
   *   - after(光标行行尾按 Delete):光标行的下一行就是表格受保护范围的第一行;
   *   - before(光标行行首按 Backspace):光标行的上一行就是受保护范围的最后一行。
   * 中间还隔着空行时把按键还给编辑器 —— 用户是在合并/删除那几行空行,不是想删表。
   */
  for (const state of renderedTables) {
    if (state.selection?.kind === 'table') continue
    const model = state.model
    const hit =
      side === 'after'
        ? doc.lineAt(model.protectFrom).number === line.number + 1
        : doc.lineAt(model.protectTo).number === line.number - 1
    if (!hit) continue
    selectStructure(state, { kind: 'table' })
    state.frame.focus({ preventScroll: true })
    return true
  }
  /*
   * 兜底:表格没有对应的渲染态 widget(比如它正以源码呈现、或渲染层刚重建过)。
   * 仍然不让默认删除把表格前的换行删掉 —— 直接把整张表的源码选中,
   * 第二次 Delete 就会删掉这段选区。规则表会在选区覆盖整表时渲染成源码,
   * 所以这里的选中是看得见的。
   */
  const adjacentNumber = line.number + (side === 'after' ? 1 : -1)
  if (adjacentNumber < 1 || adjacentNumber > doc.lines) return false
  const table = tableNodeIn(view.state, doc.line(adjacentNumber))
  if (table) {
    const first = doc.lineAt(table.from)
    const last = doc.lineAt(table.to)
    view.dispatch({ selection: { anchor: first.from, head: last.to }, scrollIntoView: true })
    return true
  }
  return false
}

/** 某一行里是否含有一个完整的 Table 语法节点(用于没找到渲染态 widget 时的兜底) */
function tableNodeIn(state: EditorView['state'], line: Line): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.name === 'Table') {
        found = { from: node.from, to: node.to }
        return false
      }
      return undefined
    }
  })
  return found
}

/**
 * Mermaid 图表:源码在光标移出代码块后整块渲染成 SVG。
 *
 * 渲染是异步的(而且首次还要动态 import mermaid),所以 toDOM 先给出占位框,
 * 结果回来再替换。写入前必须确认 DOM 还挂在文档上:用户可能已经滚动离开、
 * 光标也可能已经移进代码块,这块 DOM 早被 CodeMirror 丢弃 —— 往废弃节点里写
 * 只会得到一张永远看不见的 SVG。主题同理:eq() 带上 theme,切主题后旧 widget
 * 整个作废,新 widget 用新配色重渲染。
 *
 * 尺寸变化只能靠 ResizeObserver 通知 CodeMirror:一次 requestMeasure 可能赶在
 * SVG 完成布局之前。高图从 48px 占位框长到几百 px,行高缓存若没更新,鼠标点击
 * 会按旧高度把坐标映射到后面几行(点图却把光标送进文末)。observer 在尺寸真正
 * 落定后再触发一次测量,这条路径与首帧时序无关。
 */
const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>()

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly theme: MermaidTheme
  ) {
    super()
  }

  eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.theme === this.theme
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid cm-md-widget cm-md-mermaid-loading'
    const placeholder = document.createElement('span')
    placeholder.className = 'cm-md-mermaid-placeholder'
    placeholder.textContent = '正在渲染图表…'
    wrap.appendChild(placeholder)

    /*
     * 异步撑高 widget 后必须把"需要重新读取内容高度"的旗标立起来。
     *
     * 只调 requestMeasure() 不够:measure() 只有在 `contentDOMHeight != domRect.height`
     * 时才重新测量各行高度。而短文档里 `.cm-content` 的总高度被视口/40vh 内边距托住,
     * 图表从 48px 占位框长到几百 px 时总高度可能纹丝不动 —— 于是 CodeMirror 认为
     * "没有变化",行高缓存一直停在占位框的旧值(实测 113px vs 实际 284px)。
     * 后果不是视觉错位,而是鼠标点击按旧高度映射,点图表中心却把光标送到文末。
     *
     * mustMeasureContent 是 CodeMirror 自己 DOM 重绘时用的同一个开关;这里没有
     * 公开 API 可用,只能显式置位。延后一帧是避开自己正处在测量周期的情况
     * (measureScheduled === 0 时 requestMeasure 不会再排帧)。
     */
    const remeasure = (): void => {
      requestAnimationFrame(() => {
        const viewState = (view as unknown as { viewState?: { mustMeasureContent?: boolean } })
          .viewState
        if (viewState) viewState.mustMeasureContent = true
        view.requestMeasure()
      })
    }
    // 占位框 → SVG 的尺寸变化(以及 SVG 内部字体/布局引起的二次变化)都交给它
    const observer = new ResizeObserver(remeasure)
    observer.observe(wrap)
    resizeObservers.set(wrap, observer)

    const commit = (paint: (el: HTMLElement) => void): void => {
      if (!wrap.isConnected) return
      paint(wrap)
      remeasure()
    }

    void renderMermaid(this.source, this.theme).then(
      svg =>
        commit(el => {
          el.classList.remove('cm-md-mermaid-loading')
          el.classList.add('cm-md-mermaid-ready')
          el.innerHTML = svg
        }),
      err =>
        commit(el => {
          el.classList.remove('cm-md-mermaid-loading')
          el.classList.add('cm-md-mermaid-error')
          el.textContent = `Mermaid 渲染失败：${mermaidErrorMessage(err)}`
        })
    )
    return wrap
  }

  // 点击交给 CodeMirror 映射成文档位置 → 光标进入代码块 → 自动翻回源码
  ignoreEvent(): boolean {
    return false
  }

  destroy(dom: HTMLElement): void {
    resizeObservers.get(dom)?.disconnect()
    resizeObservers.delete(dom)
  }
}

/** 水平线 widget;点击由 CM 映射到行边缘,翻回原始语法可编辑 */
export class HrWidget extends WidgetType {
  eq(other: HrWidget): boolean {
    return other instanceof HrWidget
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-hr cm-md-widget'
    return span
  }

  ignoreEvent(): boolean {
    return false
  }
}
