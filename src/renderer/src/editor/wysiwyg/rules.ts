import { Decoration, type WidgetType } from '@codemirror/view'
import type { EditorSelection, Range, Text } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import {
  CheckboxWidget,
  CodeCopyWidget,
  HrWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  isBlankLine,
  type TableAlign,
  type TableCellSpec,
  type TableRowSpec,
  type TableSpec
} from './widgets'
import { touches, touchesLines } from './selection'
import { mathContentRange, mathSource } from '../math'
import { currentMermaidTheme } from '../../services/mermaid'
import { resolveImageSrc } from '../../utils/text'

export interface LinkInfo {
  from: number
  to: number
  url: string
}

export interface RuleContext {
  sel: EditorSelection
  doc: Text
  docDir: string | null
  visibleFrom: number
  visibleTo: number
  decos: Range<Decoration>[]
  atomic: Range<Decoration>[]
  links: LinkInfo[]
}

// ---------- 基础 emit 工具 ----------

const markCache = new Map<string, Decoration>()

function markDeco(cls: string): Decoration {
  let d = markCache.get(cls)
  if (!d) {
    d = Decoration.mark({ class: cls })
    markCache.set(cls, d)
  }
  return d
}

function addMark(ctx: RuleContext, from: number, to: number, cls: string): void {
  if (to > from) ctx.decos.push({ from, to, value: markDeco(cls) })
}

function addLine(ctx: RuleContext, pos: number, cls: string): void {
  const line = ctx.doc.lineAt(pos)
  ctx.decos.push({ from: line.from, to: line.from, value: Decoration.line({ class: cls }) })
}

/**
 * 隐藏标记字符(replace 装饰同时进入 atomicRanges,方向键整体跳过)。
 * CM 不允许扩展提供跨行 replace,跨行会直接抛 RangeError 并把视图 DOM 搞坏,
 * 所以这里兜底拦掉(少数多行语法如跨行链接的 `](url` 段只能保持源码态)。
 */
function hide(ctx: RuleContext, from: number, to: number): void {
  if (from >= to) return
  if (from < ctx.visibleFrom || to > ctx.visibleTo) return
  if (ctx.doc.lineAt(from).to < to) return
  const deco = Decoration.replace({})
  ctx.decos.push({ from, to, value: deco })
  ctx.atomic.push({ from, to, value: deco })
}

/** 用 widget 替换一段文本(checkbox / image / math / hr);同样不允许跨行 */
function hideWithWidget(ctx: RuleContext, from: number, to: number, widget: WidgetType): void {
  if (from >= to) return
  if (from < ctx.visibleFrom || to > ctx.visibleTo) return
  if (ctx.doc.lineAt(from).to < to) return
  const deco = Decoration.replace({ widget })
  ctx.decos.push({ from, to, value: deco })
  ctx.atomic.push({ from, to, value: deco })
}

// ---------- 辅助 ----------

function lineUntouched(ctx: RuleContext, pos: number): boolean {
  const line = ctx.doc.lineAt(pos)
  return !touchesLines(ctx.sel, ctx.doc, line.from, line.to)
}

/**
 * 引用是否已经敲完整。
 *
 * lezer(CommonMark)把裸 `>` 也解析成 Blockquote,但刚敲下 `>` 就立刻换成
 * 引用版式(缩进 + 竖线)太突兀;和 Obsidian 一样,等补上 `> ` 里的空格,
 * 才按引用渲染。
 *
 * 看整块而不只看第一行:回车会在 `>` 裸行后自动续出一个 `>`,用户在新行补上
 * 空格时,这一块才真正敲完整;已有的多行引用(哪怕首行是空的 `>`)也不会
 * 因为开关而整块失去样式。正常引用第一个标记就命中,遍历即刻返回。
 */
function quoteOpened(doc: Text, quote: SyntaxNode): boolean {
  const visit = (node: SyntaxNode): boolean => {
    // 只认这一层引用的标记;嵌套引用里带空格的 `>` 不能替外层作证
    if (node.name === 'QuoteMark' && nearestBlockquote(node) === quote) {
      const after = doc.sliceString(node.to, node.to + 1)
      if (after === ' ' || after === '\t') return true
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (visit(child)) return true
    }
    return false
  }
  return visit(quote)
}

