import { Decoration, type WidgetType } from '@codemirror/view'
import type { EditorSelection, Range, Text } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import { CheckboxWidget, HrWidget, ImageWidget, MathWidget, TableWidget, type TableAlign } from './widgets'
import { touches, touchesLines } from './selection'
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
 * CM 不允许插件提供跨行 replace,跨行会直接抛 RangeError 并把视图 DOM 搞坏,
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

interface TableSpec {
  source: string
  head: string[]
  body: string[][]
  align: TableAlign[]
}

/** 一行里的所有单元格原文(不含两侧的 `|`) */
function readCells(doc: Text, row: SyntaxNode): string[] {
  const cells: string[] = []
  for (const cell of row.getChildren('TableCell')) cells.push(doc.sliceString(cell.from, cell.to))
  return cells
}

/**
 * 从语法树读出 widget 需要的一切。
 *
 * 单元格边界一律取自解析器,不自己按 `|` 切 —— 转义竖线 `\|` 只有解析器认得出;
 * 而行内代码里的裸 `|`(`` `x|y` ``)按 GFM 规范**本来就该拆成两格**
 * (规范要求连代码跨度里的竖线也得转义),markdown-it 的拆法与此完全一致。
 */
function readTable(doc: Text, table: SyntaxNode): TableSpec | null {
  const header = table.getChild('TableHeader')
  if (!header) return null
  const head = readCells(doc, header)

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
   * 列数取两者中的较大者,不能只看表头 —— **空格子不产生 TableCell 节点**:
   * lezer 对 `|     |     |` 只给出 TableDelimiter,一个 TableCell 都没有。
   * 而「+」菜单插出来的新表格整张都是空格子,只看 head 会把最常见的那张表
   * 判成"没有列",于是它永远渲染不出来。
   */
  const columns = Math.max(head.length, align.length)
  if (columns === 0) return null
  while (head.length < columns) head.push('')
  while (align.length < columns) align.push(null)

  // 列数向表头看齐:缺的补空、多的丢掉 —— 与 GFM 规范、与 markdown-it 的导出一致
  const body: string[][] = []
  for (const row of table.getChildren('TableRow')) {
    const cells = readCells(doc, row)
    const line: string[] = []
    for (let i = 0; i < columns; i++) line.push(cells[i] ?? '')
    body.push(line)
  }

  return { source: doc.sliceString(table.from, table.to), head, body, align }
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
      addLineRange(ctx, node.from, node.to, 'cm-md-code')
      const n = node.node
      const first = n.firstChild
      const last = n.lastChild
      if (first?.name === 'CodeMark' && lineUntouched(ctx, first.from)) {
        hide(ctx, first.from, endOfTrailingSpaces(ctx.doc, first.to))
      }
      const info = n.getChild('CodeInfo')
      if (info) ctx.decos.push({ from: info.from, to: info.to, value: markDeco('cm-md-codeinfo') })
      // 闭合围栏(未闭合时 last === first,跳过)
      if (last?.name === 'CodeMark' && last.from !== first?.from && lineUntouched(ctx, last.from)) {
        hide(ctx, last.from, endOfTrailingSpaces(ctx.doc, last.to))
      }
      return false
    }
    case 'CodeBlock': {
      addLineRange(ctx, node.from, node.to, 'cm-md-code')
      return false
    }

    // ----- 引用 -----
    case 'BlockQuote': {
      // 嵌套引用由最外层一次性覆盖所有行
      if (node.node.parent?.name === 'BlockQuote') return
      addLineRange(ctx, node.from, node.to, 'cm-md-quote')
      return
    }
    case 'QuoteMark': {
      if (lineUntouched(ctx, node.from)) {
        hide(ctx, node.from, endOfTrailingSpaces(ctx.doc, node.to))
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
      const content = node.node.getChild('MathContent')
      if (!content) return false
      if (touches(ctx.sel, node.from, node.to)) {
        // 源码态:内容加淡底,便于看出公式边界
        ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
      } else {
        const tex = ctx.doc.sliceString(content.from, content.to)
        hideWithWidget(ctx, node.from, node.to, new MathWidget(tex, false))
      }
      return false
    }
    case 'DisplayMath': {
      const content = node.node.getChild('MathContent')
      if (!content) return false
      if (touches(ctx.sel, node.from, node.to)) {
        ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
        return false
      }
      const tex = ctx.doc.sliceString(content.from, content.to)
      const firstLine = ctx.doc.lineAt(node.from)
      const lastLine = ctx.doc.lineAt(node.to)
      if (firstLine.number === lastLine.number) {
        // 单行 $$...$$:直接整体替换
        hideWithWidget(ctx, node.from, node.to, new MathWidget(tex, true))
        return false
      }
      // 多行:首行渲染公式,其余行清空内容并折叠高度
      // (插件的装饰不能跨行 replace,故逐行处理)
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

    // ----- 表格(光标在表内:等宽源码;光标在表外:整块渲染成真表格) -----
    case 'Table': {
      const spec = readTable(ctx.doc, node.node)
      const firstLine = ctx.doc.lineAt(node.from)
      /*
       * 表首行必须完整落在视口里才能渲染 —— 这不是防御性编程,是这套做法本身的约束:
       * widget 挂在首行上,而后续行的文本会被清空。首行若在视口外,CM 根本不会渲染它,
       * 那块 widget 就无从谈起,清空过的后续行却照旧是空的 —— 屏幕上是一块**空白**。
       * 表格比公式高得多,"表头滚出去了、数据行还在视野里"是很常见的状态。
       */
      const firstLineVisible = firstLine.from >= ctx.visibleFrom && firstLine.to <= ctx.visibleTo
      if (!spec || !firstLineVisible || touchesLines(ctx.sel, ctx.doc, node.from, node.to)) {
        addLineRange(ctx, node.from, node.to, 'cm-md-table')
        return false
      }
      // 首行换成 widget(它自带整张表),其余行清空并折叠高度
      hideWithWidget(ctx, firstLine.from, firstLine.to, new TableWidget(spec.source, spec.head, spec.body, spec.align))
      const lastLine = ctx.doc.lineAt(node.to)
      for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
        const line = ctx.doc.line(n)
        hide(ctx, line.from, line.to)
        addLine(ctx, line.from, 'cm-md-table-void')
      }
      // 不下钻:表格内的 URL / EmphasisMark 等规则会往已被隐藏的文本上加 mark 造成错位,
      // 而且源码态下今天也没有任何单元格内高亮,分支之间保持一致
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
