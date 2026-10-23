import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { activeTab, appStore, type OutlineItem } from '../stores/app'

/** 去掉行内标记,得到标题纯文本 */
function plainHeadingText(raw: string): string {
  return raw
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s*#+\s*$/, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
}

/**
 * 从语法树提取全文档标题(ATX + Setext)。
 * 用语法树而非正则扫描,避免代码块/引用内的 `#` 误判。
 */
export function extractOutline(state: EditorState): OutlineItem[] {
  // 全文档解析有界强解析;markdown 解析快,100ms 预算足够覆盖常规文档
  ensureSyntaxTree(state, state.doc.length, 100)
  const items: OutlineItem[] = []
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: node => {
      let level: number | null = null
      if (node.name.startsWith('ATXHeading')) {
        level = Number(node.name.slice(-1))
      } else if (node.name === 'SetextHeading1') {
        level = 1
      } else if (node.name === 'SetextHeading2') {
        level = 2
      }
      if (level == null) return
      // SetextHeading 的 node 覆盖下划线行,只取首行文本;ATX 首行即整行
      const line = state.doc.lineAt(node.from)
      const text = plainHeadingText(line.text)
      items.push({ level, text: text || '(无标题文本)', from: node.from, line: line.number })
    }
  })
  return items
}

/** 滚动跟随:视口顶部所在章节的标题高亮 */
export function updateActiveOutline(view: EditorView): void {
  const items = activeTab()?.outline ?? []
  if (items.length === 0) {
    appStore.outlineActive = null
    return
  }
  const top = view.visibleRanges[0]?.from ?? 0
  let active: OutlineItem | undefined
  for (const it of items) {
    if (it.from <= top) active = it
    else break
  }
  appStore.outlineActive = active ? active.from : null
}

/** 点击大纲跳转:光标定位到标题起始并滚动到视口上部 */
export function jumpToHeading(view: EditorView, item: OutlineItem): void {
  const pos = Math.min(item.from, view.state.doc.length)
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 })
  })
  view.focus()
}