/** 标记所属的引用层(最近的一层) */
function nearestBlockquote(node: SyntaxNode): SyntaxNode | null {
  for (let cur: SyntaxNode | null = node.parent; cur; cur = cur.parent) {
    if (cur.name === 'Blockquote') return cur
  }
  return null
}

/** 最外层引用节点(嵌套引用由它统一样式,见 Blockquote 规则) */
function outerBlockquote(node: SyntaxNode): SyntaxNode | null {
  let outer: SyntaxNode | null = null
  for (let cur: SyntaxNode | null = node.parent; cur; cur = cur.parent) {
    if (cur.name === 'Blockquote') outer = cur
  }
  return outer
}

/** 从 pos 起吞掉连续空格(隐藏 "# " 时必须连同后随空格,否则残留可见空隙) */
function endOfTrailingSpaces(doc: Text, from: number): number {
  let end = from
  const line = doc.lineAt(from)
  while (end < line.to && doc.sliceString(end, end + 1) === ' ') end++
  return end
}

/** 给 [node.from, node.to] 覆盖的每一行加 line 装饰(限制在视口内) */
function addLineRange(ctx: RuleContext, from: number, to: number, cls: string): void {
  const start = Math.max(from, ctx.visibleFrom)
  let pos = start
  while (pos <= to) {
    addLine(ctx, pos, cls)
    const line = ctx.doc.lineAt(pos)
    if (line.to >= ctx.doc.length || line.to >= to) break
    pos = line.to + 1
  }
}

// ---------- 表格 ----------

/** 单元格原文里的 `\|` 还原成 `|`(其余转义原样保留,交给 renderInline 处理) */
function unescapeCell(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && raw[i + 1] === '|') {
      out += '|'
      i++
    } else {
      out += raw[i]
    }
  }
  return out
}

/**
 * 按**未转义的竖线**把一行切成单元格。
 *
 * 不用语法树的 TableCell 节点,两个原因:
 *   - **空格子不产生 TableCell 节点**(lezer 对 `|     |     |` 只给出 TableDelimiter),
 *     而「+」插出来的新表整张都是空格子;
 *   - 单元格编辑需要**文档位置**,节点只覆盖 trim 过的内容,空格子的位置根本无从谈起。
 *
 * 行内代码里的裸 `|`(`` `x|y` ``)在这里也会被切开 —— 这正是 GFM 的要求
 * (连代码跨度里的竖线也必须转义),markdown-it 的拆法与此完全一致。
 */
function scanRow(doc: Text, from: number, to: number): TableCellSpec[] {
  const text = doc.sliceString(from, to)
  const pipes: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++ // 被转义的下一个字符不参与分列
    else if (text[i] === '|') pipes.push(i)
  }

  const segments: Array<{ start: number; end: number }> = []
  let start = 0
  for (const pipe of pipes) {
    segments.push({ start, end: pipe })
    start = pipe + 1
  }
  segments.push({ start, end: text.length })
  /*
   * 首尾竖线各切出一个空段 —— 那是分隔符,不是格。
   *
   * 不能用 `pipes[0] === 0` / `pipes[last] === length-1` 判:解析器的行节点会把
   * 行尾空白也包进来(`| a | b |   `),照那个判会多出一个"空白单元格",
   * 列数也会凭空 +1。这里看的是**竖线两侧的内容**是否只有空白。
   */
  if (pipes.length > 0) {
    if (text.slice(0, pipes[0]).trim() === '') segments.shift()
    if (text.slice(pipes[pipes.length - 1] + 1).trim() === '') segments.pop()
  }

  return segments.map(seg => {
    const raw = text.slice(seg.start, seg.end)
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    const cellFrom = from + seg.start + lead
    const cellTo = Math.max(cellFrom, from + seg.end - trail)
    return { text: unescapeCell(raw.trim()), from: cellFrom, to: cellTo }
  })
}

/**
 * 从语法树读出 widget 需要的一切:单元格原文、每行/每格的文档位置、对齐方式。
 *
 * 行边界取自解析器(TableHeader / TableRow),所以引用块、缩进里的表格也能正确
 * 定位 —— 行节点的 from/to 天然把 `> ` 这类容器前缀排除在外,整行重写时不会碰它们。
 */
