import { Decoration, type WidgetType } from '@codemirror/view'
import type { EditorSelection, Line, Range, Text } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import {
  CheckboxWidget,
  CodeCopyWidget,
  HrWidget,
  HtmlBreakWidget,
  ImageWidget,
  MathWidget,
  MermaidWidget,
  TableWidget,
  isBlankLine,
  type TableAlign,
  type TableCellSpec,
  type TableRowSpec,
  type TableSpec,
  type TableWidthLine
} from './widgets'
import { touches, touchesLines } from './selection'
import { parseInlineTag } from '../../services/inlineHtml'
import { fitWidths, parseWidthsDirectiveLine } from '../../services/tableWidths'
import { mathContentRange, mathSource } from '../math'
import { currentMermaidTheme } from '../../services/mermaid'
import { resolveImageSrc } from '../../utils/text'
import {
  codeGroupAt,
  resolveGroupActive,
  type CodeMember,
  type CodeTabSelection
} from './codeTabs'

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
  /**
   * 刚敲出来、还没回车补全的围栏行(行首位置,见 editor/pendingFence.ts);
   * 没有则为 null。
   */
  pendingFence: number | null
  /**
   * 相邻代码块标签组各自选中的文件(见 wysiwyg/codeTabs.ts);
   * 没点过标签的组按第一块显示。
   */
  codeTabs: readonly CodeTabSelection[]
  /**
   * 回车创建、仍空着的段落行首(见 editor/emptyParagraph.ts)。
   */
  emptyParagraphs: ReadonlySet<number>
  decos: Range<Decoration>[]
  atomic: Range<Decoration>[]
  links: LinkInfo[]
  /** 已经有行装饰的行首(collapseBlankRuns 用它跳过代码行等特殊空行) */
  decorated: Set<number>
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
  ctx.decorated.add(line.from)
  ctx.decos.push({ from: line.from, to: line.from, value: Decoration.line({ class: cls }) })
}

/**
 * 源码行是不是一个 ATX 标题。
 *
 * 只看行首 `#` + 空白,不做语法树查询:能走到这里的相邻行一定在文档流里
 * (标题节点本身不可能落在 fenced code 内),不会有"代码里的 # 被误判"。
 */
function isHeadingText(text: string): boolean {
  return /^#{1,6}(?:\s|$)/.test(text)
}

/**
 * 标题紧挨着另一个标题(中间没有空行)时,给两侧打上"紧贴"类。
 *
 * 标题上下各有一档留白(见 editor.css 的 --md-heading-pad):上留白把它和
 * 上面的内容分开,下留白把它和下面的正文分开。下面直接就是下一个标题时,
 * 下留白多余 —— 下一个标题自己的上留白已经把它们隔开了;而那个上留白改用
 * 「标题之间」这一档(设置里可调),不再叠加两份。效果是标题之间比标题接
 * 正文略窄,但不会散成两段、也不会贴死。
 *
 * 中间留了空行的不算 —— 那是作者主动写下的分隔。
 */
/**
 * 标题前紧邻的空行:保留完整行高,同时算作结构分隔。
 *
 * 列表 / 代码块 / 引用后面的空行会被 addGapAfter 收成一档间距;标题前这条
 * 空行却是「回车 = 新段」补出来的分隔,视觉上要占一整行 —— 所以标
 * cm-md-h-space-before,由 CSS 把 block-gap 收紧的行高放开。
 *
 * 它同时还是排版用的结构行:方向键不该停在上面,点击也该落到正文(见
 * build.ts 的 keepCaretOutOfBlockGaps / gapLineClickAnchor)。所以两个类都
 * 要打,只留标就会被当成一条能停光标、带「+」的空行 —— 看着像新段里凭空
 * 多出来的段内换行。光标正停在这上面、或它是回车留下还没写字的空段落时
 * 例外:那是用户要编辑的落点,和 addGapBefore 一样不按结构行处理。
 */
function markHeadingSpaceBefore(ctx: RuleContext, pos: number): void {
  const line = ctx.doc.lineAt(pos)
  if (line.number <= 1) return
  const prev = ctx.doc.line(line.number - 1)
  if (!isBlankLine(prev.text)) return
  const structural =
    !caretOnGapLine(ctx, prev.from, prev.to) && !keptEmptyParagraph(ctx, prev.from)
  addLine(
    ctx,
    prev.from,
    structural
      ? 'cm-md-h-space-before cm-md-block-gap cm-md-block-gap-heading-before'
      : 'cm-md-h-space-before'
  )
}

function markHeadingEdges(ctx: RuleContext, firstPos: number, lastPos: number): void {
  const first = ctx.doc.lineAt(firstPos)
  const last = ctx.doc.lineAt(lastPos)
  if (first.number > 1 && isHeadingText(ctx.doc.line(first.number - 1).text)) {
    addLine(ctx, first.from, 'cm-md-h-tight-top')
  }
  if (last.number < ctx.doc.lines && isHeadingText(ctx.doc.line(last.number + 1).text)) {
    addLine(ctx, last.from, 'cm-md-h-tight-bottom')
  }
}

/**
 * 单横线下划线是不是被当成 Setext 标题了。
 *
 * CommonMark 里「正文下一行写 `-`」和「输入无序列表的第一个字符」是同一段
 * 文本:`阿\n-` 会被解析成 SetextHeading2。于是用户在正文正下方敲列表符号
 * 时,上面那行先被撑成二级标题(字号突变),而 `- ` 这一行本身又不是列表
 * (要等敲出内容才变回 BulletList)。
 *
 * `--` 及以上仍按标题下划线处理 —— 正常写 Setext 标题不会只写一个横线。
 */
function isLoneDashSetext(ctx: RuleContext, heading: SyntaxNode): boolean {
  const mark = heading.getChild('HeaderMark')
  return !!mark && ctx.doc.sliceString(mark.from, mark.to) === '-'
}

