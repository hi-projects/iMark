import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { Transaction, type ChangeDesc, type EditorState, type Line, type Range, type Text } from '@codemirror/state'
import { getPendingFence } from '../pendingFence'
import { autoTitleChanges, caretGroupRange, codeTabsField } from './codeTabs'
import { getEmptyParagraphs } from '../emptyParagraph'
import { isImeComposing } from '../ime'
import { applyRule, blockKindOf, collapseBlankRuns, type LinkInfo, type RuleContext } from './rules'
import { caretOutsideRenderedTable, isBlankLine, keepCaretOutOfTables } from './widgets'
import {
  addConflictDecorations,
  findConflictBlocks,
  type ConflictBlock
} from '../conflict'
import { appStore, getDocDir } from '../../stores/app'
import { api } from '../../services/api'

const MAX_RETRY = 20

/**
 * 光标/选区是否在块级公式里 —— 决定 wysiwyg 显示公式源码还是渲染块。
 * 鼠标拖选时公式保持渲染,与 rules 的 showsSource 保持一致。
 */
function selectionInMath(state: EditorState, pinRendered = false): boolean {
  if (pinRendered) return false
  for (const range of state.selection.ranges) {
    for (const bias of [1, -1] as const) {
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, bias)
      while (node) {
        if (node.name === 'MathBlock' || node.name === 'DisplayMath') return true
        node = node.parent
      }
    }
  }
  return false
}

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
 * 文档最后一个非空白字符之后的位置。
 *
 * 点击最后一行下方的空白时把光标放这里:只移动光标,不往源码里补换行。
 * 文末若有空行,光标也落在最后一个字后面,而不是停在空行上。
 */
function endOfLastText(doc: Text): number {
  let pos = doc.length
  while (pos > 0 && /\s/.test(doc.sliceString(pos - 1, pos))) pos--
  return pos
}

/**
 * 文末由用户回车创建、还空着的段落位置(行尾);没有就返回 null。
 *
 * 这类空段是用户要接着输入的地方:点击文末空白时优先回到它上面,
 * 不能越过它把光标送回上一段正文。
 */