function readTable(doc: Text, table: SyntaxNode): TableSpec | null {
  const header = table.getChild('TableHeader')
  if (!header) return null
  const headCells = scanRow(doc, header.from, header.to)

  // 对齐:只有 `Table` 的直接子节点里那个 TableDelimiter 才是整条分隔行
  // (TableHeader / TableRow 内部的 TableDelimiter 是单元格之间的竖线)
  const align: TableAlign[] = []
  const delim = table.getChild('TableDelimiter')
  if (delim) {
    // 分隔行只由 | - : 和空格组成 —— 没有转义、没有代码跨度,所以这里可以直接按 | 切
    for (const segment of doc.sliceString(delim.from, delim.to).split('|')) {
      const s = segment.trim()
      if (!s) continue
      const left = s.startsWith(':')
      const right = s.endsWith(':')
      align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
    }
  }

  /*
   * 列数取表头与分隔行的较大者。表头可能是空格子(一个 TableCell 节点都没有),
   * 但分隔行一定写全了列数,所以把两边都算上就不会把「+」插出来的空表判成没有列。
   */
  const columns = Math.max(headCells.length, align.length)
  if (columns === 0) return null
  while (headCells.length < columns) {
    headCells.push({ text: '', from: header.to, to: header.to })
  }
  while (align.length < columns) align.push(null)

  // 列数向表头看齐:缺的补空、多的丢掉 —— 与 GFM 规范、与 markdown-it 的导出一致
  const body: TableRowSpec[] = []
  for (const row of table.getChildren('TableRow')) {
    body.push({
      from: row.from,
      to: row.to,
      raw: doc.sliceString(row.from, row.to),
      cells: scanRow(doc, row.from, row.to)
    })
  }

  /*
   * 表格上下紧邻的空行是 Markdown 的结构行,渲染态下要跟表格一起藏起来
   * (见 TableSpec.protectFrom/protectTo)。只认**紧邻**的一行:再往外是
   * 用户自己写的空行,照常参与排版。
   */
  const first = doc.lineAt(table.from)
  const last = doc.lineAt(table.to)
  const above = first.number > 1 ? doc.line(first.number - 1) : null
  const below = last.number < doc.lines ? doc.line(last.number + 1) : null

  return {
    from: table.from,
    to: table.to,
    columns,
    align,
    head: {
      from: header.from,
      to: header.to,
      raw: doc.sliceString(header.from, header.to),
      cells: headCells
    },
    body,
    // 分隔行本身也要留位置:插入/删除列时得把这一行按新的列数重写,
    // 否则表头改了、分隔行还是旧列数,表格会直接散架
    delimiter: delim
      ? { from: delim.from, to: delim.to }
      : { from: header.to, to: header.to },
    protectFrom: above && isBlankLine(above.text) ? above.from : table.from,
    protectTo: below && isBlankLine(below.text) ? below.to : table.to
  }
}

// ---------- 围栏代码块 ----------

/** 围栏的 info string 里的语言名(```mermaid 或 ```mermaid title=... 都取 mermaid) */
function fenceLanguage(doc: Text, code: SyntaxNode): string {
  const info = code.getChild('CodeInfo')
  if (!info) return ''
  const first = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]
  return first ? first.toLowerCase() : ''
}

/**
 * 从语法树里取出代码正文(围栏块与缩进块通用)。
 *
 * 用 CodeText 子节点而不是首尾行号切片:引用块/列表里的围栏,行首还有 `> ` / `- `
 * 这些容器标记,节点切片的范围只覆盖真正的代码文本,拼起来天然把标记排除在外。
 * 缩进代码块同理 —— lezer 的 CodeText 已从第 5 列开始,缩进不在其中。
 */
