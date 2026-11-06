import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { Transaction, type ChangeDesc, type EditorState, type Line, type Range, type Text } from '@codemirror/state'
import { getPendingFence } from '../pendingFence'
import { autoTitleChanges, caretGroupRange, codeTabsField } from './codeTabs'
import { getEmptyParagraphs, paragraphClick } from '../emptyParagraph'
import { applyRule, collapseBlankRuns, type LinkInfo, type RuleContext } from './rules'
import { caretOutsideRenderedTable, isBlankLine, keepCaretOutOfTables } from './widgets'
import {
  addConflictDecorations,
  findConflictBlocks,
  type ConflictBlock
} from '../conflict'
import { appStore, getDocDir } from '../../stores/app'
import { api } from '../../services/api'

const MAX_RETRY = 20

/** 这一批变更是否全部由输入法组合产生(CM 给组合派发的输入打的标记是 input.type.compose) */
function isCompositionChange(update: ViewUpdate): boolean {
  if (update.transactions.length === 0) return false
  return update.transactions.every(tr => !tr.docChanged || tr.isUserEvent('input.type.compose'))
}

/**
 * 点击是不是落在「文件最后一行下方」的空白里。
 *
 * 只有文档末尾真的在视口里时才算 —— 长文档滚到中间时,下方的空白是还没滚到
 * 的内容,不是文末。点击位置在最后一行底部以下,才当作「想在文末新起一段」。
 */
function clickBelowDocEnd(view: EditorView, event: MouseEvent): boolean {
  const coords = view.coordsAtPos(view.state.doc.length)
  if (!coords) return false
  const box = view.scrollDOM.getBoundingClientRect()
  if (coords.bottom < box.top || coords.top > box.bottom) return false
  return event.clientY > coords.bottom + 1
}

/**
 * 在文末新起一个空段落,返回临时补出来的区间(文末已经有空段落时为 null)。
 *
 * Markdown 里新段与上一段之间要空一行,所以文末要么已经是 `\n\n`,要么补到
 * `\n\n`;只补换行,不写任何可见内容。光标先落到新行上,用户真输入就留下,
 * 没输入就移开时由 WysiwygPlugin 撤回(见 dropTailDraft)。
 */
function insertTailParagraph(view: EditorView): { from: number; to: number; text: string } | null {
  const { doc } = view.state
  const end = doc.length
  const tail = end === 0 ? '' : doc.sliceString(Math.max(0, end - 2), end)
  const text = end === 0 || tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n'
  view.dispatch({
    changes: text ? { from: end, insert: text } : undefined,
    selection: { anchor: end + text.length },
    annotations: [paragraphClick.of(true)],
    userEvent: 'select.pointer',
    scrollIntoView: true
  })
  return text ? { from: end, to: end + text.length, text } : null
}

/** 这一行是不是被整行替换掉了(代码围栏、表格宿主行、公式、独占一行的图片等) */
function lineReplaced(plugin: WysiwygPlugin, line: Line): boolean {
  const iter = plugin.atomicSet.iter()
  for (; iter.value; iter.next()) {
    if (iter.from <= line.from && iter.to >= line.to) return true
  }
  return false
}

/** 这一行挂着的行装饰类 */
function lineClasses(plugin: WysiwygPlugin, line: Line): string[] {
  const out: string[] = []
  const iter = plugin.decorations.iter()
  for (; iter.value; iter.next()) {
    if (iter.from !== line.from || iter.to !== line.from) continue
    const cls = (iter.value.spec as { class?: string }).class
    if (cls) out.push(...cls.split(/\s+/))
  }
  return out
}

/**
 * 点击落在收紧的结构空行上时,光标该停到哪。
 *
 * 这类空行平时只占"一档间距"的高度(见 rules 的 addGapBefore / addGapAfter),
 * 看上去就是两块之间的留白。可光标一停上去,它会按正文行撑开(为了接着输入时
 * 字不跳),于是点一下空白,眼前凭空多出一整行,下面内容整体下移 —— 像是被
 * 点出来的新行。这里干脆不让光标停在空行上:点和识别出的留白时,把光标挪到
 * 空行另一侧最近的正文行(空行属于下面那块就往上找,属于上面那块就往下找),
 * 和点击渲染表格空白处的处理一致。想给两块之间补内容,在上一行末尾回车即可。
 *
 * 只改鼠标点击:方向键把光标挪上空行时仍按原样撑开,保证落点和输入位置一致。
 */