function trailingEmptyParagraphEnd(state: EditorState): number | null {
  const kept = new Set(getEmptyParagraphs(state))
  const doc = state.doc
  let best: number | null = null
  for (let n = doc.lines; n >= 1; n--) {
    const line = doc.line(n)
    if (!isBlankLine(line.text)) break
    if (kept.has(line.from)) best = line.to
  }
  return best
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
  /** 窗口失焦(切到别的应用):元素不会触发 blur,但组合一定已经结束;左键也必然已松开 */
  private windowBlur = (): void => {
    this.onEditorBlur()
    this.endPointerDown()
  }
  /** 选区是否在块级公式里(渲染块 ↔ 源码态);切态时要强制重绘一次 */
  private mathSource: boolean
  /**
   * 当前非空选区来自鼠标拖选(含松开左键之后)。
   * 此时行内标记 / 公式 / 图片 / 图表保持渲染态,不因选区碰到而展开源码。
   */
  private pinRendered = false
  /**
   * 最近一次选区来自指针(包括鼠标点击后留下的空光标)。
   * 这种「光标」不应把结构空行撑开:用户是在点选,不是准备在空行里输入;
   * 键盘方向键落上空行仍然按正文行展开(见 caretOnGapLine)。
   */
  private pointerSelection = false
  /** 左键按住期间:结构空行不因光标落上去而展开(拖选途中也不跳) */
  private pointerDown = false
  /** 指针选区正在排队修正(避免每个 mousemove 都叠加一次) */
  private snapScheduled = false
  private onWindowMouseUp = (): void => this.endPointerDown()
  private mathRepaintScheduled = false

  constructor(readonly view: EditorView) {
    this.mathSource = selectionInMath(view.state)
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
    window.addEventListener('mouseup', this.onWindowMouseUp, true)
  }

  destroy(): void {
    this.themeObserver?.disconnect()
    this.themeObserver = null
    window.removeEventListener('blur', this.windowBlur)
    window.removeEventListener('mouseup', this.onWindowMouseUp, true)
  }

  beginPointerDown(): void {
    this.pointerDown = true
  }

  /** 松开左键(可能在编辑器外):按最终选区修正一次,再重算装饰 */
  endPointerDown(): void {
    if (!this.pointerDown) return
    this.pointerDown = false
    // 等 MouseSelection.up 把最终选区写完再处理;只靠 update 有时会漏掉这一帧
    window.setTimeout(() => {
      this.pendingRetry = true
      try {
        const snapped = this.snapPointerSelection(this.view.state)
        this.view.dispatch(snapped ? { selection: snapped, userEvent: 'select.pointer' } : {})
      } catch {
        /* 视图已销毁 */
      }
    }, 0)
  }

  /**
   * 鼠标选区不把端点停在空行上。
   *
   * 空行在渲染态下只承担段间距 / 块间距,或者只是源码里的换行;把它纳入
   * 选区既看不到文字,又会让下面的块上下跳。键盘导航不受影响。
   */
  private isStructuralBlankLine(line: Line): boolean {
    return line.text.replace(/[\s​﻿]/g, '') === ''
  }

  /**
   * 这一行在屏幕上没有可选中的文字:空行、被 widget 整行替换的宿主行、
   * 或多行块折叠出来的 `*-void` 行(公式 / 表格 / Mermaid 的后续行)。
   */
  private isUnselectableLine(line: Line): boolean {
    if (this.isStructuralBlankLine(line)) return true
    if (lineReplaced(this, line)) return true
    return lineClasses(this, line).some(cls => cls.endsWith('-void'))
  }

  /** 选区整体落在同一个代码 / 公式 / 表格等块里:那是用户在选块本身,不要吸附 */
  private selectionInsideBlock(state: EditorState, range: { from: number; to: number }): boolean {
    const blocks = new Set([
      'MathBlock',
      'DisplayMath',
      'FencedCode',
      'CodeBlock',
      'Table',
      'HTMLBlock'
    ])
    const blockAt = (pos: number, bias: 1 | -1): { from: number; to: number } | null => {
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias)
      while (node) {
        if (blocks.has(node.name)) return node
        node = node.parent
      }
      return null
    }
    const a = blockAt(range.from, 1)
    const b = blockAt(range.to, -1)
    return a !== null && b !== null && a.from === b.from && a.to === b.to
  }

  /**
   * 端点落在段落分隔的两条换行中间时,吸到换行串边界。
   * 返回 null 表示不需要修正。
   */
  private snapBreakBoundary(
    state: EditorState,
    range: { from: number; to: number }
  ): { from: number; to: number } | null {
    const text = state.doc.toString()
    const boundary = (pos: number, side: 'from' | 'to'): number => {
      let start = pos
      let end = pos
      while (start > 0 && text[start - 1] === '\n') start--
      while (end < text.length && text[end] === '\n') end++
      if (end - start < 2 || pos <= start || pos >= end) return pos
      return side === 'to' ? end : start
    }
    const from = boundary(range.from, 'from')
    const to = boundary(range.to, 'to')
    if (from === range.from && to === range.to) return null
    return { from: Math.min(from, to), to: Math.max(from, to) }
  }

  /**
   * 渲染态的公式块是原子块:指针选区碰到它的一部分时,把端点扩到整块边界,
   * 不允许出现「只选中半块公式」的中间态。源码态的公式仍可选中片段。
   */
  private expandRenderedMath(
    state: EditorState,
    range: { from: number; to: number }
  ): { anchor: number; head: number } | null {
    const expand = (pos: number, side: 'from' | 'to'): number => {
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
      while (node) {
        if (node.name === 'MathBlock' || node.name === 'DisplayMath') {
          const host = state.doc.lineAt(node.from)
          const rendered = lineReplaced(this, host)
          if (rendered) {
            if (pos > node.from && pos < node.to) return side === 'from' ? node.from : node.to
            // 端点正好贴在块边界上:选到块前面/后面也算「碰到块」,把整块带上,
            // 避免出现「选中了块前那条空白、公式却没选中」的中间态。
            if (side === 'to' && pos === node.from) return node.to
            if (side === 'from' && pos === node.to) return node.from
          }
        }
        node = node.parent
      }
      return pos
    }
    let from = expand(range.from, 'from')
    let to = expand(range.to, 'to')
    if (from === range.from && to === range.to) return null
    if (from > to) [from, to] = [to, from]
    return { anchor: from, head: to }
  }

  /** 选区是否完整包住一个渲染中的 widget(公式 / 图片 / 表格 / 图表) */
  private selectionCoversWidget(range: { from: number; to: number }): boolean {
    for (let iter = this.atomicSet.iter(); iter.value; iter.next()) {
      if (iter.from === iter.to) continue
      if (range.from <= iter.from && range.to >= iter.to) return true
    }
    return false
  }

  /** 选区里是否已经包含屏幕上有文字的行(隐藏块 / 空行不算) */
  private selectionHasVisibleText(
    state: EditorState,
    range: { from: number; to: number }
  ): boolean {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      if (this.isUnselectableLine(line)) continue
      const from = Math.max(line.from, range.from)
      const to = Math.min(line.to, range.to)
      if (to <= from) continue
      if (state.doc.sliceString(from, to).trim() !== '') return true
    }
    return false
  }

  /**
   * 指针选区不要把「只有结构空行」当成可见选区。
   *
   * 从下一段行首往上拖时,端点会先落进两段之间的空行;那段在源码里只是一条
   * 换行,选中它既看不到内容,又会让上面的公式/图片等退回源码。把端点吸到
   * 相邻正文的边界,选区至少包含一行的文字。
   */
  private snapPointerSelection(state: EditorState): { anchor: number; head: number } | null {
    const dbg = ((window as unknown as { __imarkSnapDebug?: Record<string, unknown> })
      .__imarkSnapDebug ??= {})
    const finish = (result: { anchor: number; head: number } | null): typeof result => {
      dbg.result = result
      return result
    }
    if (state.selection.ranges.length !== 1) {
      dbg.result = 'multi-range'
      return null
    }
    const range = state.selection.main
    if (range.empty) {
      dbg.result = 'empty'
      return null
    }
    const doc = state.doc
    dbg.attempt = {
      from: range.from,
      to: range.to,
      text: doc.sliceString(range.from, range.to),
      docLength: doc.length
    }
    const expandedMath = this.expandRenderedMath(state, range)
    if (expandedMath) {
      dbg.result = 'expand-math'
      return expandedMath
    }
    /*
     * 段落之间的分隔是两个换行。鼠标端点落在两条换行中间时,选区会变成
     * 「文字 + 一个 \n」这种中间态;把它吸到换行串的一个边界:终点带走
     * 整段分隔,起点则完全让开分隔。
     */
    const breakFix = this.snapBreakBoundary(state, range)
    if (breakFix) {
      const expanded = this.expandRenderedMath(state, breakFix)
      if (expanded) {
        dbg.result = 'break+math'
        return expanded
      }
      dbg.result = 'break-boundary'
      return { anchor: breakFix.from, head: breakFix.to }
    }

    if (this.selectionInsideBlock(state, range)) {
      dbg.result = 'inside-block'
      return null
    }
    if (this.selectionCoversWidget(range)) {
      dbg.result = 'covers-widget'
      return null
    }
    // 已经选到可见文字:保留用户的真实选区,不再把端点吸走
    if (this.selectionHasVisibleText(state, range)) {
      dbg.result = 'has-visible-text'
      return null
    }

    /*
     * 选区里一个可见字符都没有(只框住了换行/空行)时,把光标头沿拖动方向
     * 扩到最近的非空白字符。否则屏幕上就是「只选中了空白」,还会把空行撑开。
     */
    if (!/\S/.test(doc.sliceString(range.from, range.to))) {
      // 从起点那一侧补文字:向上拖就补下面的行,向下拖就补上面的行
      if (range.head >= range.anchor) {
        let i = range.from
        while (i > 0 && /\s/.test(doc.sliceString(i - 1, i))) i--
        if (i > 0) return finish({ anchor: i - 1, head: range.head })
      } else {
        let i = range.to
        while (i < doc.length && /\s/.test(doc.sliceString(i, i + 1))) i++
        if (i < doc.length) return finish({ anchor: i + 1, head: range.head })
      }
    }

    const lineOf = (pos: number): Line => doc.lineAt(pos)
    const fromLine = lineOf(range.from)
    const toLine = lineOf(range.to)
    const fromGap = this.isUnselectableLine(fromLine)
    const toGap = this.isUnselectableLine(toLine)
    if (!fromGap && !toGap) return finish(null)

    const prevText = (number: number): Line | null => {
      for (let n = number - 1; n >= 1; n--) {
        const line = doc.line(n)
        if (!this.isUnselectableLine(line)) return line
      }
      return null
    }
    const nextText = (number: number): Line | null => {
      for (let n = number + 1; n <= doc.lines; n++) {
        const line = doc.line(n)
        if (!this.isUnselectableLine(line)) return line
      }
      return null
    }

    let from = range.from
    let to = range.to
    let changed = false
    if (fromGap) {
      // 起点在不可见行:尽量把上一行可见正文整个带进来(没有就带下一行)
      const prev = prevText(fromLine.number)
      const next = nextText(fromLine.number)
      if (prev) {
        from = prev.from
        changed = true
      } else if (next) {
        from = next.to
        changed = true
      }
    }
    if (toGap) {
      // 终点在不可见行:尽量把下一行可见正文整个带进来(没有就带上一行)
      const next = nextText(toLine.number)
      const prev = prevText(toLine.number)
      if (next) {
        to = next.to
        changed = true
      } else if (prev) {
        to = prev.to
        changed = true
      }
    }
    if (!changed) return finish(null)
    if (from > to) [from, to] = [to, from]
    return finish({ anchor: from, head: to })
  }

  /**
   * 方向键落到结构空行上时,把空光标移到**移动方向上**的相邻正文。
   *
   * 结构空行已经固定 gap 高度,不能再承载可编辑光标。用户创建的空段落
   * (emptyParagraphs / 文末空白)仍是内容行,不在此列。
   *
   * 必须带方向:从第 1 行按 ↓ 落到段间距时,光标应该继续往下到第 3 行;
   * 一律往上一行行尾放会把光标弹回第 1 行(见 keepCaretOutOfBlockGaps 的同向规则)。
   */
  private scheduleCaretNormalize(fromHead: number): void {
    queueMicrotask(() => {
      const state = this.view.state
      const sel = state.selection.main
      if (!sel.empty || isImeComposing()) return
      const line = state.doc.lineAt(sel.head)
      if (line.text.trim() !== '') return
      if (getEmptyParagraphs(state).includes(line.from)) return
      // 文末空白行是用户可继续输入的位置(重开文件后空段落记录会丢)
      let textAfter = false
      for (let n = line.number + 1; n <= state.doc.lines; n++) {
        if (state.doc.line(n).text.trim() !== '') {
          textAfter = true
          break
        }
      }
      if (!textAfter) return
      if (!lineClasses(this, line).includes('cm-md-structural-blank')) return
      const doc = state.doc
      const dir = sel.head > fromHead ? 1 : -1
      let target: number | null = null
      for (let n = line.number + dir; n >= 1 && n <= doc.lines; n += dir) {
        const l = doc.line(n)
        if (!this.isUnselectableLine(l)) {
          target = dir > 0 ? l.from : l.to
          break
        }
      }
      if (target === null) return
      try {
        this.view.dispatch({ selection: { anchor: target }, userEvent: 'select' })
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /**
   * 拖选途中只做「公式块原子化」这一件事。
   *
   * 不能在拖动时做完整的空白/隐藏行吸附 —— 那会和鼠标方向打架;但如果完全
   * 不管,公式块又会出现「选中一半」的中间态。这里只把落在渲染态公式块内部
   * 的端点扩到整块边界,不碰其它端点。
   */
  private scheduleBlockSnap(): void {
    queueMicrotask(() => {
      const state = this.view.state
      const range = state.selection.main
      if (range.empty) return
      const breakFix = this.snapBreakBoundary(state, range)
      const base = breakFix ?? { from: range.from, to: range.to }
      const expanded = this.expandRenderedMath(state, base)
      const from = expanded ? Math.min(expanded.anchor, expanded.head) : base.from
      const to = expanded ? Math.max(expanded.anchor, expanded.head) : base.to
      if (from === range.from && to === range.to) return
      const forward = range.head >= range.anchor
      const selection = forward ? { anchor: from, head: to } : { anchor: to, head: from }
      try {
        this.view.dispatch({ selection, userEvent: 'select.pointer' })
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /** 排一次选区修正;执行时再按最新状态算,连续拖动不会拿旧坐标打架 */
  private scheduleSnap(): void {
    const dbg = ((window as unknown as { __imarkSnapDebug?: Record<string, unknown> })
      .__imarkSnapDebug ??= {})
    dbg.scheduled = Number(dbg.scheduled ?? 0) + 1
    dbg.pointerDown = this.pointerDown
    dbg.pointerSelection = this.pointerSelection
    const sel = this.view.state.selection.main
    dbg.selection = { empty: sel.empty, from: sel.from, to: sel.to, ranges: this.view.state.selection.ranges.length }
    if (this.snapScheduled) return
    this.snapScheduled = true
    queueMicrotask(() => {
      this.snapScheduled = false
      const snapped = this.snapPointerSelection(this.view.state)
      if (!snapped) return
      try {
        this.view.dispatch({ selection: snapped, userEvent: 'select.pointer' })
      } catch {
        /* 视图已销毁 */
      }
    })
  }

  /**
   * 记住「这次非空选区是不是鼠标拖出来的」。
   *
   * CodeMirror 给鼠标选区的 userEvent 是 select.pointer;键盘 / 命令选区是 select。
   * 松开左键后不会再有新事务,标记要留到下一次选区或文档变化,
   * 这样拖选结束后公式仍然保持渲染。
   */
  private trackPointerSelection(update: ViewUpdate): void {
    if (update.docChanged) {
      this.pinRendered = false
      this.pointerSelection = false
      return
    }
    if (!update.selectionSet) return
    const pointer = update.transactions.some(tr => tr.isUserEvent('select.pointer'))
    const keyboard = update.transactions.some(
      tr => tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')
    )
    // 不是指针产生的选区(键盘 / 程序化)意味着上一轮鼠标状态已经结束,
    // 否则 mousedown 没收到 mouseup 时 pointerDown 会卡住,结构空行再也展不开
    if (!pointer) this.pointerDown = false
    this.pointerSelection = pointer && !keyboard
    this.pinRendered =
      this.pointerSelection && update.state.selection.ranges.some(range => !range.empty)
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
    this.trackPointerSelection(update)
    // 拖选途中只保证公式块原子化;完整的空白/隐藏行吸附留到松手后,
    // 否则会和鼠标方向打架(从下往上选块会被不断拉回)。
    if (update.selectionSet && !update.docChanged) {
      // 只处理真正的键盘导航;焦点变化 / 程序化选区不能抢走用户刚落下的光标
      const keyboardSelect = update.transactions.some(
        tr => tr.isUserEvent('select') && !tr.isUserEvent('select.pointer')
      )
      if (keyboardSelect) {
        this.scheduleCaretNormalize(update.startState.selection.main.head)
      }
      if (this.pointerDown) this.scheduleBlockSnap()
      else this.scheduleSnap()
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
      const mathSource = selectionInMath(update.state, this.pinRendered)
      if (mathSource !== this.mathSource) {
        this.mathSource = mathSource
        // 公式块高度从「整块 widget」变成多行源码,先让 CM 立刻重测一次行高,
        // 再排一帧强制重绘(见 scheduleMathRepaint)。
        this.remeasureContent()
        this.scheduleMathRepaint()
      }
      this.scheduleCaretGuard(update.startState.selection.main.head, gapNav, gapLine)
      if (update.docChanged) this.scheduleAutoTitle(update)
    }
  }

  /** 让 CodeMirror 丢掉行高缓存、重新量一遍内容(公式态切换后整块高度会骤变) */
  private remeasureContent(): void {
    const view = this.view
    const viewState = (view as unknown as { viewState?: { mustMeasureContent?: boolean } })
      .viewState
    if (viewState) viewState.mustMeasureContent = true
    view.requestMeasure()
  }

  /**
   * 公式在渲染块和源码态之间切换时整块高度会骤变。
   *
   * 可横向滚动的公式块在部分 GPU 合成状态下会把旧的绘制层留在原地 ——
   * 看起来像凭空多了一个一模一样的公式块,点它又没有任何反应(它已经不在 DOM 里)。
   * 这里让 CodeMirror 重新量一次内容,并给滚动容器一帧极小的不透明度变化,
   * 强制整层重绘,把残留的旧绘制层清掉。
   */
  private scheduleMathRepaint(): void {
    if (this.mathRepaintScheduled) return
    this.mathRepaintScheduled = true
    requestAnimationFrame(() => {
      this.mathRepaintScheduled = false
      const view = this.view
      if (!view.dom.isConnected) return
      this.remeasureContent()
      /*
       * 整份内容重画一次。
       *
       * 公式块从「渲染 widget」翻回源码时,行高、DOM 子树和合成层要同时换掉;
       * 只 requestMeasure / 局部重绘在部分 GPU 合成状态下仍会留下旧公式块的
       * DOM 高度和绘制层 —— 表现就是源码出现在旧公式下面、旧公式还杵在上面。
       * setState(同一个 state) 会强制整份文档重画,把旧的 widget 子树、
       * 高度缓存和合成层一起丢掉。光标/选区在 state 里,滚动位置手动还原。
       */
      const scroller = view.scrollDOM
      const scrollTop = scroller.scrollTop
      const scrollLeft = scroller.scrollLeft
      const focused = view.hasFocus
      try {
        view.setState(view.state)
        scroller.scrollTop = scrollTop
        scroller.scrollLeft = scrollLeft
        if (focused) view.focus()
      } catch {
        /* 视图已销毁 */
      }
    })
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
    return classes.includes('cm-md-structural-blank') ? line.from : null
  }

  onCompositionStart(): void {
    this.composing = true
  }

  onCompositionEnd(): void {
    this.composing = false
  }

  /** 编辑器失焦:组合不可能还活着,把可能丢失的 compositionend 补上 */
  onEditorBlur(): void {
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
      const tree = syntaxTree(state)
      /*
       * 空段落行的行盒要与「敲进第一个字之后」完全一致,否则输入第一个字时
       * 整篇内容会跳一下。段落的行盒会按相邻块裁掉上 / 下侧半份行距
       * (见 rules.ts 的 styleParagraphTrim),这里先按同样的邻居判断把裁切
       * 类挂上,空着的时候和变成段落以后高度相同。
       */
      const trimForEmpty = (line: Line): string => {
        const bodyAt = (pos: number): boolean => {
          let node: SyntaxNode | null = tree.resolveInner(pos, 1)
          while (node && node.parent && node.parent.name !== 'Document') node = node.parent
          if (!node || node.parent?.name !== 'Document' || node.name !== 'Paragraph') return false
          return !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(state.doc.lineAt(node.from).text)
        }
        let above = line.number - 1
        while (above >= 1 && !/\S/.test(state.doc.line(above).text)) above -= 1
        let below = line.number + 1
        while (below <= state.doc.lines && !/\S/.test(state.doc.line(below).text)) below += 1
        const top = above < 1 || bodyAt(state.doc.line(above).from)
        // 文末(new paragraph 后面什么都没有)也按正文裁下侧,与规则里一致:
        // 回车在文末起的新段,空着时和敲进字后行盒一样高。
        const bottom = below > state.doc.lines || bodyAt(state.doc.line(below).from)
        return [top ? 'cm-md-para-trim-top' : '', bottom ? 'cm-md-para-trim-bottom' : '']
          .filter(Boolean)
          .join(' ')
      }
      // 空段落行挂一个标记类:它可能同时挨着一档段落间距,样式据此保住整行高。
      // 也方便验收直接看出「这一行被认作空段落」,而不是碰巧没被收紧。
      for (const pos of emptyParagraphs) {
        if (pos < from || pos > to) continue
        const line = state.doc.lineAt(pos)
        if (line.from === pos) {
          const trim = trimForEmpty(line)
          decos.push({
            from: pos,
            to: pos,
            value: Decoration.line({
              class: trim ? `cm-md-empty-paragraph ${trim}` : 'cm-md-empty-paragraph'
            })
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
        pinRendered: this.pinRendered,
        decos,
        atomic,
        links,
        decorated: new Set(),
        blockAt: pos => {
          const safe = Math.min(Math.max(pos, 0), tree.length)
          let node = tree.resolveInner(safe, 1)
          while (node.parent && node.parent.name !== 'Document') node = node.parent
          return node.parent ? node.name : null
        }
      }
      // 空段落行的配对间距:按「上一个块 → 正文」挂类,行盒与敲进字以后一致
      for (const pos of emptyParagraphs) {
        if (pos < from || pos > to) continue
        const line = state.doc.lineAt(pos)
        if (line.from !== pos) continue
        let n = line.number - 1
        let aboveIsEmpty = false
        while (n >= 1 && !/\S/.test(state.doc.line(n).text)) {
          const l = state.doc.line(n)
          if (emptyParagraphs.has(l.from)) {
            aboveIsEmpty = true
            break
          }
          n -= 1
        }
        if (aboveIsEmpty) {
          decos.push({
            from: pos,
            to: pos,
            value: Decoration.line({ class: 'cm-md-block-pair cm-md-body-body' })
          })
        } else if (n >= 1) {
          let node: SyntaxNode | null = tree.resolveInner(state.doc.line(n).from, 1)
          while (node && node.parent && node.parent.name !== 'Document') node = node.parent
          if (!node || node.parent?.name !== 'Document') continue
          const kind = blockKindOf(ctx, node)
          if (kind) {
            decos.push({
              from: pos,
              to: pos,
              value: Decoration.line({ class: `cm-md-block-pair cm-md-${kind}-body` })
            })
          }
        }
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
    mouseup(event, view) {
      if (event.button === 0) view.plugin(wysiwygViewPlugin)?.endPointerDown()
      return false
    },
    mousedown(event, view) {
      if (event.button === 0) view.plugin(wysiwygViewPlugin)?.beginPointerDown()
      if (event.button !== 0) return false
      const target = event.target instanceof Element ? event.target : null
      if (!event.ctrlKey && !event.metaKey) {
        // 单元格/控件自己处理点击;其余落在渲染表格隐藏源码或结构空行上的点击一律挪出去
        if (target?.closest?.('.cm-md-table-widget')) return false
        // 点在最后一行下方的空白:不改源码,只把光标放到最后一个字后面
        // (旧行为会临时补出一个空段落,点一下文末就多一行,已去掉)。
        // 点在图表 / 图片这类块控件自己身上不算(控件内部各有各的点击语义)。
        if (
          !target?.closest?.('.cm-md-widget') &&
          !event.shiftKey &&
          !event.altKey &&
          clickBelowDocEnd(view, event)
        ) {
          event.preventDefault()
          view.dispatch({
            selection: {
              anchor:
                trailingEmptyParagraphEnd(view.state) ?? endOfLastText(view.state.doc)
            },
            scrollIntoView: true,
            userEvent: 'select.pointer'
          })
          view.focus()
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