function readCodeSource(doc: Text, code: SyntaxNode): string {
  let content = ''
  for (let child = code.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText') content += doc.sliceString(child.from, child.to)
  }
  // 顶层缩进围栏:CommonMark 要求去掉围栏本身的缩进(最多 3 空格)。lezer 的
  // CodeText 不代劳,而导出的 markdown-it 会 —— 这里的对齐是为了让编辑器与导出
  // 看到同一段源码。容器前缀(> / -)的情况 lezer 已按 basePos 处理,不再动。
  const open = code.firstChild
  if (open?.name === 'CodeMark') {
    const line = doc.lineAt(open.from)
    const prefix = doc.sliceString(line.from, open.from)
    if (prefix.length > 0 && /^ *$/.test(prefix)) {
      content = content
        .split('\n')
        .map(text => {
          let i = 0
          while (i < prefix.length && text[i] === ' ') i++
          return text.slice(i)
        })
        .join('\n')
    }
  }
  return content
}

/**
 * 代码块右上角的复制按钮。
 *
 * 挂在首行的零长度 widget 上,由 CSS 绝对定位到行尾(见 editor.css 的
 * .cm-md-code-copy)。代码正文从语法树现取,而不是点按钮时再去文档里找区间 ——
 * 装饰重建时 eq() 能据正文判断要不要复用旧 DOM,按钮状态也就不会乱跳。
 */
function addCodeCopy(ctx: RuleContext, code: SyntaxNode): void {
  // CodeText 不含闭合围栏前的那一个换行,所以这里连末尾空行都不用剥 —— 原样复制
  const source = readCodeSource(ctx.doc, code)
  const pos = ctx.doc.lineAt(code.from).from
  ctx.decos.push({
    from: pos,
    to: pos,
    value: Decoration.widget({ widget: new CodeCopyWidget(source), side: 1 })
  })
}

/** 源码态:整块等宽 + 隐藏围栏标记(渲染态与源码态共用同一套外观) */
function styleFencedCode(ctx: RuleContext, code: SyntaxNode): void {
  addLineRange(ctx, code.from, code.to, 'cm-md-code')
  addCodeCopy(ctx, code)
  const first = code.firstChild
  const last = code.lastChild
  if (first?.name === 'CodeMark' && lineUntouched(ctx, first.from)) {
    hide(ctx, first.from, endOfTrailingSpaces(ctx.doc, first.to))
  }
  const info = code.getChild('CodeInfo')
  if (info) ctx.decos.push({ from: info.from, to: info.to, value: markDeco('cm-md-codeinfo') })
  // 闭合围栏(未闭合时 last === first,跳过)
  if (last?.name === 'CodeMark' && last.from !== first?.from && lineUntouched(ctx, last.from)) {
    hide(ctx, last.from, endOfTrailingSpaces(ctx.doc, last.to))
  }
}

// ---------- 节点 → 装饰规则分发表(唯一落点) ----------

/**
 * 返回 false 表示该子树已完整处理,不再下钻。
 * 注意:节点名已对照 @lezer/markdown 1.8.0 源码核实——
 * StrongEmphasisMark / ImageMark 不存在,统一只有 EmphasisMark / LinkMark。
 */