/**
 * 单横线后面是不是已经敲了空格。
 *
 * 和别处一致:标记 + 空格才算列表符号。只敲下 `-` 时它还是半截标记,按普通
 * 文本显示 —— 不能提前画成圆点,否则用户还没决定要列表就看到一个点。
 */
function isListDash(ctx: RuleContext, mark: SyntaxNode): boolean {
  const line = ctx.doc.lineAt(mark.from)
  return /^[ \t]+$/.test(ctx.doc.sliceString(mark.to, line.to))
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

/**
 * 引用块只给**真正带 `>` 的行**上引用样式,返回最后一个这样的行。
 *
 * CommonMark 的 lazy continuation 会把紧跟在引用后面、没写 `>` 的正文也算进
 * Blockquote:`> 引用` 下一行直接写正文,那一行在语法树里属于引用。用户只是
 * 把引用和正文之间的空行删掉,正文不该因此被套上竖线 —— 想留在引用里,每行
 * 补上 `>` 即可(在引用里回车本来就会自动续 `> `)。
 *
 * 返回的行同时是「引用下方间距」的落点:紧跟着的懒续行(现在按正文渲染)
 * 才是间距该出现的地方。
 */
function styleQuotedLines(ctx: RuleContext, quote: SyntaxNode): Line | null {
  const lines = new Map<number, Line>()
  const visit = (node: SyntaxNode): void => {
    if (node.name === 'QuoteMark' && nearestBlockquote(node) === quote) {
      const line = ctx.doc.lineAt(node.from)
      lines.set(line.number, line)
      return
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(quote)
  let last: Line | null = null
  for (const line of [...lines.values()].sort((a, b) => a.number - b.number)) {
    addLine(ctx, line.from, 'cm-md-quote')
    last = line
  }
  return last
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

/**
 * 块与正文之间的间距。两种写法都要照顾:
 *
 *   · 中间留了空行(常见于标准 Markdown):把那条空行加高(见 CSS 的
 *     .cm-md-block-gap),其它行不动;
 *   · 中间没有空行(本仓库的笔记就是这么写的):空行不存在,只能把间距做在
 *     **相邻正文行**的 padding 上(padClass,见 CSS 的 .cm-md-gap-*),
 *     不动块本身,也不动其它行的行距。
 *
 * 两个类名都按「块类型 + 方向」区分(见 CSS 的 --md-code-gap-* /
 * --md-list-gap-*):同一条空行可能同时夹在代码块和列表之间,各算各的。
 */
function addGapBefore(ctx: RuleContext, pos: number, padClass: string, blankClass: string): void {
  const line = ctx.doc.lineAt(pos)
  if (line.number <= 1) return
  const prev = ctx.doc.line(line.number - 1)
  if (
    !isBlankLine(prev.text) ||
    caretOnGapLine(ctx, prev.from, prev.to) ||
    keptEmptyParagraph(ctx, prev.from)
  )
    addLine(ctx, prev.from, padClass)
  else addLine(ctx, prev.from, `cm-md-block-gap ${blankClass}`)
}

function addGapAfter(ctx: RuleContext, pos: number, padClass: string, blankClass: string): void {
  const line = ctx.doc.lineAt(pos)
  if (line.number >= ctx.doc.lines) return
  const next = ctx.doc.line(line.number + 1)
  if (
    !isBlankLine(next.text) ||
    caretOnGapLine(ctx, next.from, next.to) ||
    keptEmptyParagraph(ctx, next.from)
  )
    addLine(ctx, next.from, padClass)
  else addLine(ctx, next.from, `cm-md-block-gap ${blankClass}`)
}

/**
 * 光标是不是就停在这一条结构空行上(只看空选区,拖选时不动版式)。
 *
 * 空行收紧后只有不到一行的行高,而光标矩形是围着行盒算的 —— 光标会贴在
 * 上一块的下沿;等真开始输入,这一行变成正文行、间距改走 padding,字才落到
 * 预期位置,于是出现"光标不在打字处,输入后跳一下"。
 *
 * 光标一落上空行,就按正文行的排法渲染它(padding 由调用方照常打上):光标
 * 和随后输入的第一个字从一开始就在同一处,继续输入也不会再移动。
 */
function caretOnGapLine(ctx: RuleContext, from: number, to: number): boolean {
  return ctx.sel.ranges.some(r => r.empty && r.head >= from && r.head <= to)
}

/**
 * 这条空行是不是「回车创建、仍空着的段落」(见 editor/emptyParagraph.ts)。
 *
 * 它和光标停在上面的空行按同一种排法处理:保持整行高,不收紧成块间距 ——
 * 否则光标一点开,第二段就缩成一道缝,再也点不回去。
 */
function keptEmptyParagraph(ctx: RuleContext, from: number): boolean {
  return ctx.emptyParagraphs.has(from)
}

/**
 * 两段正文之间那条结构空行的留白。
 *
 * CommonMark 里段落之间必须隔一个空行;这条空行本来按正文行高排,间距固定。
 * 现在收进「段间距」这一档(设置「外观 → 样式」可调),和块间距同一套
 * 排法:空行只留一档高,光标落上去时再按正文行撑开(见 addGapBefore)。
 * 没有空行的两行在 CommonMark 里是同一段,距离归「行间距」管 —— 不归这里。
 *
 * 只处理「两段正文」之间的空行:上一段是普通段落,或者是排版上已经按正文
 * 处理的列表结尾(见 listEndsWithLazyText)。段落挨着标题 / 代码块 / 引用时,
 * 那是那些块的间距在管,不要叠一份。
 *
 * 连排两条以上的空行由 collapseBlankRuns 统一收紧。
 */
function styleBodyGap(ctx: RuleContext, para: SyntaxNode): void {
  if (para.parent?.name !== 'Document') return
  const prev = para.prevSibling
  if (!prev) return
  if (prev.name !== 'Paragraph' && !listEndsWithLazyText(ctx, prev)) return
  const line = ctx.doc.lineAt(para.from)
  if (line.number <= 1 || !isBlankLine(ctx.doc.line(line.number - 1).text)) return
  addGapBefore(ctx, para.from, 'cm-md-gap-body', 'cm-md-block-gap-body')
}

/**
 * 连排的空行只留光标所在的那一条整行,其余按段间距收紧。
 *
 * CommonMark 里多出来的空行只是分隔,不是排版内容;而「回车 = 新段」恰好会
 * 补出连排空行 —— 新段先占一条空段落,上下各有一条分隔。不收的话,按一次
 * 回车屏幕上就连出两三行空白;收完正好是「一条空行 + 段间距」。
 *
 * 光标所在的那条不收(得能看见光标、接着打字);已经有行装饰的空行也不动
 * (代码块里的空行是代码内容,块间距行已经有自己的高度)。
 */
export function collapseBlankRuns(ctx: RuleContext, skip?: (from: number, to: number) => boolean): void {
  const first = ctx.doc.lineAt(ctx.visibleFrom).number
  const last = ctx.doc.lineAt(ctx.visibleTo).number
  for (let number = first; number <= last; number++) {
    const line = ctx.doc.line(number)
    if (!isBlankLine(line.text)) continue
    // 只有挨着另一条空行时才算「连排」;单独一条空行是正常的分隔,保持整行
    const prevBlank = number > 1 && isBlankLine(ctx.doc.line(number - 1).text)
    const nextBlank = number < ctx.doc.lines && isBlankLine(ctx.doc.line(number + 1).text)
    if (!prevBlank && !nextBlank) continue
    // 文末空行是新段的落点:重新打开文件后「回车建出的空段落」记录会丢,
    // 但它后面没有内容可分隔,只能是留给用户接着写的一行,得按整行留出来。
    if (number === ctx.doc.lines) continue
    if (ctx.decorated.has(line.from)) continue
    if (skip && skip(line.from, line.to)) continue
    if (caretOnGapLine(ctx, line.from, line.to)) continue
    // 光标刚离开的空段落仍是可点击的一行,不能收成间距
    if (keptEmptyParagraph(ctx, line.from)) continue
    addLine(ctx, line.from, 'cm-md-block-gap cm-md-block-gap-body')
  }
}

/**
 * 列表节点是不是「列表标记之后还跟着没有列表点的正文」。
 *
 * 用户按两次回车去掉列表点,就是想跳出列表;CommonMark 仍然把紧接着的
 * 无标记行算成最后一项的懒续行(见上面 List 分支的说明)。这些行在界面上
 * 按正文排,所以它们下面的空行也该按「两段正文之间」的空行处理 —— 否则
 * 空行两头都不是 Paragraph,谁都不压它,就会留成一整行(间距凭空变高)。
 *
 * 只认列表标记后面确实还有内容的列表;标记所在行就是列表最后一行时返回
 * false,那种情况归列表自己的 after 间距管。
 */
function listEndsWithLazyText(ctx: RuleContext, list: SyntaxNode): boolean {
  if (list.name !== 'BulletList' && list.name !== 'OrderedList') return false
  const mark = lastListMark(list)
  if (!mark) return false
  if (ctx.doc.lineAt(list.to).number <= ctx.doc.lineAt(mark.from).number) return false
  // 最后那一行还必须属于正文段落:代码块 / 嵌套列表 / 表格收尾的列表,
  // 它们下面的空行归各自的块间距管,不要再叠一份段间距。
  for (let cur: SyntaxNode | null = list.resolve(list.to - 1, -1); cur; cur = cur.parent) {
    if (cur.name === 'Paragraph') return true
    if (cur.name === list.name) return false
  }
  return false
}

/** 这一行是否以硬换行结束(Markdown 的硬换行 = 行尾两个以上空格,或反斜杠) */
function endsWithHardBreak(line: Line): boolean {
  return /(?: {2,}|\\)$/.test(line.text)
}

/**
 * 行尾的单个反斜杠是硬换行标记:**始终**藏起来。
 *
 * 它只决定两行属于同一段,不是正文内容;光标移到这一行时也不应该露出来
 * (删硬换行用续行行首退格或行尾退格)。双反斜杠是转义的字面反斜杠,
 * 文末没有下一行时也保持原样。
 */
function hideTrailingBackslashLine(ctx: RuleContext, line: Line): void {
  if (!/\\$/.test(line.text) || /\\{2}$/.test(line.text)) return
  if (line.number >= ctx.doc.lines) return
  hide(ctx, line.to - 1, line.to)
}

/**
 * 段落最后一行行尾的单个反斜杠,在下一行还是空行时不会生成 HardBreak 节点
 * (段落到反斜杠就结束)。但它就是 Shift+回车刚写下的硬换行标记:光标不在
 * 这一行时也藏起来,免得刚按完 Shift+回车就看到一个反斜杠。
 */
function hideTrailingBackslash(ctx: RuleContext, para: SyntaxNode): void {
  const last = ctx.doc.lineAt(para.to)
  if (last.to !== para.to) return
  hideTrailingBackslashLine(ctx, last)
}

/** 列表子树里最后一个列表标记:列表在视觉上的结尾(续行、嵌套列表都排在它后面) */
function lastListMark(list: SyntaxNode): SyntaxNode | null {
  let found: SyntaxNode | null = null
  const visit = (n: SyntaxNode): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === 'ListMark') found = c
      visit(c)
    }
  }
  visit(list)
  return found
}

/**
 * 列表标记是否已经敲完整(标记后面跟着空格或 Tab)。
 *
 * CommonMark 把行尾的 `-` / `1.` 也解析成空的列表项,所以只敲下标记时
 * ListMark 节点就已经存在。列表标记要等空格敲出来才渲染:输入短横线时
 * 它还是正文,补上空格才变成圆点;有序列表同理(`1.` → `1. `)。
 */
function markerComplete(ctx: RuleContext, mark: SyntaxNode | null): boolean {
  if (!mark) return true
  const next = ctx.doc.sliceString(mark.to, Math.min(mark.to + 1, ctx.doc.length))
  return next === ' ' || next === '\t'
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
/**
 * 表格正上方那行是不是列宽指令。
 *
 * 只认**紧邻**的一行:指令是 iMark 自己写的,不会和表格之间隔空行。返回整行范围
 * (改写/删除用)与指令文本范围(渲染态只隐藏指令本身,保留 `> ` 这类容器前缀)。
 */
function readWidthLine(line: Line): { line: TableWidthLine; widths: number[] } | null {
  const parsed = parseWidthsDirectiveLine(line.text)
  if (!parsed) return null
  return {
    line: {
      from: line.from,
      to: line.to,
      textFrom: line.from + parsed.from,
      textTo: line.from + parsed.to,
      prefix: line.text.slice(0, parsed.from)
    },
    widths: parsed.widths
  }
}

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
   *
   * 有列宽指令时,指令行插在表格与结构空行之间:两者都算进保护范围,
   * 光标/点击不会停在这两行看不见的源码上。
   */
  const first = doc.lineAt(table.from)
  const last = doc.lineAt(table.to)
  const widthInfo = first.number > 1 ? readWidthLine(doc.line(first.number - 1)) : null
  const aboveNumber = widthInfo ? first.number - 2 : first.number - 1
  const above = aboveNumber >= 1 ? doc.line(aboveNumber) : null
  const below = last.number < doc.lines ? doc.line(last.number + 1) : null
  const widthLine = widthInfo?.line ?? null

  return {
    from: table.from,
    to: table.to,
    columns,
    align,
    widths: widthInfo ? fitWidths(widthInfo.widths, columns) : null,
    widthLine,
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
    protectFrom:
      above && isBlankLine(above.text)
        ? above.from
        : (widthLine?.from ?? table.from),
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
function addCodeCopy(ctx: RuleContext, code: SyntaxNode, at?: number): void {
  // CodeText 不含闭合围栏前的那一个换行,所以这里连末尾空行都不用剥 —— 原样复制
  const source = readCodeSource(ctx.doc, code)
  const pos = at ?? ctx.doc.lineAt(code.from).from
  ctx.decos.push({
    from: pos,
    to: pos,
    value: Decoration.widget({ widget: new CodeCopyWidget(source), side: 1 })
  })
}

/**
 * 选区是不是从代码块**上方**起(全篇全选、从段落一路拖进来)。
 *
 * 见 editor.css 的 .cm-md-code::before:那块盖在选区图层之上的实色底,本来
 * 是为了把「起点在块内时,除首行外每行多染出来的那截左侧留白」盖回去。
 * 但选区起点在块之前时,drawSelection 对**所有**代码行都按整行画,留白再盖
 * 回去就成了代码块左边被挖掉一条 —— 全篇全选时最显眼。
 *
 * 空选区不算:光标恰好停在块上方时没有染色,不需要放开。
 */
function selectionStartsBefore(ctx: RuleContext, blockStart: number): boolean {
  return ctx.sel.ranges.some(r => !r.empty && r.from < blockStart)
}

/** 代码行要挂的类:起点在块之前时多挂一个「留白跟着染色」的类 */
function codeLineClass(ctx: RuleContext, blockStart: number): string {
  return selectionStartsBefore(ctx, blockStart)
    ? 'cm-md-code cm-md-code-sel-bleed'
    : 'cm-md-code'
}

/** 源码态:整块等宽 + 隐藏围栏标记(渲染态与源码态共用同一套外观) */
function styleFencedCode(ctx: RuleContext, code: SyntaxNode): void {
  addLineRange(ctx, code.from, code.to, codeLineClass(ctx, code.from))
  addCodeCopy(ctx, code)
  addGapBefore(ctx, code.from, 'cm-md-gap-code-before', 'cm-md-block-gap-code-before')
  addGapAfter(ctx, code.to, 'cm-md-gap-code-after', 'cm-md-block-gap-code-after')
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

/** 这一行至少有一部分落在视口里(装饰只给视口内的行,滚动时重建会补上) */
function lineInView(ctx: RuleContext, line: Line): boolean {
  return line.to >= ctx.visibleFrom && line.from <= ctx.visibleTo
}

/**
 * 把一块代码按「普通代码块」的样子画出来,但不加块前后的间距。
 *
 * 开围栏行按源码显示(` ```js title="main.js" `):它就是用户改语言、改文件
 * 名的那一行 —— 标签条只负责选文件,名字从这一行现读(见 wysiwyg/codeTabs.ts)。
 * 围栏标记不隐藏,否则改 title 时看不到自己在改什么。
 *
 * 复制按钮挂在正文第一行右上角(开围栏行现在是看得见的源码行,挂首行会叠上去)。
 */
function styleGroupMember(ctx: RuleContext, member: CodeMember): void {
  const code = member.node
  const doc = ctx.doc
  const firstLine = doc.lineAt(code.from).number
  const lastLine = doc.lineAt(code.to).number
  const first = code.firstChild
  const last = code.lastChild

  const open = doc.line(firstLine)
  if (lineInView(ctx, open)) {
    addLine(ctx, open.from, codeLineClass(ctx, member.from) + ' cm-md-code-fence')
  }

  for (let n = firstLine + 1; n <= lastLine; n++) {
    const line = doc.line(n)
    if (!lineInView(ctx, line)) continue
    addLine(ctx, line.from, codeLineClass(ctx, member.from))
  }

  if (last?.name === 'CodeMark' && last.from !== first?.from && lineUntouched(ctx, last.from)) {
    hide(ctx, last.from, endOfTrailingSpaces(ctx.doc, last.to))
  }

  // 只有正文行才挂复制按钮;空文件(围栏之间没有内容)挂上去只会复制空白
  if (lastLine > firstLine && readCodeSource(doc, code).trim()) {
    addCodeCopy(ctx, code, doc.line(firstLine + 1).from)
  }
}

/** 把一块代码折成零高度(不显示的那几块) */
function collapseGroupMember(ctx: RuleContext, member: CodeMember): void {
  const doc = ctx.doc
  const firstLine = doc.lineAt(member.from).number
  const lastLine = doc.lineAt(member.to).number
  for (let n = firstLine; n <= lastLine; n++) {
    const line = doc.line(n)
    if (!lineInView(ctx, line)) continue
    addLine(ctx, line.from, 'cm-md-code-void')
    hide(ctx, line.from, line.to)
  }
}

/**
 * 相邻代码块 → 文件标签页。
 *
 * 只在「视口里最靠前的那一块」被访问时统一生成整组装饰(见 FencedCode 分支),
 * 所以这里的 members 只算一次,不会重复。
 *
 * 显示哪一块:
 *   · 光标/选区碰到哪一块就显示哪一块(拖选、Ctrl+A 时能同时看到多块源码);
 *   · 光标不在组里时,显示上次点标签选中的那块(默认第一块)。
 *
 * 标签条是块级 widget,挂在组头开围栏行上方,不替换任何文字;选中块的
 * 开围栏行照常按源码显示(` ```js title="main.js" `),语言和文件名就在这一行
 * 上直接改,标签名从 info string 现读。其余块整块折成零高度,但源码还在
 * 文档里:点标签、键盘上下移动、撤销/重做都只改变哪一块可见。
 */
function styleFencedCodeGroup(ctx: RuleContext, members: CodeMember[]): void {
  const doc = ctx.doc
  const head = members[0]
  const key = doc.lineAt(head.from).from
  const last = members[members.length - 1]

  addGapBefore(ctx, head.from, 'cm-md-gap-code-before', 'cm-md-block-gap-code-before')
  addGapAfter(ctx, last.to, 'cm-md-gap-code-after', 'cm-md-block-gap-code-after')

  // 高亮哪一块、显示哪一块必须是同一份结果 —— 标签条也按它画(见 codeTabs.ts),
  // 否则会出现「高亮 a.js、正文却是 b.js」
  const { active, touched } = resolveGroupActive(doc, ctx.sel, ctx.codeTabs, key, members)
  const anyTouched = touched.some(Boolean)
  const visible = members.map((_, i) => (anyTouched ? touched[i] : i === active))

  // 组内两块之间只隔着空白(见 codeTabs.ts 的 adjacentFence)。按标签页显示时
  // 这些空行不该在标签和正文之间留出一道空白,折成零高度;光标 / 选区落到空行
  // 上时保持原样,否则光标会藏进零高度行里。
  const gaps: Line[] = []
  for (let i = 1; i < members.length; i++) {
    const from = doc.lineAt(members[i - 1].to).number + 1
    const to = doc.lineAt(members[i].from).number - 1
    for (let n = from; n <= to; n++) gaps.push(doc.line(n))
  }
  const gapTouched = gaps.some(line => touchesLines(ctx.sel, doc, line.from, line.to))
  if (!gapTouched) {
    for (const line of gaps) {
      if (!lineInView(ctx, line)) continue
      // 用户自己回车留出来的空段落不是组内间隔,照常整行显示、能点回去
      if (keptEmptyParagraph(ctx, line.from)) continue
      addLine(ctx, line.from, 'cm-md-code-void')
      hide(ctx, line.from, line.to)
    }
  }

  // 标签条自己不在这个 ViewPlugin 里:块级 widget 只能由 StateField 提供
  // (见 codeTabs.ts 的 codeTabsStripField),它挂在组头开围栏行的上方。

  for (let i = 0; i < members.length; i++) {
    if (visible[i]) styleGroupMember(ctx, members[i])
    else collapseGroupMember(ctx, members[i])
  }
}

/**
 * 这条围栏是不是用户刚敲出来、还没回车补全的那一条(见 editor/pendingFence.ts)。
 *
 * 命中时整块先按普通文本显示:一敲 ```,下面已有的正文不该立刻被染成代码。
 * 回车补全、光标离开这行、或这行不再是围栏后记录清空,恢复正常代码块渲染。
 */
function isPendingFence(ctx: RuleContext, code: SyntaxNode): boolean {
  if (ctx.pendingFence === null) return false
  const first = code.firstChild
  return (
    !!first && first.name === 'CodeMark' && ctx.doc.lineAt(first.from).from === ctx.pendingFence
  )
}

/**
 * 是不是用户刚敲出来的公式开标记(`$$` / `\[`,还没按回车补全)。
 *
 * 与代码围栏同一条规则:开标记所在行就是 pendingFence 记下的那一行。
 * 刻意不看块有没有闭合 —— 远处的 `$$` 可能把它配成一对,用户此刻要的是
 * 在光标处新开一个公式块,不该被那一段带着走。
 */
function isPendingMathFence(ctx: RuleContext, block: SyntaxNode): boolean {
  if (ctx.pendingFence === null) return false
  const first = block.firstChild
  return !!first && first.name === 'MathMark' && ctx.doc.lineAt(first.from).from === ctx.pendingFence
}

/**
 * 占位列表标记(还没被解析成列表)也带上列表前后的间距。
 *
 * `正文\n1. ` 在 CommonMark 里仍是同一段正文 —— 空的列表项不能打断段落,
 * 没有 OrderedList 节点,也就没有上面那段「最外层列表补间距」。标记已经
 * 提前画出来了,间距若还等「补上第一个字、解析成列表」才出现,列表会在
 * 输入瞬间上下跳一下。这里按真正列表的同一套规则提前打上:落点相同
 * (撑开结构空行,或做成相邻正文行的 padding),补字后不会再有位移。
 *
 * 多行占位(连着敲了几条空项)算一个列表:只在第一条前、最后一条后留白,
 * 项与项之间不额外隔开。
 *
 * 段内硬换行(Shift+回车)连着的行仍然属于同一段:这时不补列表的前/后间距,
 * 否则硬换行会被撑成段落距离。等补上正文变成真正的列表时再按列表间距排。
 */
function stylePendingListGaps(ctx: RuleContext, first: Line, last: Line = first): void {
  const prev = first.number > 1 ? ctx.doc.line(first.number - 1) : null
  if (!prev || !endsWithHardBreak(prev)) {
    addGapBefore(ctx, first.from, 'cm-md-gap-list-before', 'cm-md-block-gap-list-before')
  }
  if (!endsWithHardBreak(last)) {
    addGapAfter(ctx, last.from, 'cm-md-gap-list-after', 'cm-md-block-gap-list-after')
  }
}

/**
 * 段落续行上只敲了列表符号、还没敲内容时,CommonMark 不把它当列表:
 * 空的列表项不能打断段落,`* ` / `+ ` / `1. ` 会整段并进前面的 Paragraph。
 * 于是符号原样显示,补上一个字才突然变成列表 —— 和 `- `(走 Setext 那条路,
 * 见 isLoneDashSetext)的观感对不上。
 *
 * 这里提前把这类「占位行」的标记画成列表符号。要求标记后**至少一个空格**:
 * 刚敲下 `*` / `1.` 时还可能是正文(斜体、序号),不急着换样子。
 *
 * 占位行不一定在段落末尾:在已有正文中间回车、敲一条 `1. `,后面那行仍是
 * 同一段正文,补字后它俩会变成「列表 + 懒续行」。只认最后一行的话,这一行
 * 直到补字前都不像列表、也没有间距,正是「输入后间距才正常」的来源。
 */
function stylePendingListMarker(ctx: RuleContext, para: SyntaxNode): void {
  const firstLine = ctx.doc.lineAt(para.from)
  const lastLine = ctx.doc.lineAt(para.to)
  // 段落首行不会是占位标记(会直接解析成列表),只认续行
  if (firstLine.number === lastLine.number) return

  // 连续的占位行是一个列表;碰到普通正文就结算上一段
  let runFirst: Line | null = null
  let runLast: Line | null = null
  const flush = (): void => {
    if (runFirst && runLast) stylePendingListGaps(ctx, runFirst, runLast)
    runFirst = null
    runLast = null
  }

  for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
    const line = ctx.doc.line(n)
    const m = /^([ \t]*)([*+]|\d{1,9}[.)])([ \t]+)$/.exec(line.text)
    if (!m) {
      flush()
      continue
    }
    const from = line.from + m[1].length
    const marker = m[2]
    const bullet = marker === '*' || marker === '+'
    ctx.decos.push({
      from,
      to: from + marker.length,
      value: markDeco(bullet ? 'cm-md-listmark cm-md-listmark-bullet' : 'cm-md-listmark')
    })
    if (!runFirst) runFirst = line
    runLast = line
  }
  flush()
}

// ---------- 行内 HTML(白名单,见 services/inlineHtml) ----------

/**
 * 白名单标签 → 编辑器里的样式类。
 *
 * 和 Markdown 有对应写法的标签复用同一套类(b/strong 与 `**`、i/em 与 `*`、
 * s/del 与 `~~`、code 与反引号),颜色和字体度量因此完全一致。span 只藏标签、
 * 不加样式;没列出的标签不会走到这里。
 */
const HTML_TAG_CLASS: Record<string, string> = {
  b: 'cm-md-strong',
  strong: 'cm-md-strong',
  i: 'cm-md-em',
  em: 'cm-md-em',
  u: 'cm-md-html-u',
  ins: 'cm-md-html-u',
  s: 'cm-md-strike',
  del: 'cm-md-strike',
  mark: 'cm-md-html-mark',
  sub: 'cm-md-html-sub',
  sup: 'cm-md-html-sup',
  kbd: 'cm-md-html-kbd',
  code: 'cm-md-inlinecode',
  span: ''
}

/**
 * 在**同一父节点**里找配对的结束标签。
 *
 * 只走兄弟节点:正常的 `<b>…</b>` 会解析成同一段/标题里的两个 HTMLTag。
 * 开始标签在强调、链接内部时结束标签可能是别的父节点,这种情况按"没配对"
 * 处理 —— 保持源码,总比把内容莫名其妙地套上样式好。
 */
function findHtmlCloseTag(open: SyntaxNode, name: string, doc: Text): SyntaxNode | null {
  let depth = 0
  for (let node = open.nextSibling; node; node = node.nextSibling) {
    if (node.name !== 'HTMLTag') continue
    const tag = parseInlineTag(doc.sliceString(node.from, node.to))
    if (!tag || tag.name !== name) continue
    if (tag.closing) {
      if (depth === 0) return node
      depth--
    } else if (!tag.void) {
      depth++
    }
  }
  return null
}

/**
 * 一个行内 HTML 标签 → 装饰。
 *
 * 成对标签在**选区不碰整个元素**时把标签藏起来,内容套上等价样式;落单的开始
 * 标签保持源码 —— 打了一半的 `<b>` 不该悄悄吃掉后面的正文。<br> 是空元素,
 * 换成一个真正的换行元素(见 HtmlBreakWidget)。
 */
function styleInlineHtmlTag(tag: SyntaxNode, ctx: RuleContext): void {
  const parsed = parseInlineTag(ctx.doc.sliceString(tag.from, tag.to))
  if (!parsed) return
  // 配对的结束标签由开始标签统一隐藏;落单的结束标签保持源码
  if (parsed.closing) return
  if (parsed.void) {
    if (!touches(ctx.sel, tag.from, tag.to)) {
      hideWithWidget(ctx, tag.from, tag.to, new HtmlBreakWidget())
    }
    return
  }
  const close = findHtmlCloseTag(tag, parsed.name, ctx.doc)
  if (!close) return
  if (!touches(ctx.sel, tag.from, close.to)) {
    hide(ctx, tag.from, tag.to)
    hide(ctx, close.from, close.to)
  }
  const cls = HTML_TAG_CLASS[parsed.name]
  if (cls) addMark(ctx, tag.to, close.from, cls)
}

/**
 * 公式源码态:内容片段加淡底(便于看出公式边界)。
 *
 * 块级公式(MathsBlock)另外给整块每一行(含 `$$` / `\[` 定界行)铺一层
 * 与代码块相同的底色。多行公式的 MathContent 每行一个,且行首的引用 / 列表
 * 前缀不在内容区间里 —— 只染内容片段时,底色会在定界行和前缀处断开,
 * 看起来是几块碎条,而不是一个源码块。
 *
 * 左侧留白与代码块同一套做法:1.25em 的透明 border-left(见 CSS)。
 * 选区从块上方起时挂上 bleed 类,让那块留白跟着选区染色,不在左边挖缺口。
 */
function styleMathSource(ctx: RuleContext, node: SyntaxNode): void {
  const content = mathContentRange(node)
  if (!content) return
  if (node.name === 'MathBlock') {
    const cls = selectionStartsBefore(ctx, node.from)
      ? 'cm-md-math-src-line cm-md-math-src-bleed'
      : 'cm-md-math-src-line'
    addLineRange(ctx, node.from, node.to, cls)
  }
  ctx.decos.push({ from: content.from, to: content.to, value: markDeco('cm-md-math-src') })
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
      markHeadingSpaceBefore(ctx, node.from)
      markHeadingEdges(ctx, node.from, node.to)
      return // 下钻:HeaderMark 与行内内容
    }
    case 'SetextHeading1':
      addLine(ctx, node.from, 'cm-md-h1')
      markHeadingSpaceBefore(ctx, node.from)
      markHeadingEdges(ctx, node.from, node.to)
      return
    case 'SetextHeading2': {
      // 单横线是「列表符号」的歧义态,不是标题下划线(见 isLoneDashSetext):
      // 上一行保持正文,这一行交给 HeaderMark 规则(敲了空格才画成圆点)。
      if (isLoneDashSetext(ctx, node.node)) return
      addLine(ctx, node.from, 'cm-md-h2')
      markHeadingSpaceBefore(ctx, node.from)
      markHeadingEdges(ctx, node.from, node.to)
      return
    }
    case 'HeaderMark': {
      const parent = node.node.parent
      if (!parent) return
      if (parent.name.startsWith('ATXHeading')) {
        if (lineUntouched(ctx, node.from)) {
          hide(ctx, node.from, endOfTrailingSpaces(ctx.doc, node.to))
        }
      } else if (parent.name === 'SetextHeading2' && ctx.doc.sliceString(node.from, node.to) === '-') {
        // 上一行末尾若是硬换行反斜杠(Shift+回车后接着敲 `-` / `- `),
        // 这一行会被解析成 Setext 下划线、没有 HardBreak 节点,兜底藏掉反斜杠
        const markLine = ctx.doc.lineAt(node.from)
        if (markLine.number > 1) hideTrailingBackslashLine(ctx, ctx.doc.line(markLine.number - 1))
        // 只敲了 `-`:还不算列表,按普通正文显示,补上空格才换圆点
        if (!isListDash(ctx, node.node)) return
        // 列表符号(不是 Setext 下划线):和真正的 ListMark 一样渲染成圆点
        ctx.decos.push({
          from: node.from,
          to: node.to,
          value: markDeco('cm-md-listmark cm-md-listmark-bullet')
        })
        // 这里同样还是「占位」状态(补字后才变 BulletList),列表间距提前打上
        stylePendingListGaps(ctx, ctx.doc.lineAt(node.from))
      } else {
        // Setext 下划线:降级为变暗,不隐藏。上一行末尾的硬换行反斜杠同样藏掉。
        const markLine = ctx.doc.lineAt(node.from)
        if (markLine.number > 1) hideTrailingBackslashLine(ctx, ctx.doc.line(markLine.number - 1))
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

    // ----- 硬换行(Shift+回车的段内换行) -----
    case 'HardBreak': {
      // 反斜杠写法:始终藏起来,屏幕上只留行间距(见 hideTrailingBackslashLine)。
      // 行尾两个空格的写法本来就看不见,不用处理。
      const text = ctx.doc.sliceString(node.from, node.to)
      if (text.startsWith('\\')) hide(ctx, node.from, node.from + 1)
      return
    }

    // ----- 行内代码 -----
    case 'InlineCode': {
      /*
       * 样式**不随选区收起**:行内代码用的是等宽字体 + 0.9em + 内边距,
       * 行盒比普通正文高约 1px。以前光标/选区碰进来就摘掉这个类,整行
       * 立刻矮 1px —— 选中一条含行内代码的列表项时,后面所有项跟着上移,
       * 看起来像"列表间距变小了"。反引号该露还是露(见 CodeMark),只让
       * 字体度量保持不变。
       */
      const n = node.node
      const first = n.firstChild
      const last = n.lastChild
      if (first && last && last.from > first.to) {
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
      // 刚敲出来的围栏先别渲染成代码块,否则后面的正文会立刻被吞进去
      if (isPendingFence(ctx, code)) return false
      // 相邻代码块 → 文件标签页。整组装饰只由视口里最靠前的那一块生成,
      // 否则迭代器每进一块都会把同一组画一遍(装饰重叠会直接抛错)。
      const group = codeGroupAt(ctx.doc, code, ctx.pendingFence)
      if (group) {
        const firstVisible = group.findIndex(
          m => m.to >= ctx.visibleFrom && m.from <= ctx.visibleTo
        )
        if (group.findIndex(m => m.node === code) === firstVisible) {
          styleFencedCodeGroup(ctx, group)
        }
        return false
      }
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
      addLineRange(ctx, node.from, node.to, codeLineClass(ctx, node.from))
      addCodeCopy(ctx, node.node)
      addGapBefore(ctx, node.from, 'cm-md-gap-code-before', 'cm-md-block-gap-code-before')
      addGapAfter(ctx, node.to, 'cm-md-gap-code-after', 'cm-md-block-gap-code-after')
      return false
    }

    // ----- 引用 -----
    case 'Blockquote': {
      // 嵌套引用由最外层一次性覆盖所有行
      if (node.node.parent?.name === 'Blockquote') return
      // 裸 `>` 先按普通文本显示(见 quoteOpened)
      if (!quoteOpened(ctx.doc, node.node)) return
      const lastQuoted = styleQuotedLines(ctx, node.node)
      if (!lastQuoted) return
      addGapBefore(ctx, node.from, 'cm-md-gap-quote-before', 'cm-md-block-gap-quote-before')
      addGapAfter(ctx, lastQuoted.from, 'cm-md-gap-quote-after', 'cm-md-block-gap-quote-after')
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

    // ----- 段落(续行上的占位列表符号 / 两段正文之间的空行) -----
    case 'Paragraph':
      stylePendingListMarker(ctx, node.node)
      styleBodyGap(ctx, node.node)
      hideTrailingBackslash(ctx, node.node)
      return // 下钻:行内强调 / 链接

    // ----- 列表 -----
    case 'BulletList':
    case 'OrderedList': {
      /*
       * 只在最外层列表上补间距,嵌套列表由外层节点一次带过。
       *
       * 间距落在**最后一个列表标记**后面,而不是列表节点的 to 后面:笔记里
       * 常见的写法是列表标记之后直接写正文(没有空行),lezer 会把这几行
       * 当成最后一项的懒续行、算进列表范围里。按 to 去找,中间那段正文就
       * 被当成列表的一部分,间距会落到更靠后的位置。
       */
      let nested = false
      for (let cur = node.node.parent; cur; cur = cur.parent) {
        if (cur.name === 'ListItem') {
          nested = true
          break
        }
      }
      if (!nested) {
        const firstMark = node.node.getChild('ListItem')?.getChild('ListMark') ?? null
        if (!markerComplete(ctx, firstMark)) {
          // 只敲了 `-` / `1.`(还没空格):整行按普通正文显示,不补列表间距。
          // 上下空行都按「两段正文之间」的段间距收起 —— 否则敲下短横线、
          // 或在新段里开始输入时,空行从段间距恢复成整行,光标行会跳一下。
          addGapBefore(ctx, node.from, 'cm-md-gap-body', 'cm-md-block-gap-body')
          addGapAfter(ctx, node.to, 'cm-md-gap-body', 'cm-md-block-gap-body')
          return
        }
        const mark = lastListMark(node.node)
        if (mark) {
          addGapBefore(ctx, node.from, 'cm-md-gap-list-before', 'cm-md-block-gap-list-before')
          if (markerComplete(ctx, mark)) {
            addGapAfter(ctx, mark.from, 'cm-md-gap-list-after', 'cm-md-block-gap-list-after')
          }
        }
      }
      return
    }

    // ----- 列表 / 任务 -----
    case 'ListMark': {
      // 无序列表(- * +)渲染成圆点;有序列表保留编号。任务项的前导标记不加点
      // (由 checkbox widget 代替),其余字符仍保留在文档中,只是视觉上换成 •。
      const text = ctx.doc.sliceString(node.from, node.to)
      const isBullet = text === '-' || text === '*' || text === '+'
      // 标记必须敲出后面的空格才渲染;只敲了 `-` / `1.` 时保持普通正文
      if (!markerComplete(ctx, node.node)) return
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
      /*
       * 光标在公式块里时(包括刚敲出开标记、还没回车补全的待定状态),上方那条
       * 空行按正文段间距收紧。语法树里这一行已经不是 Paragraph,没人再给它补
       * 间距;不补的话,敲下第二个 `$`、或回车补全成公式块的那一刻,原本收紧的
       * 空行会恢复成整行高,光标行往下跳(和只敲了 `-` 的列表标记同理,见
       * BulletList 分支)。
       */
      if (node.name === 'MathBlock' && touches(ctx.sel, node.from, node.to)) {
        styleBodyGap(ctx, node.node)
      }
      // 刚敲出来的 `$$` / `\[` 先按普通文本显示,回车补全后再当公式块
      if (node.name === 'MathBlock' && isPendingMathFence(ctx, node.node)) return false
      const content = mathContentRange(node.node)
      if (!content) return false
      if (touches(ctx.sel, node.from, node.to)) {
        styleMathSource(ctx, node.node)
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
        styleMathSource(ctx, node.node)
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
      if (spec.widthLine) {
        // 列宽指令是表格的一部分:渲染态只藏指令文本,保留容器前缀的原位
        addLine(ctx, spec.widthLine.from, 'cm-md-table-widths')
        hide(ctx, spec.widthLine.textFrom, spec.widthLine.textTo)
      }
      if (spec.protectFrom < node.from && spec.protectFrom !== spec.widthLine?.from) {
        addLine(ctx, spec.protectFrom, 'cm-md-table-gap')
      }
      if (spec.protectTo > node.to) addLine(ctx, spec.protectTo, 'cm-md-table-gap')
      // 不下钻:单元格里的 URL / EmphasisMark 等规则会往已被隐藏的文本上加 mark 造成错位,
      // 行内高亮由 widget 内部的 renderInline 负责
      return false
    }

    // ----- 行内 HTML(白名单) -----
    case 'HTMLTag': {
      styleInlineHtmlTag(node.node, ctx)
      return
    }

    // ----- 独立 URL(autolink) -----
    case 'URL':
      ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-url') })
      return

    default:
      return
  }
}
