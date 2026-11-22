import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { findConflictBlocks } from './conflict'
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
  // 合并冲突里的 `=======` 会被解析成 Setext 标题下划线,`<<<<<<< HEAD` 随之
  // 变成一条标题。冲突期间它不该出现在大纲里 —— 那是一条临时标记,不是章节。
  const conflicts = findConflictBlocks(state.doc)
  const inConflict = (pos: number): boolean =>
    conflicts.some(block => pos >= block.from && pos <= block.to)
  tree.iterate({
    from: 0,
    to: len,
    enter: node => {
      if (inConflict(node.from)) return
      let level: number | null = null
      if (node.name.startsWith('ATXHeading')) {
        level = Number(node.name.slice(-1))
      } else if (node.name === 'SetextHeading1') {
        level = 1
      } else if (node.name === 'SetextHeading2') {
        /*
         * 单横线不是标题下划线,是「正文正下方敲下的列表符号」:`阿\n-` 在
         * CommonMark 里解析成 SetextHeading2,但编辑区把它画成正文 + 圆点
         * (见 wysiwyg/rules.ts 的 isLoneDashSetext)。大纲也得一致,否则
         * 刚输入一个 `-` 就凭空多出一条二级标题。
         */
        const mark = node.node.getChild('HeaderMark')
        if (mark && state.doc.sliceString(mark.from, mark.to) === '-') return
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

/** 点击大纲跳转时,标题文字停在视口顶边下方多少像素(见 jumpToHeading) */
const JUMP_MARGIN = 24

/**
 * 点击大纲后的高亮钉子。
 *
 * 不能只按「视口顶边所在的章节」判定:跳转把标题停在视口顶边下方 24px,标题行
 * 自己的上留白还会把行盒再往上抬一截,视口顶边那一小段仍旧属于上一条 ——
 * 点了哪条偏偏不高亮哪条。文档末尾的标题更极端:底部留了 40vh 余量,它根本
 * 滚不到顶边,按位置算会一直落回前面某条。
 *
 * 解除看滚动位置:跳转后真正落定时的第一帧记下落点,之后滚动位置离开落点
 * 就是用户在滚,回到滚动跟随。切换标签 / 文档变化时由调用方 clearOutlinePin。
 */
let pinned: { from: number; landing: number | null } | null = null

export function clearOutlinePin(): void {
  pinned = null
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
  // 顶边下方 JUMP_MARGIN 这一段也算当前章节:点击大纲跳转正好把标题停在这里
  // (标题行自己的上留白还会把行盒再往上抬几个像素)。不算进来的话,点完轻轻
  // 一滚,高亮就翻回上一条。
  return view.lineBlockAtHeight(scrolled + JUMP_MARGIN).from
}

/** 滚动跟随:视口顶部所在章节的标题高亮 */
export function updateActiveOutline(view: EditorView): void {
  const items = activeTab()?.outline ?? []
  if (items.length === 0) {
    appStore.outlineActive = null
    return
  }
  // 点过大纲:在被点的那一条上停住,直到用户自己滚动(见 pinned)
  if (pinned) {
    appStore.outlineActive = pinned.from
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

/** 跳转后的第一次滚动是它自己造成的,记下落点;之后的滚动离开落点就解除钉子 */
function settlePinnedOutline(view: EditorView): void {
  if (!pinned) return
  const top = view.scrollDOM.scrollTop
  if (pinned.landing == null) pinned.landing = top
  else if (Math.abs(top - pinned.landing) > 1) pinned = null
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
        settlePinnedOutline(this.view)
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
  // 先钉住高亮再滚:跳转落点不能指望「视口顶边所在章节」的判定(见 pinned)
  pinned = { from: item.from, landing: null }
  appStore.outlineActive = item.from
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: JUMP_MARGIN })
  })
  view.focus()
}
