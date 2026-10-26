import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import katexCssRaw from 'katex/dist/katex.min.css?raw'
import { installMath } from './markdownMath'
import { installCellLists } from './cellList'
import { mermaidErrorMessage, renderMermaid } from './mermaid'

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

// ---------- Mermaid 图表 ----------
//
// 围栏先渲染成占位 div,全文渲染完再把 SVG 填回去。mermaid.render 是异步的,
// 而 markdown-it 的 renderer 必须同步返回字符串;占位符里只放序号,放源码会被
// markdown-it 再转义一遍,取回来还要反解,反而更容易错。

interface MermaidEnv {
  mermaid?: string[]
}

const mermaidPlaceholder = (index: number): string =>
  `<div class="mermaid-diagram" data-mermaid-index="${index}"></div>`

const defaultFence = md.renderer.rules.fence!

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const lang = info.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (lang === 'mermaid') {
    const target = env as MermaidEnv
    const blocks = (target.mermaid ??= [])
    blocks.push(token.content)
    return `${mermaidPlaceholder(blocks.length - 1)}\n`
  }
  return defaultFence(tokens, idx, options, env, self)
}

// ---------- LaTeX 公式(markdown-it 内置无数学支持,规则见 ./markdownMath) ----------

installMath(md)
// 单元格里的单行列表:与编辑器共用同一份解析(services/cellList)
installCellLists(md)

const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fa; font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #24292f; line-height: 1.7; }
  article { max-width: 860px; margin: 0 auto; padding: 48px 56px 96px; background: #ffffff; min-height: 100vh; }
  h1, h2 { border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
  h1, h2, h3, h4, h5, h6 { font-weight: 650; margin: 1.4em 0 0.6em; line-height: 1.35; }
  /* 与编辑器同一套递减阶梯:h4 起每级 0.125em,别用浏览器默认(会越变越小) */
  h1 { font-size: 2em; }
  h2 { font-size: 1.75em; }
  h3 { font-size: 1.5em; }
  h4 { font-size: 1.375em; }
  h5 { font-size: 1.25em; }
  h6 { font-size: 1.125em; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: "Cascadia Code", Consolas, monospace; font-size: 0.9em; background: rgba(175,184,193,0.25); border-radius: 4px; padding: 0.15em 0.4em; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; font-size: 0.88em; }
  blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #d0d7de; color: #57606a; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
  th .cm-md-cell-list, td .cm-md-cell-list { margin: 0; padding: 0 0 0 1.15em; }
  /* 空格子没有行盒,会塌成一条 —— 用零宽空格把行盒立起来,和编辑器里一个道理 */
  th:empty::after, td:empty::after { content: '\\200b'; }
  /* 没有对齐标记的列是左对齐(GFM);不写的话浏览器会把 <th> 默认居中 */
  th { background: #f6f8fa; text-align: left; }
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
  .mermaid-diagram { margin: 1.2em 0; padding: 12px; border: 1px solid #d8dee4; border-radius: 8px; background: #f6f8fa; text-align: center; overflow-x: auto; }
  .mermaid-diagram svg { max-width: 100%; height: auto; }
  .mermaid-diagram-error { color: #cf222e; text-align: left; font-family: "Cascadia Code", Consolas, monospace; font-size: 0.9em; }
  .mermaid-diagram-error p { margin: 0; }
  .mermaid-diagram-error pre { background: transparent; padding: 0; margin: 0.6em 0 0; }
  ${MATH_BLOCK_CSS}
`

/**
 * 只返回正文片段，供扩展做「预览窗口」。
 *
 * 与导出共用同一个 markdown-it 实例（html:false、链接校验、KaTeX、Mermaid），
 * 但不带导出的整页模板与亮色 CSS —— 预览要跟着应用当前主题走，样式由扩展容器
 * 自己负责。HTML 原始标签在 md 里已被转义，扩展拿到的片段可以直接放进容器。
 */
export async function renderMarkdownFragment(
  source: string,
  theme: 'light' | 'dark' = 'light'
): Promise<string> {
  const env: MermaidEnv = {}
  let body = md.render(source, env)
  const mermaidBlocks = env.mermaid ?? []
  if (mermaidBlocks.length > 0) {
    const diagrams = await Promise.all(
      mermaidBlocks.map(async code => {
        try {
          return `<div class="mermaid-diagram">${await renderMermaid(code, theme)}</div>`
        } catch (err) {
          return (
            `<div class="mermaid-diagram mermaid-diagram-error">` +
            `<p>Mermaid 渲染失败:${md.utils.escapeHtml(mermaidErrorMessage(err))}</p>` +
            `<pre>${md.utils.escapeHtml(code)}</pre></div>`
          )
        }
      })
    )
    mermaidBlocks.forEach((_, index) => {
      body = body.replace(mermaidPlaceholder(index), diagrams[index] ?? '')
    })
  }
  return body
}

export async function renderHtml(source: string, title: string): Promise<string> {
  const env: MermaidEnv = {}
  let body = md.render(source, env)
  const mermaidBlocks = env.mermaid ?? []
  if (mermaidBlocks.length > 0) {
    // 导出统一用亮色主题:导出的 HTML 模板本身就是亮色,跟随应用当前主题会得到
    // 深色图配白底页面的怪结果。单块失败只毁那一块,不该让整份导出失败。
    const diagrams = await Promise.all(
      mermaidBlocks.map(async code => {
        try {
          return `<div class="mermaid-diagram">${await renderMermaid(code, 'light')}</div>`
        } catch (err) {
          return (
            `<div class="mermaid-diagram mermaid-diagram-error">` +
            `<p>Mermaid 渲染失败:${md.utils.escapeHtml(mermaidErrorMessage(err))}</p>` +
            `<pre>${md.utils.escapeHtml(code)}</pre></div>`
          )
        }
      })
    )
    mermaidBlocks.forEach((_, index) => {
      body = body.replace(mermaidPlaceholder(index), diagrams[index] ?? '')
    })
  }
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
