import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  escapeCell,
  htmlHasTable,
  inlineMarkdown,
  parseClipboardGrid,
  type TableAlign
} from './wysiwyg/widgets'

/**
 * 光标在正文里时粘贴表格数据:HTML `<table>`(iMark / Excel / 网页)或 TSV
 * → 一张 Markdown 表格。
 *
 * 表格**内部**的粘贴由 TableWidget 自己的监听处理(见 wysiwyg/widgets.ts 的
 * `wrap.addEventListener('paste', ...)`);这里只接住光标不在表格里的那种:
 * 选中整张表 Ctrl+C,点到正文别处 Ctrl+V。以前默认粘贴只写 `text/plain`,
 * 落下的是一段制表符分隔的文字 —— 渲染层不会把它当成表格。
 *
 * 快捷键不用按平台区分:Ctrl+C / Ctrl+V(macOS 的 Cmd 同理)最终都是原生
 * copy / paste 事件,这里监听的就是事件本身。
 */

interface ClipboardTable {
  /** 语义单元格文本(源码里的 `\|` 已经还原成 `|`) */
  cells: string[][]
  /** 每列对齐;剪贴板没带对齐信息时为空 */
  aligns: TableAlign[]
}

/** 单元格上的对齐信息:自己复制时写 `data-align`,Excel / 网页常见 `align` 或行内样式 */
function alignOf(el: Element): TableAlign {
  const raw = (
    el.getAttribute('data-align') ??
    el.getAttribute('align') ??
    (el instanceof HTMLElement ? el.style.textAlign : '')
  )
    .toLowerCase()
    .trim()
  return raw === 'center' || raw === 'right' || raw === 'left' ? raw : null
}

/** 剪贴板 HTML → 网格。只认第一张表,嵌套表格不参与(行只从直接子级取) */
function htmlTable(html: string): ClipboardTable | null {
  if (!htmlHasTable(html)) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const table = doc.querySelector('table')
  if (!table) return null

  const rows: Element[] = []
  const collect = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === 'TR') rows.push(child)
      else if (/^(THEAD|TBODY|TFOOT)$/.test(child.tagName)) collect(child)
    }
  }
  collect(table)
  if (rows.length === 0) return null

  const cells: string[][] = []
  const aligns: TableAlign[] = []
  for (const row of rows) {
    const line: string[] = []
    for (const cell of Array.from(row.children)) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue
      const text = inlineMarkdown(cell).replace(/\s+/g, ' ').trim()
      const col = line.length
      line.push(text)
      // 合并单元格:只占一格,后面补空格子,避免整行往左错位
      const span = Math.min(Math.max(Number(cell.getAttribute('colspan')) || 1, 1), 64)
      for (let i = 1; i < span; i++) line.push('')
      // 一列的对齐取这一列第一个带对齐信息的格子 —— 通常就是表头
      if (aligns[col] == null) aligns[col] = alignOf(cell)
    }
    if (line.length > 0) cells.push(line)
  }
  return cells.length > 0 ? { cells, aligns } : null
}

/** 纯文本 TSV → 网格(没有对齐信息) */
function tsvTable(raw: string): ClipboardTable | null {
  if (!raw.includes('\t')) return null
  const cells = parseClipboardGrid(raw)
  return cells && cells.length > 0 ? { cells, aligns: [] } : null
}

/**
 * 剪贴板 → 表格。优先 HTML:它带着对齐,单元格里的粗体/链接也能还原成 Markdown;
 * 纯文本只有在带制表符时才算表格数据(多行散文仍按普通文本粘贴)。
 */
function clipboardTable(raw: string, html: string): ClipboardTable | null {
  const table = htmlTable(html) ?? tsvTable(raw)
  if (!table) return null
  // 只有一格 = 复制了单个单元格(或者一段恰好带 tab 的文本),按普通文本贴
  const total = table.cells.reduce((n, row) => n + row.length, 0)
  return total > 1 ? table : null
}

/** 网格 → Markdown 表格源码。第一行作表头(与表格自身的模型一致) */
function toMarkdown(table: ClipboardTable): string {
  const columns = Math.max(...table.cells.map(row => row.length), 1)
  const row = (cells: string[]): string =>
    Array.from({ length: columns }, (_, c) => escapeCell(cells[c] ?? '')).join(' | ')
  const delimiter = Array.from({ length: columns }, (_, c) => {
    const align = table.aligns[c]
    return align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---'
  }).join(' | ')
  const [header, ...body] = table.cells
  return [`| ${row(header ?? [])} |`, `| ${delimiter} |`, ...body.map(cells => `| ${row(cells)} |`)].join('\n')
}

/**
 * 把一段块级 Markdown 插到光标处。
 *
 * 表格前后各要一条空行:紧贴正文时 GFM 会把它并进同一段,最后一行还会把后面的
 * 文字吞进格子。光标在行尾 / 段落中间先补换行断开这一段;上一行本来就是空行时
 * 不再补,免得凭空多出一条空行(与行首菜单插表的规则一致)。
 */
function insertBlock(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const headLine = doc.lineAt(from)
  const tailLine = doc.lineAt(to)
  const before = doc.sliceString(headLine.from, from)
  const after = doc.sliceString(to, tailLine.to)
  const prev = headLine.number > 1 ? doc.line(headLine.number - 1) : null
  const lead = before.trim() ? '\n\n' : prev && prev.text.trim() ? '\n' : ''
  const tail = after.trim() ? '\n\n' : ''
  const insert = `${lead}${text}${tail}`
  view.dispatch({
    changes: { from, to, insert },
    // 光标落在整张表之后:表格源码里不停光标(渲染态的光标护栏会把它挪出去)
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.paste'
  })
}

/** 这些块只该落普通文本:往里面插一张表会把源码结构写坏 */
const VERBATIM_BLOCKS = new Set(['Table', 'FencedCode', 'CodeBlock', 'MathBlock'])

function inVerbatimBlock(view: EditorView): boolean {
  const head = view.state.selection.main.head
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(head, -1)
  while (node) {
    if (VERBATIM_BLOCKS.has(node.name)) return true
    node = node.parent
  }
  return false
}

export function tablePaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      // 表格内部(单元格 / 整表选区)的粘贴由 TableWidget 自己处理
      if (event.defaultPrevented) return false
      const target = event.target
      if (target instanceof Element && target.closest('.cm-md-table-widget')) return false
      if (view.state.readOnly) return false
      const data = event.clipboardData
      if (!data) return false
      // 同时带图片时按图片处理(见 imagePaste.ts)
      if (Array.from(data.items ?? []).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
        return false
      }
      const table = clipboardTable(data.getData('text/plain'), data.getData('text/html'))
      // 光标在表格 / 代码块 / 公式块里时别插一张表进去:那会把源码结构写坏
      if (!table || inVerbatimBlock(view)) return false

      event.preventDefault()
      insertBlock(view, toMarkdown(table))
      return true
    }
  })
}
