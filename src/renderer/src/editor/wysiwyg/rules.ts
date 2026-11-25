import { Decoration, type WidgetType } from '@codemirror/view'
import type { EditorSelection, Line, Range, Text } from '@codemirror/state'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
import type { BlockKind } from '@shared/editorSettings'
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
  /**
   * 当前非空选区来自鼠标拖选(含松开左键之后)。
   *
   * 这种选区只用来选内容,不该让行内标记 / 公式 / 图片 / 图表退回源码;
   * 光标点进这些元素(空选区)仍然照常显示源码,方便编辑。
   */
  pinRendered: boolean
  decos: Range<Decoration>[]
  atomic: Range<Decoration>[]
  links: LinkInfo[]
  /** 已经有行装饰的行首(collapseBlankRuns 用它跳过代码行等特殊空行) */
  decorated: Set<number>
  /**
   * 某一位置所在的最外层块节点名(Document 的直接子节点,如 Paragraph /
   * ATXHeading2 / FencedCode);取不到时为 null。
   *
   * 图片间距要知道邻居是标题还是正文,但规则是按语法树节点分发的 ——
   * 邻居行不一定是正在处理的节点,只能回问一次树。
   */
  blockAt(pos: number): string | null
  /**
   * 某一位置所在最外层块的配对类型(见 blockKindOf);不是参与配对的块时为
   * null。用于按**行**判断邻居 —— 待定围栏这类节点不在自己的装饰规则里,
   * 但要跟普通正文一样做边界裁切。
   */
  blockKindAt(pos: number): BlockKind | null
}

// ---------- 基础 emit 工具 ----------

/**
 * 行内代码与相邻中文之间补自动留白用。
 *
 * CJK 表意文字 / 假名 / 谚文:只有这类字符和拉丁字母相邻时,浏览器的
 * text-autospace 才会插空格。代码那一侧则要求是拉丁字母/数字,`$`、`\`
 * 这类符号开头的代码不补 —— 与原生自动留白的判断保持一致。
 */
const CJK_CHAR =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/
const LATIN_WORD_CHAR = /[A-Za-z0-9]/

/** 两个方向都算:中文 ↔ 英文(自动留白不区分谁在左谁在右) */
function needsAutoSpace(neighbor: string, codeEdge: string): boolean {
  return (
    (CJK_CHAR.test(neighbor) && LATIN_WORD_CHAR.test(codeEdge)) ||
    (LATIN_WORD_CHAR.test(neighbor) && CJK_CHAR.test(codeEdge))
  )
}

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
 * 只敲了 `#` / `##` …、还没补空格的 ATX 标题行。
 *
 * CommonMark 把行尾直接结束的 `#` 也解析成标题(内容为空),但编辑时一敲 `#`
 * 整行就跳成标题版式太突兀 —— 和「> 」引用、单横线列表同一套做法:等补上
 * 空格(或直接跟文字,那时解析器本来就给正文)再切换。只挡纯 `#`
 * (`^ {0,3}#{1,6}$`):`# 标题` 已经有空格,照常按标题渲染。
 */
function isPendingHeading(ctx: RuleContext, node: SyntaxNode): boolean {
  if (!node.name.startsWith('ATXHeading')) return false
  // 从节点自身的位置往后看:引用 / 列表里的 `> #`、`- #` 也只看 # 这一段,
  // 不带容器前缀。节点后面一旦有空白,说明空格已经敲下去了。
  const line = ctx.doc.lineAt(node.from)
  return /^ {0,3}#{1,6}$/.test(line.text.slice(node.from - line.from))
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
  return !showsSourceLines(ctx, line.from, line.to)
}

/**
 * 这个块要不要退回源码。
 *
 * 普通情况按原规则:光标或选区碰到它 = 显形可编辑(见 touches)。
 * 鼠标拖选期间与松开之后例外:选区只用于选中,块保持渲染态,不展开源码。
 */
function showsSource(ctx: RuleContext, from: number, to: number): boolean {
  return !ctx.pinRendered && touches(ctx.sel, from, to)
}

