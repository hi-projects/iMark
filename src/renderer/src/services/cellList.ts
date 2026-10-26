import type MarkdownIt from 'markdown-it'

/**
 * 表格单元格里的「单行列表」。
 *
 * GFM 的一个单元格在源码里只能占一行,块级列表没有位置:`- a;- b` 只会被当成
 * 一行普通文字。可现实里大家就是这么往格子里粘列表的 —— 粘进来的换行还会被
 * normalizeCellText 折成空格,眼睛看到的就是一串带 `-` 的源码。
 *
 * 这里做一个受控的语法糖,只对**以列表标记开头**的单元格生效:
 *   - 条目边界 = 行首 / `;` `；` / 空白处再次出现的列表标记;
 *   - 每个条目仍走行内渲染(粗体、链接、行内公式都照旧);
 *   - `-`/`+` 允许贴着正文(`-条目`),但 `-5℃`、`10 - 5`、`$a - b$`
 *     这类负号/减号/公式不会被误判。
 *
 * 编辑器和导出的 HTML 共用这一份判断 —— 两边看到的是同一个列表。
 */

export interface CellList {
  ordered: boolean
  start: number
  items: string[]
}

interface Marker {
  /** 标记(不含边界字符)在原文里的起点 */
  at: number
  /** 条目正文的起点(跳过标记后的空白) */
  contentAt: number
  marker: string
}

/**
 * 标记出现在这些位置才算条目边界:行首、空白后、分号后。
 * `•` 也认 —— 从浏览器复制渲染列表时,正文里常常就是圆点本身。
 */
const MARKER_RE = /(?:^|[\s;；])([-+*•]|\d{1,9}[.)、])/g

/** 从标记往前跳过空白,看是不是分号边界(`； - 条目` 也算) */
function precededBySemicolon(text: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(text[i]!)) i--
  return i >= 0 && /[;；]/.test(text[i]!)
}

/**
 * 标记后面是不是真的跟着条目正文。
 *
 * 标准 Markdown 要求 `- 条目`,但中文里 `-条目` 也很常见,粘贴进来的列表
 * 还常常被折成 `；-条目`。所以 `-`/`+` 允许直接接非空白、非数字的正文。
 * 另外几条防误判:
 *   - 数字标记必须跟空白,否则 `2020、2021` 这类日期会中招;
 *   - `-5℃` / `10 - 5` 这种负号、减号靠"正文不能以数字开头"挡掉
 *     (行首除外:一格以 `- 5 度` 开头,本来就更像列表);
 *   - 行内的 `*` / `+` 只认分号边界,否则 `3 * 4`、`a + b` 会被拆成条目。
 */
function markerHasBody(text: string, at: number, marker: string, after: string): boolean {
  if (after === '' || /^\d/.test(after)) return false
  const atStart = at === 0
  if (!atStart && (marker === '*' || marker === '+') && !precededBySemicolon(text, at)) {
    return false
  }
  if (/\s/.test(after)) {
    // 分号后面是明确的条目边界,`；- 10 个` 仍是列表;没有分号时 `10 - 5` 更像减号
    if (!atStart && marker === '-' && !precededBySemicolon(text, at)) {
      let i = at + marker.length
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (/\d/.test(text[i] ?? '')) return false
    }
    return true
  }
  return marker === '-' || marker === '+'
}

/** 行内代码 / 数学里的 ` - ` 是内容,不是列表标记 */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]*?\$/g,
    /\\\([\s\S]*?\\\)/g,
    /`[^`\n]*?`/g
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0
      ranges.push([at, at + match[0].length])
    }
  }
  return ranges
}

function splitCellList(raw: string): CellList | null {
  const text = raw.trim()
  if (!text || !/^[-+*0-9]/.test(text)) return null

  const ranges = protectedRanges(text)
  const markers: Marker[] = []
  for (const match of text.matchAll(MARKER_RE)) {
    const marker = match[1]!
    const at = (match.index ?? 0) + match[0].length - marker.length
    if (ranges.some(([from, to]) => at >= from && at < to)) continue
    if (!markerHasBody(text, at, marker, text[at + marker.length] ?? '')) continue
    let contentAt = at + marker.length
    while (contentAt < text.length && /\s/.test(text[contentAt]!)) contentAt++
    markers.push({ at, contentAt, marker })
  }

  // 只认「整格以列表标记开始」的内容:正文中间偶然出现的 `- ` 不当列表
  if (markers.length === 0 || markers[0]!.at !== 0) return null

  const items = markers.map((marker, index) => {
    const end = markers[index + 1]?.at ?? text.length
    // 条目末尾的分号是分隔符,不是内容(和 `;` 边界一致地丢掉)
    return text
      .slice(marker.contentAt, end)
      .trim()
      .replace(/[;；]\s*$/, '')
      .trim()
  })

  const number = /^(\d{1,9})/.exec(markers[0]!.marker)
  return {
    ordered: number !== null,
    start: number ? Math.max(1, Number.parseInt(number[1]!, 10)) : 1,
    items
  }
}

/** 列表 HTML。条目渲染器由调用方给:编辑器与导出的 markdown-it 实例各自渲染 */
function cellListHtml(list: CellList, renderItem: (text: string) => string): string {
  const tag = list.ordered ? 'ol' : 'ul'
  const start = list.ordered && list.start > 1 ? ` start="${list.start}"` : ''
  const items = list.items.map(item => `<li>${renderItem(item)}</li>`).join('')
  return `<${tag}${start} class="cm-md-cell-list">${items}</${tag}>`
}

export { splitCellList, cellListHtml }

/**
 * 导出/预览用的 markdown-it 插件。
 *
 * 表格的每个单元格是一个 block 级 `inline` token(前一个兄弟是 th_open/td_open)。
 * 命中列表时把它的 children 换成一个 html_inline:markdown-it 在 html:false 下
 * 不会把用户写的 HTML 变成 html_inline,这里注入的是我们已经转义过的内容。
 */
export function installCellLists(md: MarkdownIt): void {
  md.core.ruler.push('imark_cell_lists', state => {
    const tokens = state.tokens
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.type !== 'inline') continue
      const open = tokens[i - 1]
      if (open?.type !== 'th_open' && open?.type !== 'td_open') continue
      const list = splitCellList(token.content)
      if (!list) continue
      const htmlToken = new state.Token('html_inline', '', 0)
      htmlToken.content = cellListHtml(list, item => md.renderInline(item))
      token.children = [htmlToken]
    }
  })
}
