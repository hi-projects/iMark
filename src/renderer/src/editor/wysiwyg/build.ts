import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { ChangeDesc, Range } from '@codemirror/state'
import { applyRule, type LinkInfo, type RuleContext } from './rules'
import { caretOutsideRenderedTable, keepCaretOutOfTables } from './widgets'
import { getDocDir } from '../../stores/app'
import { api } from '../../services/api'

const MAX_RETRY = 20

export class WysiwygPlugin {
  decorations: DecorationSet = Decoration.none
  atomicSet: DecorationSet = Decoration.none
  links: LinkInfo[] = []

  private pendingRetry = false
  private retryScheduled = false
  private retryCount = 0
  private guardScheduled = false
  /** 本次光标移动之前的落点(用于判断是朝表格上方还是下方走) */
  private guardFromHead: number | null = null
  /** 组合进行中(以 compositionstart/end 事件为准,比 view.composing 更早、更稳) */
  private composing = false
  private themeObserver: MutationObserver | null = null

  constructor(readonly view: EditorView) {
    this.rebuild()
    this.scheduleCaretGuard()
    /*
     * 主题切换只改 <html data-theme> 上的 CSS 变量,不会产生编辑器事务。
     * 表格/公式/图片全靠 CSS 变量就能跟着变,但 Mermaid 的配色是渲染时烘进 SVG 的 ——
     * 不重建装饰就永远是旧主题。观察属性变化,借 pendingRetry 走一次完整重建;
     * MermaidWidget.eq() 里带了 theme,旧 widget 会被新主题的替换掉。
     */
    this.themeObserver = new MutationObserver(() => {
      this.pendingRetry = true
      try {
        this.view.dispatch({})
      } catch {
        /* 视图已销毁 */
      }
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }

  destroy(): void {
    this.themeObserver?.disconnect()
    this.themeObserver = null
  }

  update(update: ViewUpdate): void {
    // IME 组合期间不重建装饰(重建会打断中文输入),但必须把已有装饰按本次变更平移:
    // CM6 在组合中就会把上屏文字作为变更派发(userEvent input.type.compose),
    // 装饰原地不动就会与文档错位——表现为标记/widget 乱串、内容出现在错误位置,
    // 严重时平移后的 replace 恰好跨行,还会触发 CM 的
    // "Decorations that replace line breaks may not be specified via plugins" 断言,
    // 把视图内部 DOM 结构搞坏。compositionend 后的下一次 update 再整体重建。
    //
    // 用自己维护的 this.composing 而不是只看 view.composing:compositionstart 到
    // 第一笔预编辑文字合进文档之间,CM 的 composing 还是 0(见 observers.compositionstart),
    // 这段时间里任何一次选区 update 都不该重建 —— 重建会打断正在进行的组合。
    if (this.composing || this.view.composing) {
      if (update.docChanged) this.remap(update.changes)
      return
    }
    if (update.docChanged || update.viewportChanged || update.selectionSet || this.pendingRetry) {
      this.pendingRetry = false
      this.rebuild()
      // 把"移动之前"的光标位置交给护栏:从表格上面往下走、从下面往上走
      // 都会落在隐藏源码/结构空行的边界上,护栏得知道该把光标送到表格的哪一侧。
      this.scheduleCaretGuard(update.startState.selection.main.head)
    }
  }

  onCompositionStart(): void {
    this.composing = true
  }

  onCompositionEnd(): void {
    this.composing = false
  }

  /**
   * 微任务时机纠正"光标落在渲染表格隐藏源码里"的状态。
   * 必须排在 rebuild 之后 —— 新建表格的 autoFocus 也是微任务，先让它把焦点
   * 放进单元格；这里再检查时选区通常已经被挪到表格外，不会抢走插入后的焦点。
   */
  private scheduleCaretGuard(fromHead?: number): void {
    // 一个微任务里可能连着跑好几轮 update;记住**最早**那个起点,
    // 它才是这次光标移动真正的来处
    if (fromHead !== undefined && this.guardFromHead === null) this.guardFromHead = fromHead
    if (this.guardScheduled) return
    this.guardScheduled = true
    queueMicrotask(() => {
      this.guardScheduled = false
      const from = this.guardFromHead ?? undefined
      this.guardFromHead = null
      try {
        keepCaretOutOfTables(this.view, from)
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /** 组合期间的临时态:平移装饰范围,并丢掉因变更而跨行的 replace(CM 禁止插件提供跨行 replace) */
  private remap(changes: ChangeDesc): void {
    const doc = this.view.state.doc
    const decos: Range<Decoration>[] = []
    const atomic: Range<Decoration>[] = []
    const move = (set: DecorationSet, out: Range<Decoration>[]): void => {
      for (const iter = set.iter(); iter.value; iter.next()) {
        /*
         * 行装饰(Decoration.line)是零长度点。两端分别按 -1/+1 映射后,
         * 零长度区间会被下面的判断当成"空区间"整体丢掉 —— 组合期间每敲一个字
         * 都会走一次 remap,标题、表格宿主行、引用条这些行类装饰便会整片消失,
         * 表格高度和整块版式当场跳动。点装饰只映射一次,保持 from === to。
         */
        const isPoint = iter.from === iter.to
        const from = changes.mapPos(iter.from, -1)
        const to = isPoint ? from : changes.mapPos(iter.to, 1)
        if (from > to) continue
        // replace 装饰(mark 以外的)不允许跨行,跨了就丢弃,避免触发 CM 断言
        const spec = iter.value.spec
        const isReplace = spec.widget !== undefined || spec.class === undefined
        if (isReplace && doc.lineAt(from).to < to) continue
        out.push({ from, to, value: iter.value })
      }
    }
    move(this.decorations, decos)
    move(this.atomicSet, atomic)
    this.decorations = Decoration.set(decos, true)
    this.atomicSet = Decoration.set(atomic, true)
    this.links = this.links
      .map(l => ({ ...l, from: changes.mapPos(l.from, -1), to: changes.mapPos(l.to, 1) }))
      .filter(l => l.from < l.to)
  }

  /**
   * 全量重算可见区装饰。单一 ViewPlugin 方案:每次从事务后状态重建,
   * widget 位置天然正确,规避 undo/redo 与复杂 change 下的 RangeSet 映射问题。
   */
  private rebuild(): void {
    const view = this.view
    const state = view.state
    const decos: Range<Decoration>[] = []
    const atomic: Range<Decoration>[] = []
    const links: LinkInfo[] = []
    const docDir = getDocDir()
    let parsedAll = true

    for (const { from, to } of view.visibleRanges) {
      // 惰性行内解析:视口未解析完时先有界强解析,仍不可用则跳过并安排重试
      if (!syntaxTreeAvailable(state, to)) {
        ensureSyntaxTree(state, to, 50)
        if (!syntaxTreeAvailable(state, to)) {
          parsedAll = false
          this.scheduleRetry()
          continue
        }
      }
      const ctx: RuleContext = {
        sel: state.selection,
        doc: state.doc,
        docDir,
        visibleFrom: from,
        visibleTo: to,
        decos,
        atomic,
        links
      }
      syntaxTree(state).iterate({ from, to, enter: node => applyRule(node, ctx) })
    }

    // sort=true:自动排序 + RangeSet 校验(重叠的 replace 会在此抛错,便于开发期暴露)
    this.decorations = Decoration.set(decos, true)
    this.atomicSet = Decoration.set(atomic, true)
    this.links = links

    if (parsedAll) this.retryCount = 0
  }

  /** 远距离滚动时行内解析可能未就绪,空事务触发下一轮重建 */
  private scheduleRetry(): void {
    if (this.retryScheduled || this.retryCount >= MAX_RETRY) return
    this.retryScheduled = true
    this.retryCount++
    setTimeout(() => {
      this.retryScheduled = false
      try {
        this.pendingRetry = true
        this.view.dispatch({})
      } catch {
        /* 视图已销毁 */
      }
    }, 120)
  }
}

export const wysiwygViewPlugin = ViewPlugin.fromClass(WysiwygPlugin, {
  decorations: plugin => plugin.decorations,
  provide: plugin =>
    // atomicRanges:光标/点击在隐藏区间整体跳过,防止卡进不可见字符
    EditorView.atomicRanges.of((view: EditorView) => {
      const p = view.plugin(plugin)
      return p ? p.atomicSet : Decoration.none
    }),
  eventHandlers: {
    compositionstart(_event, view) {
      view.plugin(wysiwygViewPlugin)?.onCompositionStart()
      return false
    },
    compositionend(_event, view) {
      view.plugin(wysiwygViewPlugin)?.onCompositionEnd()
      return false
    },
    mousedown(event, view) {
      if (event.button !== 0) return false
      const target = event.target instanceof Element ? event.target : null
      if (!event.ctrlKey && !event.metaKey) {
        // 单元格/控件自己处理点击;其余落在渲染表格隐藏源码或结构空行上的点击一律挪出去
        if (target?.closest?.('.cm-md-table-widget')) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos != null) {
          const hit = caretOutsideRenderedTable(view, pos, event.clientY)
          if (hit != null) {
            event.preventDefault()
            if (hit.insert) {
              // 表格贴着文末:补出结构空行 + 正文行,点击才能真正落到表格后面
              view.dispatch({
                changes: { from: view.state.doc.length, insert: hit.insert },
                selection: { anchor: hit.anchor }
              })
            } else {
              view.dispatch({ selection: { anchor: hit.anchor } })
            }
            view.focus()
            return true
          }
        }
        return false
      }
      // Ctrl/Cmd + 点击链接
      const plugin = view.plugin(wysiwygViewPlugin)
      if (!plugin) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      const link = plugin.links.find(l => pos >= l.from && pos <= l.to)
      if (!link) return false
      event.preventDefault()
      void api.openExternal(link.url)
      return true
    }
  }
})
