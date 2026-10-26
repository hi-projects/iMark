import MarkdownIt from 'markdown-it'
import { installMath } from '../../services/markdownMath'
import { cellListHtml, splitCellList } from '../../services/cellList'

/**
 * 行内片段渲染(目前只有表格单元格在用)。
 *
 * 刻意不复用 services/exportHtml.ts 里那个实例:那边顺带 import 了 highlight.js
 * 和一份内联的 KaTeX CSS,而编辑器渲染几个单元格不该被拖上这些。数学规则则必须
 * 与导出共用(markdownMath)—— 单元格里的 $...$ 不能只有正文编辑器认识。
 *
 * 配置必须与导出那边保持一致 —— 同一篇文档在编辑器里和在导出的 HTML 里长得不一样,
 * 是比"少支持一种语法"严重得多的问题:
 *   - html:false —— 原始 HTML 按字面显示(导出的 HTML 要能安全地发给别人,编辑器同理);
 *   - linkify:true —— 裸 URL 两边都认。
 *
 * 另外支持「单行列表」(见 services/cellList):单元格以 `- ` / `1. ` 开头时,
 * 以分号或空白分隔的条目渲染成 <ul>/<ol>。导出插件用的是同一份判断。
 */
const md = new MarkdownIt({ html: false, linkify: true })
installMath(md)

/**
 * 单元格原文 → 行内 HTML。输出可直接赋给 innerHTML:
 * markdown-it 在 html:false 下会转义原始 HTML,且默认的 validateLink 会挡掉
 * javascript: / vbscript: / file: 这类协议。
 */
export function renderInline(text: string): string {
  const trimmed = text.trim()
  const list = splitCellList(trimmed)
  if (list) return cellListHtml(list, item => md.renderInline(item))
  return md.renderInline(trimmed)
}
