import type { SyntaxNode } from '@lezer/common'
import type {
  BlockContext,
  BlockParser,
  InlineContext,
  InlineParser,
  Line,
  MarkdownExtension
} from '@lezer/markdown'

/**
 * LaTeX 公式语法扩展:$行内$ / \(行内\) 与 $$块级$$ / \[块级\](可跨行)。
 *
 * 行内公式用 Lezer 的行内解析器而不是正则扫描——代码块/行内代码里的 $ 不会被误判,
 * 转义 \$ 也由 Escape 解析器自然处理。
 *
 * 块级公式必须**同时**有块解析器,只靠行内解析器是不够的:Lezer 先做块解析、
 * 再做行内解析,`+ ` / `- ` / `>` / `#` 这些行首标记在行内解析开始前就会把段落
 * 截断。多行推导式里一行以 `+` 开头极常见,后半段会被读成列表,`$$` 再也配不上对
 * (导出用的 markdown-it 规则本来就是块级的,见 services/markdownMath.ts)。
 *
 * \[...\] / \(...\) 是 AI 模型与 TeX 文档更常用的写法,与 $ 写法保持同一套节点。
 * 行内规则必须排在 Escape **之前**,否则 `\(` 会先被当成转义后的左括号。
 */

const DOLLAR = 36
const OPEN_PAREN = 40
const CLOSE_PAREN = 41
const BACKSLASH = 92
const NEWLINE = 10

function isBlank(ch: number): boolean {
  return ch === 32 /* 空格 */ || ch === 9 /* Tab */ || ch === NEWLINE || ch === 13
}

function mathElement(
  cx: InlineContext,
  type: string,
  from: number,
  to: number,
  openLen: number,
  closeFrom: number
): ReturnType<InlineContext['elt']> {
  return cx.elt(type, from, to, [
    cx.elt('MathMark', from, from + openLen),
    cx.elt('MathContent', from + openLen, closeFrom),
    cx.elt('MathMark', closeFrom, to)
  ])
}

/** 行内公式 $...$:不跨行,内容首尾不能是空白 */
function parseInlineMath(cx: InlineContext, pos: number): number {
  const start = pos + 1
  if (start >= cx.end || isBlank(cx.char(start))) return -1
  for (let i = start; i < cx.end; i++) {
    const ch = cx.char(i)
    if (ch === NEWLINE) return -1
    if (ch === BACKSLASH) {
      i++
      continue
    }
    if (ch === DOLLAR) {
      if (isBlank(cx.char(i - 1))) return -1
      return cx.addElement(mathElement(cx, 'InlineMath', pos, i + 1, 1, i))
    }
  }
  return -1
}

/** 行内公式 \(...\):不跨行,内容首尾不能是空白 */
function parseParenMath(cx: InlineContext, pos: number): number {
  if (cx.char(pos + 1) !== OPEN_PAREN) return -1
  const start = pos + 2
  if (start >= cx.end || isBlank(cx.char(start))) return -1
  for (let i = start; i < cx.end; i++) {
    const ch = cx.char(i)
    if (ch === NEWLINE) return -1
    if (ch === BACKSLASH) {
      if (cx.char(i + 1) === CLOSE_PAREN) {
        if (i === start || isBlank(cx.char(i - 1))) return -1
        return cx.addElement(mathElement(cx, 'InlineMath', pos, i + 2, 2, i))
      }
      i++
      continue
    }
  }
  return -1
}

/** 段落内的块级公式 $$...$$(可跨行) */
function parseDisplayMath(cx: InlineContext, pos: number): number {
  const start = pos + 2
  for (let i = start; i < cx.end - 1; i++) {
    const ch = cx.char(i)
    if (ch === BACKSLASH) {
      i++
      continue
    }
    if (ch === DOLLAR && cx.char(i + 1) === DOLLAR) {
      if (cx.slice(start, i).trim().length === 0) return -1
      return cx.addElement(mathElement(cx, 'DisplayMath', pos, i + 2, 2, i))
    }
  }
  return -1
}

