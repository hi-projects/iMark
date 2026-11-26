/**
 * 光标行行首的「+」按钮。
 *
 * 为什么是独立的 ViewPlugin,而不是塞进 wysiwyg/ 那套按语法树分发的规则里:
 * 那个扩展每次文档变更都要全量重建装饰,还带一段 IME 组合期的重映射分支;
 * 而这里只关心「光标在第几行」,两件事的生命周期完全不同,挂在一起只会互相拖累。
 *
 * 只**画**按钮,不决定菜单里有什么 —— 条目来自扩展贡献点(services/lineMenu.ts)。
 *
 * 按钮**不挂在 .cm-line 里**,而是 .cm-scroller 上的一个绝对定位覆盖层。
 * 它原来是一个零长的隐藏 widget:光标停在这一行时,行内 tile 会多出
 * widget + cm-widgetBuffer 两个零长子节点。CM 的 InlineCoordsScan 二分查找
 * 因此会漏掉行内公式左边的文字(列表圆点是 font-size:0 的零高矩形,被当成
 * 「在鼠标下方」而把搜索范围收窄在行首),`posAtCoords` 对公式左侧任意坐标
 * 都返回公式起点 —— 点击落点偏、拖选卡在公式左边缘。见
 * verify/inline-math-backward-select-harness.ts。
 */

import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Line } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import {
  closeLineMenu,
  lineMenuEntries,
  lineMenuRefreshEffect,
  lineMenuStore,
  openLineMenu
} from '../services/lineMenu'

/** 一次测量得到的位置:相对 .cm-scroller 的 padding 盒,和内容一起滚动 */
interface PlusSpot {
  line: number
  visible: boolean
  left: number
  top: number
  height: number
}

/**
 * 行首「+」的覆盖层。
 *
 * 位置按**光标行第一个文字行**的矩形算,并换算成滚动内容的坐标:覆盖层是
 * .cm-scroller 的绝对定位子元素,内容滚动时跟着一起走,不需要监听 scroll。
 * 窗口 / 字号 / 行宽 / 行距这些不产生编辑器事务的变化靠 ResizeObserver 兜底;
 * 装饰在后续更新里补上的版式类(段落裁边等)由 geometryChanged 触发重排。
 */
class LinePlusOverlay {
  private readonly anchor: HTMLElement
  private readonly button: HTMLButtonElement
  private readonly measureReq: {
    read: (view: EditorView) => PlusSpot
    write: (spot: PlusSpot) => void
  }
  private readonly resizeObserver: ResizeObserver
  private mounted = false
  private destroyed = false
  private scheduled = false
  private line = 1