/** 行粒度的上面那条规则(图表按整块占的行判断) */
function showsSourceLines(ctx: RuleContext, from: number, to: number): boolean {
  return !ctx.pinRendered && touchesLines(ctx.sel, ctx.doc, from, to)
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
function quotedLines(ctx: RuleContext, quote: SyntaxNode): Line[] {
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
  return [...lines.values()].sort((a, b) => a.number - b.number)
}

function styleQuotedLines(ctx: RuleContext, quote: SyntaxNode): Line | null {
  let last: Line | null = null
  for (const line of quotedLines(ctx, quote)) {
    addLine(ctx, line.from, 'cm-md-quote')
    // 引用块的首 / 末行按正文段落裁边:行盒与敲 `>` 之前一致,块外的配对间距才不会被半份行距撑大
    trimParagraphEdge(ctx, line, quote)
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
 * 段落首行上侧 / 末行下侧:裁掉行盒里的半份行距。
 *
 * 行盒高 = (1 + 行间距档) × 字号,多出来的那一份在文字上下各分一半。段落
 * 的边界上,这半份行距会叠在配对间距(padding-top)外面 —— 行间距越大,
 * 段与段、段落与标题 / 代码 / 列表 / 引用 / 图片之间的距离都被一起拉大,
 * 配对间距就管不住那条缝了。
 *
 * 所以段落面向另一个**顶层块**(标题、代码、列表、引用、图片、表格、公式、
 * 图表)或文档边缘的一侧,一律用 text-box-trim 裁到文字边(行盒本身变矮,
 * CodeMirror 量到的就是裁后的高度,点击 / 光标位置不受影响)。边界距离
 * 从此只由配对间距决定,与行间距无关。文档最前面一段也裁上侧:它上面
 * 没有别的块,裁掉后拖动行间距时整篇正文不会上下滑。
 *
 * 只裁段落自己这一侧:标题 / 代码块的行高是固定档,不随行间距变;列表 /
 * 引用的行盒留白属于容器内部。段内的其余行不裁,行间距照常管段内节奏。
 *
 * 段落自身是独占一行的图片时不裁 —— 那一行由图片间距管。
 */
function styleParagraphTrim(ctx: RuleContext, para: SyntaxNode): void {
  if (para.parent?.name !== 'Document') return
  const first = ctx.doc.lineAt(para.from)
  const last = ctx.doc.lineAt(para.to)
  // 文档边缘没有「配对」,但边界留白同样不该由行间距提供,照样裁。
  const prev = para.prevSibling
  const next = para.nextSibling
  /*
   * 下一块是「还没有回车补全、且紧贴本段末行」的待定围栏时,它其实还是本段
   * 的续行:不能按独立块给它裁下侧,否则敲第三个反引号的那一瞬间本段末行
   * 会矮半档,围栏行跟着往上跳。
   */
  const nextIsPendingContinuation =
    !!next &&
    ((next.name === 'FencedCode' && isPendingFence(ctx, next)) ||
      (next.name === 'MathBlock' && isPendingMathFence(ctx, next))) &&
    !startsParagraphLine(ctx, next.from)
  // 下一个块不参与配对间距(未知块,如 HTML 块)时留原样:裁掉这半份行距
  // 会让两段之间只剩一条空行,不认识那种块的人也没法调。
  const prevPaired = !prev || blockKindOf(ctx, prev) !== null
  const nextPaired =
    (!next || blockKindOf(ctx, next) !== null) && !nextIsPendingContinuation
  if (prevPaired && !isImageOnlyLineText(first.text)) {
    addLine(ctx, first.from, 'cm-md-para-trim-top')
  }
  if (nextPaired && !isImageOnlyLineText(last.text)) {
    addLine(ctx, last.from, 'cm-md-para-trim-bottom')
  }
}

/** 整行只有一张图片(图片独占一行) —— 只有这种图片参与块间距 */
const IMAGE_ONLY_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/

function isImageOnlyLineText(text: string): boolean {
  return IMAGE_ONLY_LINE.test(text)
}

/** 顶层块节点对应的配对类型;不参与块间距的返回 null */
export function blockKindOf(ctx: RuleContext, node: SyntaxNode): BlockKind | null {
  switch (node.name) {
    case 'Paragraph':
      return isImageOnlyLineText(ctx.doc.lineAt(node.from).text) ? 'image' : 'body'
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
      // 只有 # 还没补空格:版式还是正文,配对间距也按正文算
      return isPendingHeading(ctx, node) ? 'body' : 'heading'
    case 'SetextHeading1':
    case 'SetextHeading2':
      return 'heading'
    case 'FencedCode':
      // 刚敲出来、还没回车补全的围栏仍是一条正文行:配对间距也按正文算,
      // 否则第三个反引号一落,整行就换到「代码块上方」的间距上
      if (isPendingFence(ctx, node)) return 'body'
      return fenceLanguage(ctx.doc, node) === 'mermaid' ? 'mermaid' : 'code'
    case 'CodeBlock':
      return 'code'
    case 'BulletList':
    case 'OrderedList':
      return 'list'
    case 'Blockquote':
      // 裸 `>` 还没补空格:版式仍是正文(见 quoteOpened),配对间距也按正文算,
      // 否则敲下 `>` 的瞬间下面段落就从「正文之间」换到「引用下方」的间距上了
      return quoteOpened(ctx.doc, node) ? 'quote' : 'body'
    case 'Table':
      return 'table'
    case 'MathBlock':
      // 同待定代码围栏:刚敲的 `$$` 还是正文行,间距 / 裁切都按正文算
      return isPendingMathFence(ctx, node) ? 'body' : 'math'
    default:
      return null
  }
}

/**
 * 上方紧邻的内容块如果是用户回车建出的空段落(见 emptyParagraph.ts),
 * 返回它的行首位置;否则返回 null。
 *
 * 空段落不是语法树里的块,但对用户来说它就是一个正文段落;下一条真正
 * 的块挨着它时,间距要按 body → 该块算。
 */
function emptyParagraphAbove(ctx: RuleContext, from: number): number | null {
  const line = ctx.doc.lineAt(from)
  for (let n = line.number - 1; n >= 1; n--) {
    const above = ctx.doc.line(n)
    if (/\S/.test(above.text)) return null
    if (ctx.emptyParagraphs.has(above.from)) return above.from
  }
  return null
}

/** 这一行是不是一个段落的首行(上一行是空行或文首) */
function startsParagraphLine(ctx: RuleContext, pos: number): boolean {
  const line = ctx.doc.lineAt(pos)
  return line.number === 1 || isBlankLine(ctx.doc.line(line.number - 1).text)
}

/**
 * 块与块之间的配对间距:把 `cm-md-<上块>-<下块>` 挂到**下方块的首行**,
 * 由 editor.css 的配对规则用 padding-top 承担间距。结构空行不占高度,
 * 所以两块的可见距离只由这一条边的配对值决定。
 */
function styleBlockPair(ctx: RuleContext, node: SyntaxNode): void {
  if (node.parent?.name !== 'Document') return
  const kind = blockKindOf(ctx, node)
  if (!kind) return
  /*
   * 待定围栏在语法树上已经是一块,但它还是用户那一行正文:如果这一行是
   * 段落的续行(上一行不是空行),它本来就没有配对间距,不能因为敲了第三个
   * 反引号凭空多出一档。
   */
  if (
    (node.name === 'FencedCode' && isPendingFence(ctx, node)) ||
    (node.name === 'MathBlock' && isPendingMathFence(ctx, node))
  ) {
    if (!startsParagraphLine(ctx, node.from)) return
  }
  const prev = node.prevSibling
  /*
   * 语法树里上面最近的块,可能隔着一条用户回车建出来的空段落(它不是语法
   * 节点)。紧挨着的上一块是那条空段落:配对要按 body→本块算。否则空段落
   * 写成正文的那一刻,配对类会从上面的旧块挪到空段落行上,整段上下跳一档
   * —— 光标在空段落里闪,一打字字就换了位置(空段落后面跟代码块时最明显)。
   */
  const emptyLine = emptyParagraphAbove(ctx, node.from)
  const prevKind = emptyLine !== null ? 'body' : prev ? blockKindOf(ctx, prev) : null
  if (!prevKind) return
  /*
   * 代码块 / 公式块有自己的底色:间距若做在它们的首行 padding 上,会连带把
   * 底色撑出一块空白 —— 上方看着贴住正文、下方却空出一档。这种情况把间距
   * 改做在上一块末行的 padding-bottom 上(有色块的背景外面),两侧观感才对称。
   * 其余配对一律做在下方块首行的 padding-top 上。
   */
  if ((kind === 'code' || kind === 'math') && (prev || emptyLine !== null)) {
    // 下侧配对单独命名:上一块末行本身可能还挂着它自己的上侧配类
    // (`cm-md-<x>-body`),两者共用 `cm-md-<x>-code` 会互相覆盖 padding-top
    const prevLine = emptyLine !== null ? ctx.doc.lineAt(emptyLine) : ctx.doc.lineAt(prev!.to)
    addLine(
      ctx,
      prevLine.from,
      `cm-md-block-pair cm-md-pair-bottom cm-md-bottom-${prevKind}-${kind}`
    )
    return
  }
  addLine(ctx, ctx.doc.lineAt(node.from).from, `cm-md-block-pair cm-md-${prevKind}-${kind}`)
}

/**
 * 连排的空行只留光标所在的那一条整行,其余按段间距收紧。
 *
 * CommonMark 里多出来的空行只是分隔,不是排版内容;而「回车 = 新段」恰好会
 * 补出连排空行 —— 新段先占一条空段落,上下各有一条分隔。不收的话,按一次
 * 回车屏幕上就连出两三行空白;收完正好是「一条空行 + 段间距」。
 *
 * 光标能停进去的那条不折叠(得能看见光标、接着打字),但会预先挂上正文
 * 段落的 trim 类,输入第一个字时行盒高度不变;已经有行装饰的空行也不动
 * (代码块里的空行是代码内容,块间距行已经有自己的高度)。
 */
/**
 * 裸 `>`(后面还没敲空格)。
 *
 * 引用的规则要等 `> ` 才当成引用(见 quoteOpened),这之前它就是一行普通
 * 文本。不能按空行折叠:折叠后是 0 高 + overflow:hidden,刚敲的 `>` 看不见、
 * 光标没有高度,下面的段落还会跟着往上跳。
 */
function bareQuoteLine(text: string): boolean {
  return text.includes('>') && !/>[ \t]/.test(text)
}

export function collapseBlankRuns(ctx: RuleContext, skip?: (from: number, to: number) => boolean): void {
  const first = ctx.doc.lineAt(ctx.visibleFrom).number
  const last = ctx.doc.lineAt(ctx.visibleTo).number
  for (let number = first; number <= last; number++) {
    const line = ctx.doc.line(number)
    if (!isBlankLine(line.text)) continue
    if (bareQuoteLine(line.text)) continue
    // 容器里的空行(代码块 / 引用 / 列表内部)是内容,已经有自己的行装饰
    if (ctx.decorated.has(line.from)) continue
    if (skip && skip(line.from, line.to)) continue
    // 回车建出的空段落已经由 build 的 trimForEmpty 按邻居挂好裁切类
    if (keptEmptyParagraph(ctx, line.from)) continue
    /*
     * 文末那一条空行也是新段的落点:先按正文段落挂好 trim 类 —— 空行本身
     * 不是语法树里的 Paragraph,输入第一个字后才会挂上;不预先挂的话,行盒会
     * 从 (1+行间距)×字号 突然缩到文字高,光标和整行往上跳一下(用户输入
     * 「，」时看到的就是这个)。
     */
    if (number === ctx.doc.lines) {
      addLine(ctx, line.from, 'cm-md-para-trim-top cm-md-para-trim-bottom')
      continue
    }
    // 结构空行:源码里保留,视觉上完全折叠 —— 间距由下方块的配对 padding 承担
    addLine(ctx, line.from, 'cm-md-structural-blank')
  }
}

/** 这一行是不是「回车创建、仍空着的段落」(见 editor/emptyParagraph.ts) */
function keptEmptyParagraph(ctx: RuleContext, from: number): boolean {
  return ctx.emptyParagraphs.has(from)
}

/** 这一行是否以硬换行结束(Markdown 的硬换行 = 行尾两个以上空格,或反斜杠) */
function endsWithHardBreak(line: Line): boolean {
  return /(?: {2,}|\\)$/.test(line.text)
}

/**
 * 这个块是不是紧接在段内硬换行之后(上一行以 `\` / 两个空格结尾)。
 *
 * 是的话,块和上一行仍属于同一段:不再补块间距,距离就是行间距。
 * 段落之间(有空行 / 回车分段)则正常补块间距。表格、列表、代码、引用共用。
 */
function afterHardBreak(ctx: RuleContext, pos: number): boolean {
  const line = ctx.doc.lineAt(pos)
  return line.number > 1 && endsWithHardBreak(ctx.doc.line(line.number - 1))
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

  // 高亮哪一块、显示哪一块必须是同一份结果 —— 标签条也按它画(见 codeTabs.ts),
  // 否则会出现「高亮 a.js、正文却是 b.js」
  const { active, touched } = resolveGroupActive(doc, ctx.sel, ctx.codeTabs, key, members)
  const anyTouched = touched.some(Boolean)
  const visible = members.map((_, i) => (anyTouched ? touched[i] : i === active))

  // 组内两块严格相邻(见 codeTabs.ts 的 adjacentFence):闭合围栏的下一行就是
  // 下一块的开围栏,没有空行需要折叠。

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
 * 按正文段落的边界裁掉半份行距(text-box-trim)。
 *
 * 两类「刚敲出来、语法树已经换了身份」的行要用它,否则行盒会比原来的段落行
 * 高出半档,敲下下一个字符时整行(连同下面的内容)会往下跳一下:
 *   - 待定围栏 / 公式开标记(见 isPendingFence):它还是用户刚敲的正文行;
 *   - 引用行(裸 `>` 与 `> ` 开头的那一行):敲 `>` 的瞬间就变成了 Blockquote。
 *
 * 判定与段落首 / 末行一致:上一行是空行(或文首)才是首行,下一行是空行
 * (或文末)才是末行。夹在段中的续行两侧都不裁 —— 裁了反而会往上跳。
 */
function trimParagraphEdge(ctx: RuleContext, line: Line, quote?: SyntaxNode): void {
  const pairedAt = (pos: number): boolean => ctx.blockKindAt(pos) !== null
  const blank = (n: number): boolean => {
    if (n < 1 || n > ctx.doc.lines) return true
    const target = ctx.doc.line(n)
    if (!isBlankLine(target.text)) return false
    /*
     * 引用里只写了 `>` 的一行(`>` / `> ` / `>> `)在源码上算空行,但它仍然是
     * 引用的一行:有竖线、有行盒,用户在它上面接着打字时它就会变成正文。
     * 对同一条引用的邻居来说,它不能算「段落之间的结构空行」—— 否则上一行
     * 先按段尾裁掉半份行距,下一行一敲字裁切消失,整块会往下跳一截。
     */
    if (
      quote &&
      /^\s*>[\s>]*$/.test(target.text) &&
      target.from >= quote.from &&
      target.to <= quote.to
    ) {
      return false
    }
    return true
  }
  /** 最近的另一块(跳过空行) */
  const blockAt = (n: number, dir: 1 | -1): Line | null => {
    for (let i = n; i >= 1 && i <= ctx.doc.lines; i += dir) {
      const l = ctx.doc.line(i)
      if (!isBlankLine(l.text)) return l
    }
    return null
  }
  const startsParagraph = blank(line.number - 1)
  const endsParagraph = blank(line.number + 1)
  const above = startsParagraph ? blockAt(line.number - 1, -1) : null
  const below = endsParagraph ? blockAt(line.number + 1, 1) : null
  const top = startsParagraph && (!above || pairedAt(above.from))
  const bottom = endsParagraph && (!below || pairedAt(below.from))
  const cls = [top ? 'cm-md-para-trim-top' : '', bottom ? 'cm-md-para-trim-bottom' : '']
    .filter(Boolean)
    .join(' ')
  if (cls) addLine(ctx, line.from, cls)
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

  for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
    const line = ctx.doc.line(n)
    const m = /^([ \t]*)([*+]|\d{1,9}[.)])([ \t]+)$/.exec(line.text)
    if (!m) continue
    const from = line.from + m[1].length
    const marker = m[2]
    const bullet = marker === '*' || marker === '+'
    ctx.decos.push({
      from,
      to: from + marker.length,
      value: markDeco(bullet ? 'cm-md-listmark cm-md-listmark-bullet' : 'cm-md-listmark')
    })
  }
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
    if (!showsSource(ctx, tag.from, tag.to)) {
      hideWithWidget(ctx, tag.from, tag.to, new HtmlBreakWidget())
    }
    return
  }
  const close = findHtmlCloseTag(tag, parsed.name, ctx.doc)
  if (!close) return
  if (!showsSource(ctx, tag.from, close.to)) {
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
  // 顶层块:按「上块 → 本块」挂配对类,间距由这两个类型决定
  if (node.node.parent?.name === 'Document') styleBlockPair(ctx, node.node)
  switch (node.name) {
    // ----- 标题 -----
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6': {
      /*
       * 还没敲空格:先按普通正文段落排版(含边界裁切),标记字符照常可见。
       * 补上空格后下一轮重建才会变成标题 —— 不让一次按键把整行撑成标题。
       */
      if (isPendingHeading(ctx, node.node)) {
        styleParagraphTrim(ctx, node.node)
        return // 下钻:HeaderMark 需要决定露不露出 #
      }
      addLine(ctx, node.from, `cm-md-h${node.name.slice(-1)}`)
      return // 下钻:HeaderMark 与行内内容
    }
    case 'SetextHeading1':
      addLine(ctx, node.from, 'cm-md-h1')
      return
    case 'SetextHeading2': {
      // 单横线是「列表符号」的歧义态,不是标题下划线(见 isLoneDashSetext):
      // 上一行保持正文,这一行交给 HeaderMark 规则(敲了空格才画成圆点)。
      if (isLoneDashSetext(ctx, node.node)) return
      addLine(ctx, node.from, 'cm-md-h2')
      return
    }
    case 'HeaderMark': {
      const parent = node.node.parent
      if (!parent) return
      if (parent.name.startsWith('ATXHeading')) {
        // 还没成标题(只有 #):标记必须一直看得见,光标移到别处也不能藏
        if (!isPendingHeading(ctx, parent) && lineUntouched(ctx, node.from)) {
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
      if (!showsSource(ctx, node.from, node.to)) {
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
      if (parent && !showsSource(ctx, parent.from, parent.to)) {
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

    // ----- 反斜线转义(CommonMark 写法) -----
    // `\[` / `\]` / `\*` / `\#` / `\$` … 源码里的反斜线只是转义标记:离开选区
    // 时藏起来,屏幕上只留被转义的字符本身;光标贴在它上面时仍按源码显示,
    // 方便删改。导出侧 markdown-it 本来就是这套语义,这里只是让编辑器跟上。
    case 'Escape': {
      if (!showsSource(ctx, node.from, node.to)) hide(ctx, node.from, node.from + 1)
      return
    }

    // ----- 行内代码 -----
    case 'InlineCode': {
      /*
       * 样式**不随选区收起**:行内代码的底色与内边距一直挂着,光标进入时
       * 只让反引号露出来(见 CodeMark)。以前光标/选区碰进来就摘掉这个
       * 类,选中一条含行内代码的列表项时,整行样式来回切换、后面各项跟着
       * 动一下 —— 看起来像"列表间距变了"。
       *
       * 中文与代码之间要补自动留白:浏览器的 text-autospace 跨不过 CM 插在
       * 反引号位置上的零宽 widget,紧贴中文时那个空格会消失。只在实际相邻
       * 中文的一侧挂类(见 editor.css),行首 / 行尾 / 已经隔了空格的代码
       * 不会被推离位置。
       */
      const n = node.node
      const first = n.firstChild
      const last = n.lastChild
      if (first && last && last.from > first.to) {
        let cls = 'cm-md-inlinecode'
        if (!showsSource(ctx, node.from, node.to)) {
          const head = ctx.doc.sliceString(first.to, first.to + 1)
          const tail = ctx.doc.sliceString(last.from - 1, last.from)
          const before = node.from > 0 ? ctx.doc.sliceString(node.from - 1, node.from) : ''
          const after = node.to < ctx.doc.length ? ctx.doc.sliceString(node.to, node.to + 1) : ''
          if (needsAutoSpace(before, head)) cls += ' cm-md-inlinecode-space-before'
          if (needsAutoSpace(after, tail)) cls += ' cm-md-inlinecode-space-after'
        }
        addMark(ctx, first.to, last.from, cls)
      }
      return // CodeMark 子节点单独处理
    }
    case 'CodeMark': {
      const parent = node.node.parent
      if (parent?.name === 'InlineCode' && !showsSource(ctx, parent.from, parent.to)) {
        hide(ctx, node.from, node.to)
      }
      return
    }

    // ----- 代码块 -----
    case 'FencedCode': {
      const code = node.node
      // 刚敲出来的围栏先别渲染成代码块,否则后面的正文会立刻被吞进去
      if (isPendingFence(ctx, code)) {
        trimParagraphEdge(ctx, ctx.doc.lineAt(code.from))
        return false
      }
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
        if (firstLineVisible && !showsSourceLines(ctx, node.from, node.to)) {
          const widget = new MermaidWidget(readCodeSource(ctx.doc, code), currentMermaidTheme())
          // 宿主行行高归零(见 CSS):图表块的高度完全交给 widget,别让一行
          // 正文的行距在边界上凭空多出上下各一截
          addLine(ctx, firstLine.from, 'cm-md-mermaid-host')
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
      return false
    }

    // ----- 引用 -----
    case 'Blockquote': {
      // 嵌套引用由最外层一次性覆盖所有行
      if (node.node.parent?.name === 'Blockquote') return
      // 裸 `>` 先按普通文本显示(见 quoteOpened):行盒也按正文段落裁边,敲 `>` 时下面的正文不跳
      if (!quoteOpened(ctx.doc, node.node)) {
        for (const line of quotedLines(ctx, node.node)) trimParagraphEdge(ctx, line)
        return
      }
      const lastQuoted = styleQuotedLines(ctx, node.node)
      if (!lastQuoted) return
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
         *
         * 用 0 号字隐藏,而不是 replace 成零宽 widget:后者会在行里插入
         * cm-widgetBuffer 与一个空 inline 盒,行距小于字号时会把行盒撑高,
         * 光标在两行之间切换(标记显 / 隐)时竖线和文字就跟着跳。
         * 和列表圆点同一套做法:字符留在文档里,行内盒高度不变。
         */
        addMark(
          ctx,
          node.from,
          endOfTrailingSpaces(ctx.doc, node.to),
          'cm-md-quotemark-hidden'
        )
      } else {
        // 光标在这行时标记显形(源码态);弱化成灰色,和 Obsidian 一样不抢正文
        ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-quotemark') })
      }
      return
    }

    // ----- 段落(续行上的占位列表符号 / 两段正文之间的空行) -----
    case 'Paragraph':
      stylePendingListMarker(ctx, node.node)
      styleParagraphTrim(ctx, node.node)
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
          /*
           * 还只是个裸标记(`-` / `*` / `1.`,还没敲空格):语法上已经是空列表项,
           * 但渲染层按普通正文显示。
           *
           * 裁边要和它替换掉的那条空段落一致(空段落上下都按文字边裁),
           * 否则敲下 `-` 的那一瞬间行盒高度会变,上下相邻的标题 / 正文跟着跳。
           */
          const line = ctx.doc.lineAt(node.node.from)
          addLine(ctx, line.from, 'cm-md-para-trim-top')
          addLine(ctx, line.from, 'cm-md-para-trim-bottom')
          return
        }
        /*
         * 列表行距只覆盖到**最后一个列表标记**为止。
         *
         * 列表项后面没有空行时,Lezer 会把紧跟的正文当成最后一项的懒续行、
         * 算进列表节点里;块间距本来就是按「最后一个列表标记」位置算的
         * (见上面的注释),行距也要对齐这个边界 —— 否则那段正文会被带上
         * 列表行距,调列表行距连「列表 ↔ 正文」的距离一起变。
         */
        let lastMarker = ctx.doc.lineAt(node.node.from)
        const visit = (n: typeof node.node): void => {
          if (n.name === 'ListMark') {
            const line = ctx.doc.lineAt(n.from)
            if (line.number > lastMarker.number) lastMarker = line
          }
          for (let child = n.firstChild; child; child = child.nextSibling) visit(child)
        }
        visit(node.node)
        addLineRange(ctx, node.node.from, lastMarker.to, 'cm-md-list-line')
        /*
         * 列表首行 / 最后一个标记行面向块外的一侧裁掉半份行距:列表内部
         * 行距不能把「列表 ↔ 正文」的配对间距一起撑大。后随的懒续行正文
         * 不再挂列表行距,这一段缝就只剩配对间距。
         */
        const firstLine = ctx.doc.lineAt(node.node.from)
        addLine(ctx, firstLine.from, 'cm-md-para-trim-top')
        addLine(ctx, lastMarker.from, 'cm-md-para-trim-bottom')
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
      if (showsSource(ctx, node.from, node.to)) {
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
      // 刚敲出来的 `$$` / `\[` 先按普通文本显示,回车补全后再当公式块
      if (node.name === 'MathBlock' && isPendingMathFence(ctx, node.node)) {
        trimParagraphEdge(ctx, ctx.doc.lineAt(node.from))
        return false
      }
      const content = mathContentRange(node.node)
      if (!content) return false
      if (showsSource(ctx, node.from, node.to)) {
        styleMathSource(ctx, node.node)
        return false
      }
      const tex = mathSource(ctx.doc, node.node)
      const firstLine = ctx.doc.lineAt(node.from)
      const lastLine = ctx.doc.lineAt(node.to)
      if (firstLine.number === lastLine.number) {
        // 单行 $$...$$:直接整体替换
        addLine(ctx, firstLine.from, 'cm-md-math-host')
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
      addLine(ctx, firstLine.from, 'cm-md-math-host')
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
      if (parent && !showsSource(ctx, parent.from, parent.to)) return // 外层已整体替换
      ctx.decos.push({ from: node.from, to: node.to, value: markDeco('cm-md-mathmark') })
      return
    }

    // ----- 图片 -----
    case 'Image': {
      if (!showsSource(ctx, node.from, node.to)) {
        const text = ctx.doc.sliceString(node.from, node.to)
        // 目标可以写成 `<带 空格/括号的路径>`,CommonMark 允许;第二种写法是裸路径
        const m = /^!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))[^)]*\)/.exec(text)
        if (m) {
          const src = resolveImageSrc(m[2] ?? m[3], ctx.docDir)
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
      if (tail && open && !showsSource(ctx, node.from, node.to)) {
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
      const lastLine = ctx.doc.lineAt(node.to)
      /*
       * 表格上下各有一条"结构空行"(见 readTable 的 protectFrom/protectTo)。
       * 有这条空行时,间距由空行承担、frame 该侧归零;没有空行时:
       *   · 紧贴标题 —— 标题自己的留白为准,frame 该侧也归零;
       *   · 紧贴其它块 —— frame 的 padding 提供间距(见 editor.css)。
       */
      // 首行换成 widget(它自带整张表),其余行清空并折叠高度
      // 宿主行去掉行盒 strut:否则表格上下会多出半行字体留白,看起来像多了一行。
      // 紧接段内硬换行时不再加 frame 顶部留白:距离就是行间距。
      const tightTop = afterHardBreak(ctx, node.from)
      addLine(
        ctx,
        firstLine.from,
        [
          'cm-md-table-host',
          fullySelected ? 'cm-md-table-host-selected' : '',
          tightTop ? 'cm-md-table-tight-top' : ''
        ]
          .filter(Boolean)
          .join(' ')
      )
      hideWithWidget(ctx, firstLine.from, firstLine.to, new TableWidget(spec))
      for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
        const line = ctx.doc.line(n)
        hide(ctx, line.from, line.to)
        addLine(ctx, line.from, 'cm-md-table-void')
      }
      // 紧邻表格的分隔空行由 collapseBlankRuns 统一折叠(0 高);光标 / 点击由
      // keepCaretOutOfTables 与 caretOutsideRenderedTable 按 protectFrom/protectTo 越过。
      if (spec.widthLine) {
        // 列宽指令是表格的一部分:渲染态只藏指令文本,保留容器前缀的原位
        addLine(ctx, spec.widthLine.from, 'cm-md-table-widths')
        hide(ctx, spec.widthLine.textFrom, spec.widthLine.textTo)
      }
      // 表格前后的结构空行由 collapseBlankRuns 统一折叠;间距由表格宿主行上的
      // 配对类承担(见 rules.ts 的 styleBlockPair 与 editor.css 的配对规则)。
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