const mathParser: InlineParser = {
  name: 'iMarkdownMath',
  // 排在 Escape 之前:否则 \( 会先被转义解析器吃掉;也自然排在 Emphasis 之前,
  // 公式内容不会被 * _ 之类的强调解析拆开
  before: 'Escape',
  parse(cx, next, pos) {
    if (next === BACKSLASH) return parseParenMath(cx, pos)
    if (next !== DOLLAR) return -1
    if (cx.char(pos + 1) === DOLLAR) {
      // $$$ 不处理(留给普通文本)
      return cx.char(pos + 2) === DOLLAR ? -1 : parseDisplayMath(cx, pos)
    }
    return parseInlineMath(cx, pos)
  }
}

// ---------- 块解析器 ----------

interface MathFence {
  name: string
  /** 行首开标记 */
  open: string
  /** 收尾标记 */
  close: string
  /** 收尾扫描是否跳过转义字符:$$ 要跳过 \$,\[ 的收尾本身就是转义序列 */
  skipEscapes: boolean
  /** 拒绝三连($$$ 留给普通文本) */
  rejectTriple: boolean
}

const DOLLAR_FENCE: MathFence = {
  name: 'iMarkdownMathBlock',
  open: '$$',
  close: '$$',
  skipEscapes: true,
  rejectTriple: true
}

const BRACKET_FENCE: MathFence = {
  name: 'iMarkdownBracketMathBlock',
  open: '\\[',
  close: '\\]',
  skipEscapes: false,
  rejectTriple: false
}

/** 行首(已跳过引用/列表等容器标记)是不是块级公式的开头;$$$ 不算 */
function isMathFence(line: Line, fence: MathFence): boolean {
  const pos = line.pos
  if (line.text.slice(pos, pos + fence.open.length) !== fence.open) return false
  if (
    fence.rejectTriple &&
    line.text.charCodeAt(pos + fence.open.length) === fence.open.charCodeAt(0)
  ) {
    return false
  }
  return true
}

/**
 * 在一行里找收尾标记,返回其起始下标(找不到返回 -1)。
 *
 * 两个约束与导出侧 markdown-it 的块规则一致:
 *   - 收尾标记后面只允许空白。否则 `$$x$$ 后面的正文` 这种本该是
 *     「行内公式 + 正文」的写法会被整行当成块级公式。
 *   - `$$` 的转义 \$ 不参与配对(与行内解析器一致);`\]` 不跳过,
 *     否则连收尾标记自己都会被当成转义字符跳过去。
 */
function closeIndex(text: string, from: number, fence: MathFence): number {
  for (let i = from; i <= text.length - fence.close.length; i++) {
    const ch = text.charCodeAt(i)
    if (fence.skipEscapes && ch === BACKSLASH) {
      i++
      continue
    }
    if (text.startsWith(fence.close, i) && text.slice(i + fence.close.length).trim() === '') {
      return i
    }
  }
  return -1
}

/*
 * 判断「这一行是否还在当前块解析器所属的容器里」。
 *
 * Line.depth / BlockContext.stack 在 @lezer/markdown 的类型声明里标了 @internal,
 * 但跨行块解析器没有别的公开途径知道引用/列表容器是否已经结束(内置 FencedCode
 * 的循环条件用的也是这两个字段)。两者运行时都是普通字段,版本由 lockfile 固定。
 */
function lineDepth(line: Line): number {
  return (line as unknown as { depth: number }).depth
}

function contextDepth(cx: BlockContext): number {
  return (cx as unknown as { stack: readonly unknown[] }).stack.length
}

/**
 * 块级公式:从行首开标记一直吞到收尾标记。
 *
 * 收尾标记找不到时(用户刚打出开头的 `$$` / `\[`)按围栏代码块的办法处理——
 * 一直吃到容器/文档末尾。这样 `+`、`-`、`>` 这些行首标记不会再有机会
 * 从公式中间插进来;光标还在公式里时 wysiwyg 本来就显示源码态,
 * 不会出现整块被 widget 吞掉的情况。
 */
