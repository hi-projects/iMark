import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
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
  /*
   * 必须用 `ensureSyntaxTree` 的**返回值**,不能接着读 `syntaxTree(state)`:
   * 后者是 Language.state 字段里的快照,只在事务里更新;新建 state 时它只解析
   * 前 3000 个字符(见 @codemirror/language 的 LanguageState.init)。拿它扫全文,
   * 超过 3000 字符的文档大纲就会被截断 —— 实测 10KB 的笔记只显示到第 80 行。
   */
  const len = state.doc.length
  let tree = ensureSyntaxTree(state, len, 100) ?? syntaxTree(state)
  // 超大文档(约 70KB)一轮 100ms 解析不完,再续两轮;仍不完整就先用已解析的部分
  for (let i = 0; i < 2 && tree.length < len; i++) {
    tree = ensureSyntaxTree(state, len, 100) ?? tree
  }

  const items: OutlineItem[] = []
  tree.iterate({
    from: 0,
    to: len,
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

/**
 * 视口顶边所在的文档位置(用像素几何,不用预渲染范围)。
 *
 * 规则:视口最高处落在哪一部分,就高亮哪一部分的标题 —— 即最后一个
 * 起点不高于视口顶边的标题。
 *
 * 不能用 `visibleRanges[0].from`:那是**预渲染**范围,CM 会额外渲染视口上方
 * 最多 1000px(约几十行)的内容。把它当"当前看到的位置",大纲高亮会明显慢半拍 ——
 * 屏幕上已经是 4.2,侧栏还停在 3.2。
 */
function visibleTop(view: EditorView): number {
  // documentTop 是首行顶边的屏幕坐标;与滚动容器顶边相减就是已滚过的像素
  const scrolled = view.scrollDOM.getBoundingClientRect().top - view.documentTop
  if (scrolled <= 0) return 0
  return view.lineBlockAtHeight(scrolled).from
}

/** 滚动跟随:视口顶部所在章节的标题高亮 */
export function updateActiveOutline(view: EditorView): void {
  const items = activeTab()?.outline ?? []
  if (items.length === 0) {
    appStore.outlineActive = null
    return
  }
  const top = visibleTop(view)
  let active: OutlineItem | undefined
  for (const it of items) {
    if (it.from <= top) active = it
    else break
  }
  appStore.outlineActive = active ? active.from : null
}

/**
 * 每帧最多结算一次大纲激活项。
 *
 * 只在 updateListener 里跟 `viewportChanged` 不够:文档较短、整篇都在视口里时,
 * 滚动不会改变视口范围,事件根本不来;而长文档里视口更新也晚于手指。scroll
 * 事件不冒泡,domEventHandlers 挂在 contentDOM 上收不到,只能直接监听滚动容器。
 */
export const outlineFollower = ViewPlugin.fromClass(
  class {
    private frame = 0

    constructor(readonly view: EditorView) {
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    }

    private onScroll = (): void => {
      if (this.frame) return
      this.frame = requestAnimationFrame(() => {
        this.frame = 0
        updateActiveOutline(this.view)
      })
    }

    destroy(): void {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      if (this.frame) cancelAnimationFrame(this.frame)
    }
  }
)

/** 点击大纲跳转:光标定位到标题起始并滚动到视口上部 */
export function jumpToHeading(view: EditorView, item: OutlineItem): void {
  const pos = Math.min(item.from, view.state.doc.length)
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 })
  })
  view.focus()
}
