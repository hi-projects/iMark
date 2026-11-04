/**
 * 表格列宽指令。
 *
 * GFM 没有列宽语法,拖出来的宽度只能由 iMark 自己约定:紧贴表格上方写一行
 * HTML 注释
 *
 *   <!-- imark:table-widths 20% 45% 35% -->
 *
 * 其他 Markdown 渲染器会把它当普通 HTML 注释忽略,文档照样能打开;没有这行
 * 注释的表格维持内容自适应。数值是**百分比**,总和按 100 归一化 —— 存像素
 * 的话换个窗口宽度就失真了。
 *
 * 编辑器(wysiwyg/rules.ts)、表格 widget(wysiwyg/widgets.ts)与导出
 * (services/exportHtml.ts)共用这一份解析/格式化规则。
 */

const DIRECTIVE_RE = /<!--\s*imark:table-widths\s+([\d.]+%?(?:[\s,]+[\d.]+%?)*)\s*-->/i

export interface ParsedWidthsLine {
  /** 归一化后的百分比(总和 100) */
  widths: number[]
  /** 指令文本在行内的起止偏移(渲染态只隐藏指令本身,不碰容器前缀) */
  from: number
  to: number
}

/** 一行源码是不是「只有一条列宽指令」(允许前置容器标记 `> ` 与缩进) */
export function parseWidthsDirectiveLine(lineText: string): ParsedWidthsLine | null {
  const match = DIRECTIVE_RE.exec(lineText)
  if (!match) return null
  const before = lineText.slice(0, match.index)
  const after = lineText.slice(match.index + match[0].length)
  // 行内只允许指令 + 容器前缀/空白。混了正文就不算指令,免得误吞用户内容。
  if (!/^[\s>]*$/.test(before) || !/^\s*$/.test(after)) return null
  const widths = parseWidthValues(match[1] ?? '')
  if (!widths) return null
  return { widths, from: match.index, to: match.index + match[0].length }
}

export function parseWidthValues(raw: string): number[] | null {
  const values = raw
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => Number.parseFloat(part.replace(/%$/, '')))
  if (values.length === 0) return null
  if (values.some(v => !Number.isFinite(v) || v <= 0)) return null
  return normalizeWidths(values)
}

/** 按总和归一化到 100;数值无意义时返回 null */
export function normalizeWidths(widths: number[]): number[] | null {
  if (widths.length === 0) return null
  if (widths.some(w => !Number.isFinite(w) || w <= 0)) return null
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (!(total > 0)) return null
  return widths.map(w => (w / total) * 100)
}

/**
 * 把源码里的宽度数量对齐到当前列数。
 *
 * 手改源码或增删列后长度可能对不上:多了就截断,少了就把剩余份额平分给缺的列。
 * 这样即便条目数量被人为改坏,表格也不会整块退回内容自适应。
 */
export function fitWidths(widths: number[], columns: number): number[] | null {
  if (columns <= 0) return null
  if (widths.length >= columns) return normalizeWidths(widths.slice(0, columns))
  const sum = widths.reduce((total, w) => total + w, 0)
  const missing = columns - widths.length
  const rest = Math.max(0, 100 - sum)
  const each = rest > 0 ? rest / missing : 100 / columns
  return normalizeWidths([...widths, ...Array<number>(missing).fill(each)])
}

/** 写回源码的一行(不含行首容器前缀,调用方负责拼) */
export function formatWidthsDirective(widths: number[]): string {
  const normalized = normalizeWidths(widths) ?? widths
  const rounded = normalized.map(w => Math.max(0.1, Math.round(w * 10) / 10))
  // 四舍五入可能让总和差 0.1:把误差补到最后一列,源码看起来才是整 100%。
  // 仍要保底 0.1 —— 写进源码的 0% 会被解析器判成非法值,整条指令就失效了。
  const sum = rounded.reduce((total, w) => total + w, 0)
  const last = rounded.length - 1
  if (last >= 0) rounded[last] = Math.max(0.1, Math.round((rounded[last]! + (100 - sum)) * 10) / 10)
  return `<!-- imark:table-widths ${rounded.map(formatPercent).join(' ')} -->`
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text}%`
}