function gapLineClickAnchor(view: EditorView, plugin: WysiwygPlugin, pos: number): number | null {
  const doc = view.state.doc
  const line = doc.lineAt(pos)
  if (!isBlankLine(line.text)) return null
  // 回车创建的空段落是用户要能点回去的一行,不按结构空行处理
  const kept = new Set(getEmptyParagraphs(view.state))
  if (kept.has(line.from)) return null
  const classes = lineClasses(plugin, line)
  if (!classes.includes('cm-md-block-gap')) return null
  const isSide = (side: 'before' | 'after'): boolean =>
    classes.some(c => c.startsWith('cm-md-block-gap-') && c.endsWith(`-${side}`))
  const isKept = (l: Line): boolean => kept.has(l.from)
  const above = (): number | null => {
    for (let n = line.number - 1; n >= 1; n--) {
      const l = doc.line(n)
      // 光标刚离开的空段落虽然也是空行,但它是用户点得回去的一行,优先落到它上面
      if (isKept(l)) return l.from
      if (isBlankLine(l.text) || lineReplaced(plugin, l)) continue
      return l.to
    }
    return null
  }
  const below = (): number | null => {
    for (let n = line.number + 1; n <= doc.lines; n++) {
      const l = doc.line(n)
      if (isKept(l)) return l.from
      if (isBlankLine(l.text) || lineReplaced(plugin, l)) continue
      return l.from
    }
    return null
  }
  // 点的是空段落旁边的段间距:用户就是在点那个空着的第二段,别送回上一段
  const up = above()
  const down = below()
  if (up !== null && kept.has(up)) return up
  if (down !== null && kept.has(down)) return down
  // 空行挂的是 "-before"(间距属于下一块)或正文之间:往上找;
  // 否则("-after")往下找。两个方向都没有可停的正文行时再从另一侧兜一次底。
  if (classes.includes('cm-md-block-gap-body') || isSide('before')) return up ?? down
  if (isSide('after')) return down ?? up
  return null
}

export class WysiwygPlugin {
  decorations: DecorationSet = Decoration.none
  atomicSet: DecorationSet = Decoration.none
  links: LinkInfo[] = []

  /** 冲突扫描结果按 Text 对象缓存:选区变化不重扫,文档一变才重扫 */
  private conflictDoc: Text | null = null
  private conflictBlocks: ConflictBlock[] = []

