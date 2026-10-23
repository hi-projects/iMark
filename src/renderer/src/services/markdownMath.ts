import type MarkdownIt from 'markdown-it'
import katex from 'katex'

/**
 * markdown-it 的 LaTeX 支持:行内 $...$ / \(...\) 与块级 $$...$$ / \[...\](可跨行)。
 *
 * 导出 HTML、扩展预览(renderMarkdownFragment)和编辑器表格单元格共用这一份规则 ——
 * 同一篇文档在编辑器里与导出后必须长得一样,公式尤其不能一处渲染、一处裸奔。
 * 这里只装语法和渲染器,html/linkify/highlight 等配置仍由调用方的实例决定。
 *
 * \[...\] 与 \(...\) 是 AI 模型和 TeX 文档更常用的写法。块级规则必须单独注册:
 * 公式体里以 `+` / `-` / `>` 开头的行会先被 markdown-it 的块解析器读成列表
 * (现象是公式没渲染、多出一个圆点),与编辑器侧的 math.ts 踩过的是同一个坑。
 */

const DOLLAR = 0x24
const BACKSLASH = 0x5c
const OPEN_PAREN = 0x28

export function installMath(md: MarkdownIt): void {
  /** 行内 $...$:不跨行,内容首尾不能是空白(与编辑器 math.ts 的 Lezer 规则一致) */
  md.inline.ruler.before('escape', 'imath_inline', (state, silent) => {
    const start = state.pos
    if (state.src.charCodeAt(start) !== DOLLAR) return false
    if (state.src.charCodeAt(start + 1) === DOLLAR) return false
    const max = state.posMax
    let i = start + 1
    if (i >= max || /\s/.test(state.src[i]!)) return false
    while (i < max) {
      const ch = state.src[i]!
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '\n') return false
      if (ch === '$') {
        if (/\s/.test(state.src[i - 1]!)) return false
        if (!silent) {
          const token = state.push('imath_inline', 'math', 0)
          token.content = state.src.slice(start + 1, i)
        }
        state.pos = i + 1
        return true
      }
      i++
    }
    return false
  })

  /**
   * 行内 \(...\):不跨行,内容首尾不能是空白。
   *
   * 必须排在 escape 之前 —— 否则 `\(` 会先被当成「转义后的左括号」,
   * 渲染成普通文本。
   */
  md.inline.ruler.before('escape', 'imath_inline_paren', (state, silent) => {
    const start = state.pos
    if (state.src.charCodeAt(start) !== BACKSLASH) return false
    if (state.src.charCodeAt(start + 1) !== OPEN_PAREN) return false
    const max = state.posMax
    let i = start + 2
    if (i >= max || /\s/.test(state.src[i]!)) return false
    while (i < max) {
      const ch = state.src[i]!
      if (ch === '\n') return false
      if (ch === '\\') {
        if (state.src[i + 1] === ')') {
          if (i === start + 2 || /\s/.test(state.src[i - 1]!)) return false
          if (!silent) {
            const token = state.push('imath_inline', 'math', 0)
            token.content = state.src.slice(start + 2, i)
          }
          state.pos = i + 2
          return true
        }
        i += 2
        continue
      }
      i++
    }
    return false
  })

  /** 块级 $$...$$(可跨行) */
  md.block.ruler.before('fence', 'imath_block', (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine]! + state.tShift[startLine]!
    const max = state.eMarks[startLine]!
    if (state.src.slice(startPos, startPos + 2) !== '$$') return false
    const firstText = state.src.slice(startPos, max)
    let lastLine = startLine
    let content: string
    const inlineClose = firstText.trim().length > 4 && firstText.trim().endsWith('$$')
    if (inlineClose) {
      content = firstText.trim().slice(2, -2)
    } else {
      const lines: string[] = []
      const firstRest = firstText.slice(2)
      if (firstRest.trim()) lines.push(firstRest)
      let found = false
      for (let n = startLine + 1; n < endLine; n++) {
        const ls = state.bMarks[n]! + state.tShift[n]!
        const le = state.eMarks[n]!
        const text = state.src.slice(ls, le)
        const idx = text.lastIndexOf('$$')
        if (idx >= 0 && text.slice(idx + 2).trim() === '') {
          lines.push(text.slice(0, idx))
          lastLine = n
          found = true
          break
        }
        lines.push(text)
      }
      if (!found) return false
      content = lines.join('\n')
    }
    if (silent) return true
    const token = state.push('imath_block', 'math', 0)
    token.block = true
    token.content = content.trim()
    token.map = [startLine, lastLine + 1]
    state.line = lastLine + 1
    return true
  })

  /**
   * 块级 \[...\](可跨行),与 $$ 用同一个 token / 渲染器。
   *
   * 收尾扫描不能像 $$ 那样跳过转义字符:这里的 `\]` 本身就是转义序列。
   */
  md.block.ruler.before('fence', 'imath_bracket_block', (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine]! + state.tShift[startLine]!
    const max = state.eMarks[startLine]!
    if (state.src.slice(startPos, startPos + 2) !== '\\[') return false
    const firstText = state.src.slice(startPos, max)
    let lastLine = startLine
    let content: string
    const inlineClose = firstText.trim().length > 4 && firstText.trim().endsWith('\\]')
    if (inlineClose) {
      content = firstText.trim().slice(2, -2)
    } else {
      const lines: string[] = []
      const firstRest = firstText.slice(2)
      if (firstRest.trim()) lines.push(firstRest)
      let found = false
      for (let n = startLine + 1; n < endLine; n++) {
        const ls = state.bMarks[n]! + state.tShift[n]!
        const le = state.eMarks[n]!
        const text = state.src.slice(ls, le)
        const idx = text.lastIndexOf('\\]')
        if (idx >= 0 && text.slice(idx + 2).trim() === '') {
          lines.push(text.slice(0, idx))
          lastLine = n
          found = true
          break
        }
        lines.push(text)
      }
      if (!found) return false
      content = lines.join('\n')
    }
    if (silent) return true
    const token = state.push('imath_block', 'math', 0)
    token.block = true
    token.content = content.trim()
    token.map = [startLine, lastLine + 1]
    state.line = lastLine + 1
    return true
  })

  md.renderer.rules.imath_inline = (tokens, idx) =>
    katex.renderToString(tokens[idx]!.content, {
      displayMode: false,
      throwOnError: false,
      output: 'html'
    })

  md.renderer.rules.imath_block = (tokens, idx) =>
    `<div class="katex-block">${katex.renderToString(tokens[idx]!.content, {
      displayMode: true,
      throwOnError: false,
      output: 'html'
    })}</div>`
}