export function applyRule(node: SyntaxNodeRef, ctx: RuleContext): boolean | void {
  switch (node.name) {
    // ----- 标题 -----
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6': {
      addLine(ctx, node.from, `cm-md-h${node.name.slice(-1)}`)
      return // 下钻:HeaderMark 与行内内容
    }
    case 'SetextHeading1':
      addLine(ctx, node.from, 'cm-md-h1')
      return
    case 'SetextHeading2':
      addLine(ctx, node.from, 'cm-md-h2')
      return
    case 'HeaderMark': {
      const parent = node.node.parent
      if (!parent) return
      if (parent.name.startsWith('ATXHeading')) {
        if (lineUntouched(ctx, node.from)) {
          hide(ctx, node.from, endOfTrailingSpaces(ctx.doc, node.to))
        }
      } else {
        // Setext 下划线:降级为变暗,不隐藏
        ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-headermark') })
      }
      return
    }

    // ----- 行内强调(内容 mark,标记字符由子节点规则隐藏) -----
    case 'Emphasis':
    case 'StrongEmphasis':
    case 'Strikethrough': {
      if (!touches(ctx.sel, node.from, node.to)) {
        const n = node.node
        const first = n.firstChild
        const last = n.lastChild
        if (first && last && last.from > first.to) {
          const cls =
            node.name === 'Emphasis'
              ? 'cm-md-em'
              : node.name === 'StrongEmphasis'
                ? 'cm-md-strong'
                : 'cm-md-strike'
          addMark(ctx, first.to, last.from, cls)
        }
      }
      return
    }
    case 'EmphasisMark':
    case 'StrikethroughMark': {
      const parent = node.node.parent
      if (parent && !touches(ctx.sel, parent.from, parent.to)) {
        hide(ctx, node.from, node.to)
      }
      return
    }

    // ----- 行内代码 -----
    case 'InlineCode': {
      const n = node.node
      const first = n.firstChild
      const last = n.lastChild
      if (!touches(ctx.sel, node.from, node.to) && first && last && last.from > first.to) {
        addMark(ctx, first.to, last.from, 'cm-md-inlinecode')
      }
      return // CodeMark 子节点单独处理
    }
    case 'CodeMark': {
      const parent = node.node.parent
      if (parent?.name === 'InlineCode' && !touches(ctx.sel, parent.from, parent.to)) {
        hide(ctx, node.from, node.to)
      }
      return
    }

    // ----- 代码块 -----
    case 'FencedCode': {
      const code = node.node
      if (fenceLanguage(ctx.doc, code) === 'mermaid') {
        const firstLine = ctx.doc.lineAt(node.from)
        const lastLine = ctx.doc.lineAt(node.to)
        /*
         * 与表格同一套跨行手法:首行换成承载整张图的 widget,其余行清空并折叠。
         * 首行必须完整落在视口里才能渲染 —— 否则 widget 根本没被画出来,而后面
         * 几行照样被清空,屏幕上就是一块空白。
         */
        const firstLineVisible = firstLine.from >= ctx.visibleFrom && firstLine.to <= ctx.visibleTo
        if (firstLineVisible && !touchesLines(ctx.sel, ctx.doc, node.from, node.to)) {
          const widget = new MermaidWidget(readCodeSource(ctx.doc, code), currentMermaidTheme())
          hideWithWidget(ctx, firstLine.from, firstLine.to, widget)
          for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
            const line = ctx.doc.line(n)
            hide(ctx, line.from, line.to)
            addLine(ctx, line.from, 'cm-md-mermaid-void')
          }
          return false
        }
        // 光标在代码块内 / 首行滚出视口:退回源码态,和普通代码块长得一样
        styleFencedCode(ctx, code)
        return false
      }
      styleFencedCode(ctx, code)
      return false
    }
    case 'CodeBlock': {
      addLineRange(ctx, node.from, node.to, 'cm-md-code')
      addCodeCopy(ctx, node.node)
      return false
    }

    // ----- 引用 -----
    case 'Blockquote': {
      // 嵌套引用由最外层一次性覆盖所有行
      if (node.node.parent?.name === 'Blockquote') return
      // 裸 `>` 先按普通文本显示(见 quoteOpened)
      if (!quoteOpened(ctx.doc, node.node)) return
      addLineRange(ctx, node.from, node.to, 'cm-md-quote')
      return
    }
    case 'QuoteMark': {
      const quote = outerBlockquote(node.node)
      // 所在的引用还没敲出 `> `:标记和正文一样,不隐藏也不变灰
      if (!quote || !quoteOpened(ctx.doc, quote)) return
      if (lineUntouched(ctx, node.from)) {
        /*
         * 连标记后的空格一起藏掉。竖线到正文的间距由引用行的 1em 左内边距保证
         * (见 setup.ts 的 editorTheme),不靠源码里的这个空格 —— 否则隐藏态
         * 的间距会变成 1em + 一个空格,和光标在行上时的观感对不上。
         */
        hide(ctx, node.from, endOfTrailingSpaces(ctx.doc, node.to))
      } else {
        // 光标在这行时标记显形(源码态);弱化成灰色,和 Obsidian 一样不抢正文
        ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-quotemark') })
      }
      return
    }

    // ----- 列表 / 任务 -----
    case 'ListMark': {
      // 无序列表(- * +)渲染成圆点;有序列表保留编号。任务项的前导标记不加点
      // (由 checkbox widget 代替),其余字符仍保留在文档中,只是视觉上换成 •。
      const text = ctx.doc.sliceString(node.from, node.to)
      const isBullet = text === '-' || text === '*' || text === '+'
      const after = ctx.doc.sliceString(node.to, Math.min(node.to + 4, ctx.doc.length))
      const isTask = /^\s?\[[ xX]\]/.test(after)
      ctx.decos.push({
        from: node.from,
        to: node.to,
        value: markDeco(isBullet && !isTask ? 'cm-md-listmark cm-md-listmark-bullet' : 'cm-md-listmark')
      })
      return
    }
    case 'TaskMarker': {
      // 无条件替换为可点击 checkbox(与选区无关)
      const text = ctx.doc.sliceString(node.from, node.to)
      const checked = text.includes('x') || text.includes('X')
      hideWithWidget(ctx, node.from, node.to, new CheckboxWidget(checked, node.from, node.to - node.from))
      return false
    }

    // ----- LaTeX 公式 -----
    case 'InlineMath': {
      const content = mathContentRange(node.node)
      if (!content) return false
      if (touches(ctx.sel, node.from, node.to)) {
        // 源码态:内容加淡底,便于看出公式边界
        ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
      } else {
        hideWithWidget(ctx, node.from, node.to, new MathWidget(mathSource(ctx.doc, node.node), false))
      }
      return false
    }
    // MathBlock 是块解析器产出的行首 $$...$$(见 editor/math.ts);
    // DisplayMath 是段落中间的行内块级公式。两者外观与编辑行为完全一致。
    case 'DisplayMath':
    case 'MathBlock': {
      const content = mathContentRange(node.node)
      if (!content) return false
      if (touches(ctx.sel, node.from, node.to)) {
        ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
        return false
      }
      const tex = mathSource(ctx.doc, node.node)
      const firstLine = ctx.doc.lineAt(node.from)
      const lastLine = ctx.doc.lineAt(node.to)
      if (firstLine.number === lastLine.number) {
        // 单行 $$...$$:直接整体替换
        hideWithWidget(ctx, node.from, node.to, new MathWidget(tex, true))
        return false
      }
      /*
       * 与表格同一条约束:widget 挂在首行上,后续行的内容会被清空。首行滚出
       * 视口时 CM 根本不会画那一行,继续清空后续行只会在屏幕上留一块空白。
       * 这种情况退回源码态(内容加底色),而不是公式 + 空白。
       */
      if (firstLine.from < ctx.visibleFrom || firstLine.to > ctx.visibleTo) {
        ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
        return false
      }
      // 多行:首行渲染公式,其余行清空内容并折叠高度
      // (扩展的装饰不能跨行 replace,故逐行处理)
      hideWithWidget(ctx, firstLine.from, firstLine.to, new MathWidget(tex, true))
      for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
        const line = ctx.doc.line(n)
        hide(ctx, line.from, line.to)
        addLine(ctx, line.from, 'cm-md-math-void')
      }
      return false
    }
    case 'MathMark': {
      const parent = node.node.parent
      if (parent && !touches(ctx.sel, parent.from, parent.to)) return // 外层已整体替换
      ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-mathmark') })
      return
    }

    // ----- 图片 -----
    case 'Image': {
      if (!touches(ctx.sel, node.from, node.to)) {
        const text = ctx.doc.sliceString(node.from, node.to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/.exec(text)
        if (m) {
          const src = resolveImageSrc(m[2], ctx.docDir)
          hideWithWidget(ctx, node.from, node.to, new ImageWidget(src, m[1]))
          return false
        }
      }
      return // 裸态编辑
    }

    // ----- 链接(双区规则) -----
    case 'Link': {
      const n = node.node
      const marks: SyntaxNode[] = []
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.name === 'LinkMark') marks.push(c)
      }
      const urlNode = n.getChild('URL')
      const tail = marks.length >= 2 ? marks[1] : null
      const open = marks[0] ?? null
      // 光标在整个节点(标签区或 URL 区)之外 → 渲染态;进入任一区域 → 显形可编辑
      if (tail && open && !touches(ctx.sel, node.from, node.to)) {
        hide(ctx, open.from, open.to)
        hide(ctx, tail.from, node.to)
        addMark(ctx, open.to, tail.from, 'cm-md-link')
        const url = urlNode ? ctx.doc.sliceString(urlNode.from, urlNode.to) : ''
        if (/^https?:\/\//i.test(url)) ctx.links.push({ from: node.from, to: node.to, url })
      } else if (urlNode) {
        ctx.decos.push({ from: urlNode.from, to: urlNode.to, value: markDeco('cm-md-url') })
      }
      return false
    }

    // ----- 水平线 -----
    case 'HorizontalRule': {
      if (lineUntouched(ctx, node.from)) {
        const line = ctx.doc.lineAt(node.from)
        hideWithWidget(ctx, node.from, line.to, new HrWidget())
      }
      return false
    }

    // ----- 表格(整块渲染成真表格,单元格就地编辑) -----
    case 'Table': {
      const spec = readTable(ctx.doc, node.node)
      const firstLine = ctx.doc.lineAt(node.from)
      /*
       * 表首行必须完整落在视口里才能渲染 —— 这不是防御性编程,是这套做法本身的约束:
       * widget 挂在首行上,而后续行的文本会被清空。首行若在视口外,CM 根本不会渲染它,
       * 那块 widget 就无从谈起,清空过的后续行却照旧是空的 —— 屏幕上是一块**空白**。
       * 表格比公式高得多,"表头滚出去了、数据行还在视野里"是很常见的状态。
       *
       * 光标在表内**不再**退回源码态:点击由 widget 自己接住(单元格就地输入),
       * 插入表格时 widget 也会把焦点放进光标所在的那一格(见 TableWidget 的 autoFocus)。
       * 只有表头滚出视口这种 widget 根本画不出来的情况才退回等宽源码。
       */
      const firstLineVisible = firstLine.from >= ctx.visibleFrom && firstLine.to <= ctx.visibleTo
      /*
       * 整张表被一个非空选区覆盖(从表格上方拖到下方、Ctrl+A、或兜底路径选中整表源码)
       * 时**不切回源码**,继续渲染成 widget,并在宿主行上打一个标记由 CSS 高亮:
       * 用户看到的是"渲染出来的表格被选中",而不是一整段 Markdown 源码。
       * 真正画不出 widget 的情况(解析失败、表头滚出视口)仍然退回源码。
       */
      const fullySelected = ctx.sel.ranges.some(
        r => !r.empty && r.from <= node.from && r.to >= node.to
      )
      if (!spec || !firstLineVisible) {
        addLineRange(ctx, node.from, node.to, 'cm-md-table')
        return false
      }
      // 首行换成 widget(它自带整张表),其余行清空并折叠高度
      // 宿主行去掉行盒 strut:否则表格上下会多出半行字体留白,看起来像多了一行
      addLine(
        ctx,
        firstLine.from,
        fullySelected ? 'cm-md-table-host cm-md-table-host-selected' : 'cm-md-table-host'
      )
      hideWithWidget(ctx, firstLine.from, firstLine.to, new TableWidget(spec))
      const lastLine = ctx.doc.lineAt(node.to)
      for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
        const line = ctx.doc.line(n)
        hide(ctx, line.from, line.to)
        addLine(ctx, line.from, 'cm-md-table-void')
      }
      /*
       * 紧邻表格的分隔空行:源码里保留(GFM 需要它把表格与正文隔开),但排版上
       * 折成零高度,视觉间距完全交给 widget 的 --md-table-gap*。
       * 光标/点击由 keepCaretOutOfTables 与 caretOutsideRenderedTable 按
       * TableSpec.protectFrom/protectTo 越过这段范围,用户不会停在看不见的行上。
       */
      if (spec.protectFrom < node.from) addLine(ctx, spec.protectFrom, 'cm-md-table-gap')
      if (spec.protectTo > node.to) addLine(ctx, spec.protectTo, 'cm-md-table-gap')
      // 不下钻:单元格里的 URL / EmphasisMark 等规则会往已被隐藏的文本上加 mark 造成错位,
      // 行内高亮由 widget 内部的 renderInline 负责
      return false
    }

    // ----- 独立 URL(autolink) -----
    case 'URL':
      ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-url') })
      return

    default:
      return
  }
}