  constructor(private readonly view: EditorView) {
    const anchor = document.createElement('span')
    anchor.className = 'line-plus-anchor'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'line-plus'
    btn.title = '插入内容'
    btn.setAttribute('aria-label', '插入内容')
    // 按住时别让编辑器丢焦点:丢了选区会跳、菜单也会跟着关掉
    btn.addEventListener('mousedown', e => e.preventDefault())
    btn.addEventListener('click', e => {
      e.preventDefault()
      openLineMenu(this.line, btn.getBoundingClientRect())
    })
    anchor.appendChild(btn)
    this.anchor = anchor
    this.button = btn
    this.measureReq = { read: v => this.spot(v), write: spot => this.apply(spot) }

    /*
     * 这些变化不产生编辑器事务,但会移动「+」:窗口缩放改变正文栏的水平居中,
     * 字号 / 行距 / 行宽设置改变文字行的高度或位置。内容尺寸一变就重新测量。
     */
    this.resizeObserver = new ResizeObserver(() => this.schedule())
    this.resizeObserver.observe(view.scrollDOM)
    this.resizeObserver.observe(view.contentDOM)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    // 光标一动就收起菜单:它属于「那一行」,行变了就不该还开着
    if (update.selectionSet && lineMenuStore.open) closeLineMenu()
    const refresh = update.transactions.some(tr =>
      tr.effects.some(e => e.is(lineMenuRefreshEffect))
    )
    /*
     * geometryChanged:装饰在**后一轮**更新里才加上的版式类(段落裁边、按需
     * 解析完成后的重建)也会改变文字行位置。只盯着 doc/selection 会漏掉它,
     * 表现为「+」停在裁边前的位置(实测差 5px = 半份行距)。
     */
    const relayout =
      update.docChanged || update.viewportChanged || update.geometryChanged || refresh
    if (!update.selectionSet && !relayout) return
    const state = update.state
    const line = state.doc.lineAt(state.selection.main.head)
    if (!this.visible(state, line)) {
      // 隐藏是纯粹的语法判断,可以同步做:光标进代码块 / 表格 / 引用时按钮立刻消失
      this.apply({ line: line.number, visible: false, left: 0, top: 0, height: 0 })
      return
    }
    /*
     * 光标在行内移动不改变按钮位置:同一行、按钮已经挂着时,只有版式变化
     * 才需要重新量。换行或第一次出现则必须重排。
     */
    if (!this.mounted || line.number !== this.line || relayout) {
      this.schedule()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver.disconnect()
    this.anchor.remove()
    this.mounted = false
  }

  /**
   * 排一次重排:微任务先落一次,再借 CM 的测量在布局稳定后校正。
   *
   * 不能只靠 requestMeasure —— 它要等下一帧,窗口被遮挡 / 没有动画帧时按钮
   * 会迟到甚至一直不出现(验收里表现为「换行后查不到 .line-plus」)。也不能
   * 只靠微任务 —— 文档刚变、CM 还没量完行高时,读到的坐标可能差几像素。
   *
   * 不能在 update 里直接读布局:会抛 "Reading the editor layout isn't allowed
   * during an update",CM 会把整个插件停掉。微任务在本次 dispatch 结束后执行,
   * 那时已经退出 update 状态。
   */
  private schedule(): void {
    if (this.destroyed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.destroyed) return
      this.apply(this.spot(this.view))
    })
    this.view.requestMeasure(this.measureReq)
  }

  /** 这一行该不该画「+」:纯语法判断,不读布局 */
  private visible(state: EditorState, line: Line): boolean {
    // 没有扩展贡献菜单条目时不画按钮 —— 免得点了弹出一个空菜单
    if (lineMenuEntries().length === 0) return false
    // 引用行不画:见 inBlockquote
    if (inBlockquote(state, line.from)) return false
    // 代码块 / 块级公式 / 表格里不画:见 NO_PLUS_NODES
    return !inNoPlusBlock(state, line.from, line.to)
  }

  /** 测量阶段:只读,不改 DOM */
  private spot(view: EditorView): PlusSpot {
    const state = view.state
    const line = state.doc.lineAt(state.selection.main.head)
    const hidden: PlusSpot = { line: line.number, visible: false, left: 0, top: 0, height: 0 }
    if (!this.visible(state, line)) return hidden
    /*
     * 用第一个文字行的矩形,而不是整条 .cm-line:折行时按钮要对齐第一行,
     * 不能落到整段中间。coordsAtPos 给的是文字行盒(text-box-trim 之后),
     * 正好也是按钮垂直居中的基准。
     *
     * 行首可能落在零高装饰上:无序列表的圆点由 font-size:0 / line-height:0
     * 的字符加伪元素画出来,coordsAtPos(line.from) 给的是基线处一个零高矩形
     * (标题的隐藏 `#` 同理)。拿它居中会把按钮放到基线下方。往后找第一个
     * 正常字形,用它的行盒。
     */
    const start = view.coordsAtPos(line.from)
    if (!start) return hidden
    let box = start
    if (box.bottom - box.top < 1) {
      for (let off = 1; off <= line.length && off <= 16; off++) {
        const next = view.coordsAtPos(line.from + off)
        if (next && next.bottom - next.top >= 1) {
          box = next
          break
        }
      }
    }
    /* 水平位置永远按行首算(零宽 rect 的 left 也是准的);只有垂直方向要躲开零高字形 */
    const scroller = view.scrollDOM
    const sRect = scroller.getBoundingClientRect()
    return {
      line: line.number,
      visible: true,
      left: start.left - sRect.left + scroller.scrollLeft,
      top: box.top - sRect.top + scroller.scrollTop,
      height: Math.max(box.bottom - box.top, 1)
    }
  }

  /** 写入阶段:只改 DOM。隐藏时把覆盖层摘下,查询 .line-plus 的人看到的就是「没有」 */
  private apply(spot: PlusSpot): void {
    if (this.destroyed) return
    this.line = spot.line
    if (!spot.visible) {
      if (this.mounted) {
        this.anchor.remove()
        this.mounted = false
      }
      return
    }
    this.button.dataset.line = String(spot.line)
    if (!this.mounted) {
      this.view.scrollDOM.appendChild(this.anchor)
      this.mounted = true
    }
    this.anchor.style.left = `${spot.left}px`
    this.anchor.style.top = `${spot.top}px`
    this.anchor.style.height = `${spot.height}px`
  }
}

/**
 * 某个位置是否落在引用里。
 *
 * 引用行用 margin-left: 1em 缩进、竖线画在正文栏左缘(见 editor.css),而「+」是
 * 相对正文栏绝对定位的 —— 在引用行上它会跟着右移 1em,正好挤在竖线与 `>` 之间。
 * 所以引用行整行不画按钮。
 *
 * 传**行首位置**而不是光标:光标贴在行尾时,位置正好落在 Blockquote 节点的右边界上,
 * resolveInner 的 side 有可能把它解析到节点外面去。
 */
function inBlockquote(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'Blockquote') return true
    node = node.parent
  }
  return false
}

/**
 * 这些块里不画行首「+」:代码块、块级公式,以及表格。
 *
 * 代码块里不画:菜单里全是 Markdown 块(表格 / 公式 / 引用…),插进代码里
 * 只会变成一段源码;而且代码块左侧那 1.25em 留白正好是按钮的落点,按钮会压在代码上。
 * 块级公式同理:公式是原子块,插入 Markdown 块会破坏公式,左侧留白也是按钮落点。
 *
 * 表格没有对应的「文档正文行」:单元格里的源码行被表格 widget 替换,光标在
 * 单元格里时按钮会贴在表格旁边,菜单动作的目标(表格还是单元格里的文字)也
 * 说不清;要插内容,把光标移到表格外的行上。
 */
const NO_PLUS_NODES = new Set(['FencedCode', 'CodeBlock', 'MathBlock', 'Table'])

/**
 * 这一行是否落在不该画「+」的块里(代码块 / 块级公式 / 表格)。
 *
 * 不能只拿行首 resolveInner:缩进代码块的节点从第 5 列才开始,行首落在节点外。
 * 用整行的范围去遍历,块内的每一行(包括空行)都会被覆盖到。
 */
function inNoPlusBlock(state: EditorState, from: number, to: number): boolean {
  let found = false
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (NO_PLUS_NODES.has(node.name)) {
        found = true
        return false
      }
      return undefined
    }
  })
  return found
}

const lineMenuPlugin = ViewPlugin.fromClass(LinePlusOverlay)

export function lineMenu(): Extension {
  return lineMenuPlugin
}