  private pendingRetry = false
  private retryScheduled = false
  private retryCount = 0
  /** 自动补 title 已排进微任务(连续输入只补一次) */
  private autoTitleScheduled = false
  /** 这一轮有待补的自动名(改动落在光标所在的标签组里) */
  private autoTitleWanted = false
  private guardScheduled = false
  /** 本次光标移动之前的落点(用于判断是朝表格上方还是下方走) */
  private guardFromHead: number | null = null
  /** 本次键盘移动落到的那条间距行(重建前的判断,见 gapLineLanding) */
  private guardGapLine: number | null = null
  /** 组合进行中(以 compositionstart/end 事件为准,比 view.composing 更早、更稳) */
  private composing = false
  /** 这一轮微任务里是否要用键盘方向键跳过块间距行 */
  private guardGapNav = false
  private themeObserver: MutationObserver | null = null
  /** 窗口失焦(切到别的应用):元素不会触发 blur,但组合一定已经结束 */
  private windowBlur = (): void => this.onEditorBlur()
  /** 点击文末空白临时补出来的空段落;用户没输入就撤掉(见 openTailParagraph) */
  private tailDraft: { from: number; to: number; text: string } | null = null

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
    window.addEventListener('blur', this.windowBlur)
  }

  destroy(): void {
    this.themeObserver?.disconnect()
    this.themeObserver = null
    window.removeEventListener('blur', this.windowBlur)
  }

  update(update: ViewUpdate): void {
    if (this.tailDraft) {
      if (update.docChanged) {
        // 用户输入了内容(或文档被别处改动):新段落成立,不再撤回
        this.tailDraft = null
      } else if (update.selectionSet && !this.selectionInTail(update.state)) {
        // 光标移开临时空段落(点别处 / 方向键):没输入过,就当无事发生
        this.dropTailDraft()
      }
    }
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
      /*
       * 组合中收到一笔**不是输入法产生**的文档变更(Agent / 扩展整篇替换、
       * 后台标签同步):这类变更会把 contenteditable 里的内容整体换掉,
       * 浏览器往往就此不再补发 compositionend。继续按"组合中"处理的话,
       * composing 永远为真,之后每次都只 remap、不重建,装饰便永久冻在
       * 替换前那一刻 —— 表现就是新内容全是 Markdown 源码,只有替换前
       * 渲染过的那部分还带着样式。
       *
       * 输入法自己派发的变更带 .compose 标记(见 CM 的 applyDefaultInsert),
       * 用它区分;其余变更说明组合其实已经结束,先把状态收尾再照常重建。
       */
      if (update.docChanged && !isCompositionChange(update)) {
        this.endComposition()
      } else {
        if (update.docChanged) this.remap(update.changes)
        return
      }
    }
    if (update.docChanged || update.viewportChanged || update.selectionSet || this.pendingRetry) {
      this.pendingRetry = false
      // 把"移动之前"的光标位置交给护栏:从表格上面往下走、从下面往上走
      // 都会落在隐藏源码/结构空行的边界上,护栏得知道该把光标送到表格的哪一侧。
      // 块间距空行只对**键盘方向键**做跨越;回车/输入产生的空白行要留给用户继续输入。
      const gapNav = update.transactions.some(
        tr => tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')
      )
      // 方向键落点是不是间距行,必须在 rebuild 之前判断(见 gapLineLanding)
      const gapLine = gapNav && !update.docChanged ? this.gapLineLanding(update.state) : null
      this.rebuild()
      this.scheduleCaretGuard(update.startState.selection.main.head, gapNav, gapLine)
      if (update.docChanged) this.scheduleAutoTitle(update)
    }
  }

  /**
   * 未命名的代码块自动补 `title="未命名代码块N"`(见 codeTabs.ts 的
   * autoTitleChanges)。名字写进源码,标签只是跟着源码显示。
   *
   * 只有**改动本身落在光标所在的标签组里**才补:光标停在组里(刚打开文件时
   * 会停在组头围栏行上)并不代表用户在编辑这一组,点文末新起段落之类的改动
   * 也发生在组外,不该顺带改源码。
   *
   * update 里不能直接 dispatch,推到微任务;addToHistory:false —— 这是渲染层
   * 补的标注,不该在撤销栈里单独占一步(否则撤销它又会被立刻补回来)。
   */
  private scheduleAutoTitle(update: ViewUpdate): void {
    const group = caretGroupRange(update.state)
    if (!group) return
    let edited = false
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      // 新文档坐标;纯插入时 fromB === toB,端点贴着组尾(文末补空行)不算组内
      if (fromB < group.to && toB > group.from) edited = true
    })
    if (!edited) return
    this.autoTitleWanted = true
    if (this.autoTitleScheduled) return
    this.autoTitleScheduled = true
    queueMicrotask(() => {
      this.autoTitleScheduled = false
      const wanted = this.autoTitleWanted
      this.autoTitleWanted = false
      // 组合期间不插字,免得打断输入法;组合结束后还有一次 docChanged
      if (!wanted || this.composing || this.view.composing) return
      try {
        const changes = autoTitleChanges(this.view.state)
        if (changes.length === 0) return
        this.view.dispatch({
          changes,
          annotations: Transaction.addToHistory.of(false)
        })
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /**
   * 方向键的落点是不是一条被收紧的间距行(行首位置)。
   *
   * 要在 rebuild **之前**调用:光标落上去以后,collapseBlankRuns 会因为
   * caretOnGapLine 跳过这一行,原来挂着的 gap 类当场就被摘掉了,重建后再看
   * 根本认不出来。用移动前的装饰来判断,才能把「价格行」和文件末尾那种
   * 普通空行(可以正常停)区分开。
   */
  private gapLineLanding(state: EditorState): number | null {
    const sel = state.selection
    if (sel.ranges.length !== 1 || !sel.main.empty) return null
    const line = state.doc.lineAt(sel.main.head)
    if (!isBlankLine(line.text)) return null
    const classes = lineClasses(this, line)
    const isGap =
      classes.includes('cm-md-block-gap') ||
      classes.some(cls => cls.startsWith('cm-md-gap-'))
    return isGap ? line.from : null
  }

  onCompositionStart(): void {
    this.composing = true
  }

  onCompositionEnd(): void {
    this.composing = false
  }

  /**
   * 点击文末空白:光标落到最后一行下面新起的一段上。
   * 文档只临时补出段落换行,真输入才留下;没输入就移开光标 / 失焦时撤回。
   */
  openTailParagraph(): void {
    const draft = insertTailParagraph(this.view)
    this.tailDraft = draft
    // 已经有空段落可落(文末本来就是 `\n\n`)时没有草稿,光标直接停上去即可
    this.view.focus()
  }

  /** 当前选区是不是仍然停在那段临时空段落上 */
  private selectionInTail(state: EditorState): boolean {
    const draft = this.tailDraft
    if (!draft) return false
    return state.selection.ranges.every(r => r.from >= draft.from && r.to <= draft.to)
  }

  /**
   * 撤回文末临时空段落。
   *
   * 不能同步 dispatch(这里通常是在一次 update 里被叫到的),排进微任务;
   * 真删之前再核对一遍原文,期间如果文档变过(update 会先清掉草稿)就不动。
   */
  private dropTailDraft(): void {
    const draft = this.tailDraft
    this.tailDraft = null
    if (!draft) return
    queueMicrotask(() => {
      const view = this.view
      const doc = view.state.doc
      if (draft.to > doc.length || doc.sliceString(draft.from, draft.to) !== draft.text) return
      try {
        view.dispatch({ changes: { from: draft.from, to: draft.to }, userEvent: 'delete.draft' })
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /** 编辑器失焦:组合不可能还活着,把可能丢失的 compositionend 补上 */
  onEditorBlur(): void {
    // 没输入过的文末空段落不该因为切窗口而留在文档里
    this.dropTailDraft()
    if (!this.composing && !this.view.composing) return
    this.endComposition()
    // 失焦本身不产生事务,不主动补一次重建就得等下一次输入才恢复样式
    this.pendingRetry = true
    try {
      this.view.dispatch({})
    } catch {
      /* 视图已销毁 */
    }
  }

  /**
   * 结束组合态。除了自己的标记,还要把 CM 的 inputState.composing 复位:
   * compositionend 丢失时它会一直停在 >= 0,`view.composing` 也就永远为真,
   * 光清自己的标记挡不住守卫。这个字段在 CM 的类型声明里是 @internal,
   * 但它就是"组合是否结束"的唯一来源;调用时机都限定在组合必然已经结束的时候
   * (失焦、或收到非输入法产生的变更),与 math.ts 用 Line.depth 的取舍相同。
   */
  private endComposition(): void {
    this.composing = false
    const input = (this.view as unknown as { inputState?: { composing?: number } }).inputState
    if (input && typeof input.composing === 'number') input.composing = -1
  }

  /**
   * 微任务时机纠正"光标落在渲染表格隐藏源码里"的状态。
   * 必须排在 rebuild 之后 —— 新建表格的 autoFocus 也是微任务，先让它把焦点
   * 放进单元格；这里再检查时选区通常已经被挪到表格外，不会抢走插入后的焦点。
   */
  private scheduleCaretGuard(fromHead?: number, gapNav = false, gapLine: number | null = null): void {
    // 一个微任务里可能连着跑好几轮 update;记住**最早**那个起点,
    // 它才是这次光标移动真正的来处
    if (fromHead !== undefined && this.guardFromHead === null) this.guardFromHead = fromHead
    if (gapNav) this.guardGapNav = true
    if (gapLine !== null && this.guardGapLine === null) this.guardGapLine = gapLine
    if (this.guardScheduled) return
    this.guardScheduled = true
    queueMicrotask(() => {
      this.guardScheduled = false
      const from = this.guardFromHead ?? undefined
      const gapNav = this.guardGapNav
      const gapLine = this.guardGapLine
      this.guardFromHead = null
      this.guardGapNav = false
      this.guardGapLine = null
      try {
        keepCaretOutOfTables(this.view, from)
        if (gapNav) this.keepCaretOutOfBlockGaps(from, gapLine)
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /**
   * 方向键落在结构空行上时,沿移动方向跳过它。
   *
   * 这类空行是排版用的结构行(段间距、文末空行等),本身不该成为编辑落点。
   * 鼠标点击已经由 gapLineClickAnchor 处理;键盘上下键落在上面时
   * `caretOnGapLine` 会把空行撑成一整行 —— 一段空白里凭空多出一条「段内
   * 换行」。这里在选区落定的微任务里把它跨过去:
   *   - 方向上的第一个空段落(回车创建)或正文行才是落点;
   *   - 方向上什么都没有(文末只剩空行)就留在原地。
   *
   * 只在相邻行的移动时处理(Ctrl+End 这类直接跳到文末的命令保持原样)。
   * 代码 / 表格 / 公式里的空行是块内容,不跨。
   */
  private keepCaretOutOfBlockGaps(fromHead?: number, gapLine: number | null = null): void {
    const view = this.view
    const state = view.state
    if (!state.selection.main.empty) return
    const head = state.selection.main.head
    const doc = state.doc
    const line = doc.lineAt(head)
    if (!isBlankLine(line.text)) return
    // 只有「移动前就是被收紧的间距行」才跨;文件末尾那种普通空行可以正常停
    if (gapLine === null || line.from !== gapLine) return
    // 回车创建的空段落是真正的落点
    const kept = new Set(getEmptyParagraphs(state))
    if (kept.has(line.from)) return
    // 只处理方向键的相邻移动;程序化选区 / Ctrl+End 等保持原落点
    if (fromHead === undefined) return
    const origin = doc.lineAt(fromHead)
    if (Math.abs(origin.number - line.number) !== 1) return
    const dir: 1 | -1 = head > fromHead ? 1 : -1
    let target: Line | null = null
    for (let n = line.number + dir; n >= 1 && n <= doc.lines; n += dir) {
      const candidate = doc.line(n)
      // 空段落按正文落点对待:跨过间距行后应当停在它上面
      if (kept.has(candidate.from)) {
        target = candidate
        break
      }
      if (isBlankLine(candidate.text) || lineReplaced(this, candidate)) continue
      target = candidate
      break
    }
    // 方向上没有可停的正文/空段落:留在原地,别把这条结构空行撑成整行
    if (!target) {
      if (head !== fromHead) view.dispatch({ selection: { anchor: fromHead } })
      return
    }
    // 向上跨过段间距:用户是在「回到上一段」,落到目标行行尾,而不是保持
    // 同一列、停在上一行的第一个字前面。段内上下移动不经过这里,仍按列对齐。
    const column = Math.max(0, fromHead - origin.from)
    const atEnd = dir === -1
    const anchor = atEnd ? target.to : target.from + Math.min(column, target.length)
    view.dispatch({ selection: { anchor } })
  }

  /** 组合期间的临时态:平移装饰范围,并丢掉因变更而跨行的 replace(CM 禁止扩展提供跨行 replace) */
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

  /** 冲突块只在文档对象变化时重扫;选区/滚动变化直接复用上一次的结果 */
  private conflictsFor(doc: Text): ConflictBlock[] {
    if (this.conflictDoc !== doc) {
      this.conflictDoc = doc
      this.conflictBlocks = findConflictBlocks(doc)
    }
    return this.conflictBlocks
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
    const conflicts = this.conflictsFor(state.doc)
    appStore.activeConflicts = conflicts.length
    let parsedAll = true

    // 冲突块里的内容按原样显示(两段分别着色),不再套用 Markdown 规则:
    // `=======` 很容易被当成 Setext 标题下划线,和冲突标记互相打架。
    const inConflict = (from: number, to: number): boolean =>
      conflicts.some(block => from <= block.to && to >= block.from)

    if (conflicts.length > 0) addConflictDecorations(decos, atomic, state.doc, conflicts)

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
      const emptyParagraphs = new Set(getEmptyParagraphs(state))
      // 空段落行挂一个标记类:它可能同时挨着一档段落间距,样式据此保住整行高。
      // 也方便验收直接看出「这一行被认作空段落」,而不是碰巧没被收紧。
      for (const pos of emptyParagraphs) {
        if (pos < from || pos > to) continue
        const line = state.doc.lineAt(pos)
        if (line.from === pos) {
          decos.push({
            from: pos,
            to: pos,
            value: Decoration.line({ class: 'cm-md-empty-paragraph' })
          })
        }
      }
      const ctx: RuleContext = {
        sel: state.selection,
        doc: state.doc,
        docDir,
        visibleFrom: from,
        visibleTo: to,
        pendingFence: getPendingFence(state),
        codeTabs: state.field(codeTabsField, false) ?? [],
        emptyParagraphs,
        decos,
        atomic,
        links,
        decorated: new Set()
      }
      syntaxTree(state).iterate({
        from,
        to,
        enter: node => {
          // 根节点必须继续下钻;其余与冲突块相交的节点整棵跳过
          if (node.name !== 'Document' && inConflict(node.from, node.to)) return false
          return applyRule(node, ctx)
        }
      })
      collapseBlankRuns(ctx, inConflict)
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
    blur(_event, view) {
      // 组合进行中失焦(切窗口 / 点到侧栏):浏览器可能不补发 compositionend
      view.plugin(wysiwygViewPlugin)?.onEditorBlur()
      return false
    },
    mousedown(event, view) {
      if (event.button !== 0) return false
      const target = event.target instanceof Element ? event.target : null
      if (!event.ctrlKey && !event.metaKey) {
        // 单元格/控件自己处理点击;其余落在渲染表格隐藏源码或结构空行上的点击一律挪出去
        if (target?.closest?.('.cm-md-table-widget')) return false
        // 点在最后一行下方的空白:在文末新起一个空段落。文档只临时补出段落
        // 换行,键入才留下;没输入就移开时撤回(见 openTailParagraph)。
        // 点在图表 / 图片这类块控件自己身上不算(控件内部各有各的点击语义)。
        const plugin = view.plugin(wysiwygViewPlugin)
        if (
          plugin &&
          !target?.closest?.('.cm-md-widget') &&
          !event.shiftKey &&
          !event.altKey &&
          clickBelowDocEnd(view, event)
        ) {
          event.preventDefault()
          plugin.openTailParagraph()
          return true
        }
        // 精确解析对「空行正好是视口第一行」这种位置返回 null(CM 把视口起点上的
        // 空块当成视口外);退回 CM 默认点击处理用的宽松解析,才认得出点的是不是
        // 收紧的结构空行 —— 否则光标直接落在间距行上,把它撑开、把下面正文顶下去。
        const coords = { x: event.clientX, y: event.clientY }
        const pos = view.posAtCoords(coords) ?? view.posAtCoords(coords, false)
        if (pos != null) {
          const hit = caretOutsideRenderedTable(view, pos, event.clientY)
          if (hit != null) {
            event.preventDefault()
            if (hit.insert) {
              // 表格贴着文末:补出结构空行 + 正文行,点击才能真正落到表格后面
              view.dispatch({
                changes: { from: view.state.doc.length, insert: hit.insert },
                selection: { anchor: hit.anchor },
                userEvent: 'select.pointer'
              })
            } else {
              view.dispatch({ selection: { anchor: hit.anchor }, userEvent: 'select.pointer' })
            }
            view.focus()
            return true
          }
          // 收紧的结构空行:点它不把空行撑出来,光标挪到最近的正文行(见 gapLineClickAnchor)
          const anchor = plugin ? gapLineClickAnchor(view, plugin, pos) : null
          if (anchor != null) {
            event.preventDefault()
            // 这是用户在点击:光标从空段落上离开时,空段落要留下(见 emptyParagraph.ts)
            view.dispatch({ selection: { anchor }, userEvent: 'select.pointer' })
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
