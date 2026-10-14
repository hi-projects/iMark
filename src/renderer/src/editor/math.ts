import type { InlineContext, InlineParser, MarkdownExtension } from '@lezer/markdown'

/**
 * LaTeX 公式语法扩展:$行内$ 与 $$块级$$(可跨行)。
 *
 * 用 Lezer 的行内解析器而不是正则扫描——代码块/行内代码里的 $ 不会被误判,
 * 转义 \$ 也由 Escape 解析器自然处理。
 */

const DOLLAR = 36
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

/** 块级公式 $$...$$:可跨行 */
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
  // 排在 Emphasis 之前:公式内容不应被 * _ 之类的强调解析拆开
  before: 'Emphasis',
  parse(cx, next, pos) {
    if (next !== DOLLAR) return -1
    if (cx.char(pos + 1) === DOLLAR) {
      // $$$ 不处理(留给普通文本)
      return cx.char(pos + 2) === DOLLAR ? -1 : parseDisplayMath(cx, pos)
    }
    return parseInlineMath(cx, pos)
  }
}

export const mathExtension: MarkdownExtension = {
  defineNodes: ['InlineMath', 'DisplayMath', 'MathContent', 'MathMark'],
  parseInline: [mathParser]
}