function createMathBlockParser(fence: MathFence): BlockParser {
  const openLen = fence.open.length
  const closeLen = fence.close.length
  return {
    name: fence.name,
    before: 'FencedCode',
    parse(cx: BlockContext, line: Line) {
      if (!isMathFence(line, fence)) return false
      const from = cx.lineStart + line.pos

      // 单行写法 $$x$$ / \[x\]:内容不能为空(与行内解析器的要求一致)
      const sameLine = closeIndex(line.text, line.pos + openLen, fence)
      if (sameLine >= 0) {
        if (line.text.slice(line.pos + openLen, sameLine).trim() === '') return false
        const closeFrom = cx.lineStart + sameLine
        const elt = cx.elt('MathBlock', from, closeFrom + closeLen, [
          cx.elt('MathMark', from, from + openLen),
          cx.elt('MathContent', from + openLen, closeFrom),
          cx.elt('MathMark', closeFrom, closeFrom + closeLen)
        ])
        cx.nextLine()
        cx.addElement(elt)
        return true
      }

      /*
       * 跨行:逐行找收尾标记。每行单独产出一个 MathContent,而不是让整段
       * 公式共用一个连续区间 —— 引用块里的行首 `> `、列表项的缩进都在
       * 文档位置上夹在公式中间,整段切片会把它们混进 TeX 源码。
       * 拼回源码时补换行,见下面的 mathSource()。
       */
      const segments: Array<{ from: number; to: number }> = [
        { from: from + openLen, to: cx.lineStart + line.text.length }
      ]
      let closeFrom = -1
      // depth < stack.length 表示引用/列表容器到此结束,不能把容器外的一行算进公式
      // (与 FencedCode 的循环条件同义)。
      while (cx.nextLine() && lineDepth(line) >= contextDepth(cx)) {
        const lineFrom = cx.lineStart + line.pos
        const idx = closeIndex(line.text, line.pos, fence)
        if (idx >= 0) {
          closeFrom = cx.lineStart + idx
          segments.push({ from: lineFrom, to: closeFrom })
          cx.nextLine()
          break
        }
        segments.push({ from: lineFrom, to: cx.lineStart + line.text.length })
      }

      const closed = closeFrom >= 0
      const end = closed ? closeFrom + closeLen : cx.prevLineEnd()
      const children = [cx.elt('MathMark', from, from + openLen)]
      for (const seg of segments) children.push(cx.elt('MathContent', seg.from, seg.to))
      if (closed) children.push(cx.elt('MathMark', closeFrom, closeFrom + closeLen))
      cx.addElement(cx.elt('MathBlock', from, end, children))
      return true
    },
    /*
     * 与开标记之前没有空行也照常工作:段落读到一行以开标记开头时就此收尾,
     * 下一轮块解析从这一行开始吞公式。去掉这条,`正文\n$$ ...` 里的 `+` 行
     * 仍会把段落拦腰截断(默认的 BulletList 中断先于块解析器生效)。
     */
    endLeaf(_cx, line) {
      return isMathFence(line, fence)
    }
  }
}

const mathBlockParser = createMathBlockParser(DOLLAR_FENCE)
const bracketMathBlockParser = createMathBlockParser(BRACKET_FENCE)

// ---------- 供渲染层读取公式源码 ----------

/**
 * MathBlock 的内容按行拆成多个 MathContent(见块解析器),这里取首尾两段的范围,
 * 用于「光标在公式内」时给整段源码加底色。
 */
export function mathContentRange(node: SyntaxNode): { from: number; to: number } | null {
  let first: SyntaxNode | null = null
  let last: SyntaxNode | null = null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'MathContent') continue
    if (!first) first = child
    last = child
  }
  return first && last ? { from: first.from, to: last.to } : null
}

/**
 * 拼接公式源码。MathBlock 每行一个 MathContent(行首容器标记不在区间里),
 * 这里补回换行;行内公式只有一个 MathContent,原样返回。
 */
export function mathSource(
  doc: { sliceString(from: number, to: number): string },
  node: SyntaxNode
): string {
  let tex = ''
  let first = true
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'MathContent') continue
    if (!first) tex += '\n'
    tex += doc.sliceString(child.from, child.to)
    first = false
  }
  return tex
}

export const mathExtension: MarkdownExtension = {
  defineNodes: [
    'InlineMath',
    'DisplayMath',
    { name: 'MathBlock', block: true },
    'MathContent',
    'MathMark'
  ],
  parseBlock: [bracketMathBlockParser, mathBlockParser],
  parseInline: [mathParser]
}
