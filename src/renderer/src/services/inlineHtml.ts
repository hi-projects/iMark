import type MarkdownIt from 'markdown-it'

/**
 * 行内 HTML 白名单。
 *
 * 只收"只影响排版、不能执行任何东西"的标签,且**属性一律丢弃** —— 导出的
 * HTML 是要发给别人看的,事件属性 / href / style 都可能成为注入点。不在名单
 * 里的标签继续按字面转义显示(和 html:false 时代一致):`<div>` / `<script>`
 * 不会被当成 HTML 渲染。
 *
 * 编辑器(editor/wysiwyg/rules.ts)与导出(services/exportHtml.ts)共用这一份
 * 名单,两边看到的标签集合必须完全一致。
 */
export const INLINE_HTML_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'sub',
  'sup',
  'kbd',
  'code',
  'span',
  'br'
] as const

const INLINE_HTML_TAG_SET = new Set<string>(INLINE_HTML_TAGS)

/** 空元素:没有结束标签。目前只有 <br> 需要。 */
const VOID_HTML_TAGS = new Set(['br'])

export interface ParsedInlineTag {
  name: string
  closing: boolean
  /** 空元素(<br>),没有结束标签 */
  void: boolean
}

/**
 * 从字符串**开头**匹配一个完整的开始/结束标签。
 *
 * 属性部分允许出现在标签里,但只用来定位 `>`;属性本身既不渲染也不保留。
 * 含 `<` / `>` / 换行的"属性"直接不认 —— 宁可让它按源码显示,也不做模糊猜测。
 */
const TAG_AT_START = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>\n]*?)?)\s*(\/?)\s*>/

function fromMatch(m: RegExpExecArray): ParsedInlineTag | null {
  const name = m[2]!.toLowerCase()
  const closing = m[1] === '/'
  const selfClosing = m[4] === '/'
  if (VOID_HTML_TAGS.has(name)) {
    // </br> 不是合法标签,自闭合与否都算 <br>
    if (closing) return null
    return { name, closing: false, void: true }
  }
  // <b/> 这类"自闭合的非空元素"没有意义,交给源码态显示
  if (selfClosing) return null
  if (!INLINE_HTML_TAG_SET.has(name)) return null
  return { name, closing, void: false }
}

/** 整段字符串恰好是一个白名单标签时返回解析结果(编辑器语法树里的 HTMLTag 节点用) */
export function parseInlineTag(source: string): ParsedInlineTag | null {
  const m = TAG_AT_START.exec(source)
  if (!m || m[0].length !== source.length) return null
  return fromMatch(m)
}

/** 规范化后的输出(去掉所有属性,标签名小写) */
export function canonicalInlineTag(tag: ParsedInlineTag): string {
  return tag.closing ? `</${tag.name}>` : `<${tag.name}>`
}

/**
 * 给 markdown-it 装一条行内规则,只把白名单标签转成 html_inline token。
 *
 * 刻意**不打开** `html: true`:那会让 markdown-it 自带的 html_block 规则生效,
 * `<div>` 开头的段落会把后面的 Markdown 整段吞成原始 HTML 块,现有文档的
 * 渲染结果会跟着变。这里只补行内识别,块级 HTML 维持"按字面显示"。
 */
export function installInlineHtml(md: MarkdownIt): void {
  md.inline.ruler.before('text', 'imark_inline_html', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false
    const m = TAG_AT_START.exec(state.src.slice(state.pos))
    if (!m) return false
    const tag = fromMatch(m)
    if (!tag) return false
    if (!silent) {
      const token = state.push('html_inline', '', 0)
      token.content = canonicalInlineTag(tag)
    }
    state.pos += m[0].length
    return true
  })
}
