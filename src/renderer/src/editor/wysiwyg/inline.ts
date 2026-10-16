import MarkdownIt from 'markdown-it'

/**
 * 行内片段渲染(目前只有表格单元格在用)。
 *
 * 刻意不复用 services/exportHtml.ts 里那个实例:那边顺带 import 了 katex、highlight.js
 * 和一份内联的 KaTeX CSS,而编辑器渲染几个单元格不该被拖上这些。
 *
 * 配置必须与导出那边保持一致 —— 同一篇文档在编辑器里和在导出的 HTML 里长得不一样,
 * 是比"少支持一种语法"严重得多的问题:
 *   - html:false —— 原始 HTML 按字面显示(导出的 HTML 要能安全地发给别人,编辑器同理);
 *   - linkify:true —— 裸 URL 两边都认。
 */
const md = new MarkdownIt({ html: false, linkify: true })

/**
 * 单元格原文 → 行内 HTML。输出可直接赋给 innerHTML:
 * markdown-it 在 html:false 下会转义原始 HTML,且默认的 validateLink 会挡掉
 * javascript: / vbscript: / file: 这类协议。
 */
export function renderInline(text: string): string {
  return md.renderInline(text.trim())
}
