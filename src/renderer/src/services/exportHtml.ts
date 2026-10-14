import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import katex from 'katex'
import katexCssRaw from 'katex/dist/katex.min.css?raw'

/** KaTeX 的字体走 CDN(导出文件给浏览器打开,内联 CSS 只保留字体外链) */
const KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/'
const KATEX_CSS = katexCssRaw.replace(/url\((['"]?)fonts\//g, `url($1${KATEX_CDN}fonts/`)

/** 块级公式的外层容器(KaTeX 自带 .katex-display 负责居中) */
const MATH_BLOCK_CSS = '.katex-block { margin: 1.2em 0; overflow-x: auto; }'

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        /* 落到默认转义 */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
  }
})

// ---------- LaTeX 公式(markdown-it 内置无数学支持,这里补最小实现) ----------

const DOLLAR = 0x24

/** 行内 $...$:与编辑器解析规则保持一致(不跨行,首尾非空白) */
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

md.renderer.rules.imath_inline = (tokens, idx) =>
  katex.renderToString(tokens[idx]!.content, { displayMode: false, throwOnError: false, output: 'html' })

md.renderer.rules.imath_block = (tokens, idx) =>
  `<div class="katex-block">${katex.renderToString(tokens[idx]!.content, {
    displayMode: true,
    throwOnError: false,
    output: 'html'
  })}</div>`

const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fa; font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #24292f; line-height: 1.7; }
  article { max-width: 860px; margin: 0 auto; padding: 48px 56px 96px; background: #ffffff; min-height: 100vh; }
  h1, h2 { border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
  h1, h2, h3, h4, h5, h6 { font-weight: 650; margin: 1.4em 0 0.6em; line-height: 1.35; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: "Cascadia Code", Consolas, monospace; font-size: 0.9em; background: rgba(175,184,193,0.25); border-radius: 4px; padding: 0.15em 0.4em; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 0.88em; }
  blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #d0d7de; color: #57606a; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
  th { background: #f6f8fa; }
  img { max-width: 100%; }
  hr { border: none; border-top: 2px solid #d8dee4; margin: 2em 0; }
  .hljs { color: #24292f; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: #cf222e; }
  .hljs-string, .hljs-regexp, .hljs-addition { color: #0a3069; }
  .hljs-number, .hljs-built_in, .hljs-attr { color: #0550ae; }
  .hljs-comment, .hljs-quote { color: #6e7781; font-style: italic; }
  .hljs-title, .hljs-title.function_, .hljs-name { color: #8250df; }
  .hljs-type, .hljs-class .hljs-title { color: #953800; }
  .hljs-deletion { color: #82071e; }
  ${MATH_BLOCK_CSS}
`

export function renderHtml(source: string, title: string): string {
  const body = md.render(source)
  const safeTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${EXPORT_CSS}</style>
<style>${KATEX_CSS}</style>
</head>
<body>
<article>
${body}
</article>
</body>
</html>
`
}
