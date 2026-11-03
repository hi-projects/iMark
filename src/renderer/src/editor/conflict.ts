/**
 * Git 冲突标记的识别与处理。
 *
 * git 在合并冲突时把两边的内容都写进文件,用三行标记分隔:
 *
 *   <<<<<<< HEAD
 *   当前分支的内容
 *   =======
 *   传入分支的内容
 *   >>>>>>> origin/main
 *
 * 开了 diff3(merge.conflictStyle=diff3)时还会多一段 `|||||||` 的基准内容。
 *
 * 这里的界面参考 VSCode 的编辑器内冲突提示:标记行换成一条操作栏,两段内容
 * 分别用绿/蓝底色标出,每处冲突都可以「接受当前 / 接受传入 / 保留两者」。
 * 按钮直接改文档,走正常的撤销栈,不做任何自动取舍。
 */

import { EditorSelection, Text, type Line, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

export type ConflictChoice = 'ours' | 'theirs' | 'both'

export interface ConflictBlock {
  /** 起始标记所在行(1 基) */
  startLine: number
  /** `=======` 分隔行(1 基) */
  separatorLine: number
  /** 结束标记所在行(1 基) */
  endLine: number
  /** diff3 的 `|||||||` 基准行;没有基准段时为 null */
  baseLine: number | null
  /** 整块在文档里的范围(起始标记行首 → 结束标记行尾) */
  from: number
  to: number
  oursLabel: string
  theirsLabel: string
  baseLabel: string
  /** 从 1 开始,用于操作栏上的「冲突 i/n」 */
  index: number
}

const START = /^<<<<<<<(?:[ \t].*)?$/
const BASE = /^\|\|\|\|\|\|\|(?:[ \t].*)?$/
const SEPARATOR = /^=======[ \t]*$/
const END = /^>>>>>>>(?:[ \t].*)?$/

/** 行文本(去掉可能残留的 \r;编辑器内部统一 LF,这里只是兜底) */
function lineText(line: Line): string {
  return line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text
}

/** 标记后面的分支名/提交说明(没有就为空串) */
function markerLabel(text: string): string {
  return text.slice(7).trim()
}

/**
 * 扫描全文档,找出所有**完整**的冲突块。
 *
 * 不完整的块(只写了半截标记)不纳入 UI —— 用户可能正在手动编辑标记,这时
 * 弹出一堆操作栏只会碍事。只有 起始 → (基准) → 分隔 → 结束 齐全时才算一处冲突。
 */
export function findConflictBlocks(doc: Text): ConflictBlock[] {
  // 绝大多数文档没有冲突标记:先做一次整串包含判断,避免逐行遍历。
  // (标签页本来就会在每次改动时把全文取出来算字数,这里几乎不额外花钱。)
  if (!doc.toString().includes('<<<<<<<')) return []

  const blocks: ConflictBlock[] = []
  let start: { line: Line; label: string } | null = null
  let base: { line: Line; label: string } | null = null
  let separator: { line: Line } | null = null

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    const text = lineText(line)

    if (!start) {
      if (START.test(text)) start = { line, label: markerLabel(text) }
      continue
    }

    if (!separator) {
      if (!base && BASE.test(text)) {
        base = { line, label: markerLabel(text) }
        continue
      }
      if (SEPARATOR.test(text)) {
        separator = { line }
        continue
      }
      // 起始标记之后又出现一个起始标记:前一个块不完整,以新的为准
      if (START.test(text)) start = { line, label: markerLabel(text) }
      continue
    }

    if (!END.test(text)) continue
    blocks.push({
      startLine: start.line.number,
      separatorLine: separator.line.number,
      endLine: line.number,
      baseLine: base?.line.number ?? null,
      from: start.line.from,
      to: line.to,
      oursLabel: start.label,
      theirsLabel: markerLabel(text),
      baseLabel: base?.label ?? '',
      index: 0
    })
    start = null
    base = null
    separator = null
  }

  blocks.forEach((block, i) => {
    block.index = i + 1
  })
  return blocks
}

/** 两个标记行之间的内容(不含两侧标记);空段返回空串 */
function sectionText(doc: Text, fromLine: Line, toLine: Line): string {
  if (toLine.number <= fromLine.number + 1) return ''
  const lines: string[] = []
  for (let n = fromLine.number + 1; n < toLine.number; n++) lines.push(doc.line(n).text)
  return lines.join('\n')
}

export interface ConflictSides {
  ours: string
  theirs: string
  /** diff3 的基准内容;没有基准段时为空串 */
  base: string
}

/** 读出冲突块两边的完整内容(冲突处理窗口与编辑器内操作栏共用) */
export function readConflictSides(doc: Text, block: ConflictBlock): ConflictSides {
  const start = doc.line(block.startLine)
  const separator = doc.line(block.separatorLine)
  const end = doc.line(block.endLine)
  const base = block.baseLine ? doc.line(block.baseLine) : null
  return {
    ours: sectionText(doc, start, base ?? separator),
    theirs: sectionText(doc, separator, end),
    base: base ? sectionText(doc, base, separator) : ''
  }
}

export interface ConflictReplacement {
  from: number
  to: number
  insert: string
}

/**
 * 计算出「应用某处取舍」对应的文本替换,不直接改文档。
 * 冲突处理窗口用它改内存里的文件内容,编辑器用它派发事务。
 */
export function conflictReplacement(
  doc: Text,
  block: ConflictBlock,
  choice: ConflictChoice
): ConflictReplacement {
  const sides = readConflictSides(doc, block)
  const insert =
    choice === 'ours'
      ? sides.ours
      : choice === 'theirs'
        ? sides.theirs
        : [sides.ours, sides.theirs].filter(part => part.length > 0).join('\n')
  return { from: doc.line(block.startLine).from, to: doc.line(block.endLine).to, insert }
}

/**
 * 在纯文本上应用一处取舍(冲突处理窗口用)。
 * 内容按 LF 行界解析;返回 null 表示按行号已经找不到这处冲突。
 */
export function applyConflictToText(
  content: string,
  startLine: number,
  choice: ConflictChoice
): string | null {
  const doc = Text.of(content.split('\n'))
  const block = findConflictBlocks(doc).find(item => item.startLine === startLine)
  if (!block) return null
  const edit = conflictReplacement(doc, block, choice)
  return content.slice(0, edit.from) + edit.insert + content.slice(edit.to)
}

/**
 * 应用某处冲突的取舍。文档在两次渲染之间可能变过,所以按**行号重新解析**,
 * 找到同一处冲突;标记已经不在时什么也不做(按钮对应的旧 DOM 不该写坏文档)。
 */
export function applyConflictChoice(
  view: EditorView,
  startLine: number,
  choice: ConflictChoice
): boolean {
  const doc = view.state.doc
  const block = findConflictBlocks(doc).find(item => item.startLine === startLine)
  if (!block) return false
  const edit = conflictReplacement(doc, block, choice)
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.from + edit.insert.length)
  })
  view.focus()
  return true
}

/**
 * 跳到下一处冲突(状态栏的「N 处冲突」按钮)。
 * 光标在最后一处冲突里时绕回第一处。
 */
export function jumpToNextConflict(view: EditorView): boolean {
  const blocks = findConflictBlocks(view.state.doc)
  if (blocks.length === 0) return false
  const head = view.state.selection.main.head
  const next = blocks.find(block => block.from > head) ?? blocks[0]!
  view.dispatch({
    selection: EditorSelection.cursor(next.from),
    effects: EditorView.scrollIntoView(next.from, { y: 'center' })
  })
  view.focus()
  return true
}

// ---------- 装饰与控件 ----------

function addLine(decos: Range<Decoration>[], line: Line, cls: string): void {
  decos.push({ from: line.from, to: line.from, value: Decoration.line({ class: cls }) })
}

function addReplace(
  decos: Range<Decoration>[],
  atomic: Range<Decoration>[],
  from: number,
  to: number,
  deco: Decoration
): void {
  decos.push({ from, to, value: deco })
  atomic.push({ from, to, value: deco })
}

type SectionKind = 'current' | 'incoming' | 'base'

/** 给一段内容行加底色;首尾行加圆角类 */
function styleSection(
  decos: Range<Decoration>[],
  doc: Text,
  firstLine: number,
  lastLine: number,
  kind: SectionKind
): void {
  if (lastLine < firstLine) return
  for (let n = firstLine; n <= lastLine; n++) {
    const classes = [`cm-md-conflict-line`, `cm-md-conflict-${kind}`]
    if (n === firstLine) classes.push('cm-md-conflict-first')
    if (n === lastLine) classes.push('cm-md-conflict-last')
    addLine(decos, doc.line(n), classes.join(' '))
  }
}

/** 起始标记行:操作栏 */
export class ConflictBarWidget extends WidgetType {
  constructor(
    readonly startLine: number,
    readonly index: number,
    readonly total: number,
    readonly oursLabel: string,
    readonly theirsLabel: string
  ) {
    super()
  }

  eq(other: ConflictBarWidget): boolean {
    return (
      other.startLine === this.startLine &&
      other.index === this.index &&
      other.total === this.total &&
      other.oursLabel === this.oursLabel &&
      other.theirsLabel === this.theirsLabel
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-md-conflict-bar cm-md-conflict-bar-current'
    bar.dataset.conflictIndex = String(this.index)
    bar.dataset.conflictTotal = String(this.total)
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', `合并冲突 ${this.index}/${this.total}`)

    const count = document.createElement('span')
    count.className = 'cm-md-conflict-count'
    count.textContent = `冲突 ${this.index}/${this.total}`

    const title = document.createElement('span')
    title.className = 'cm-md-conflict-title'
    title.textContent = '当前更改'
    if (this.oursLabel) {
      const ref = document.createElement('span')
      ref.className = 'cm-md-conflict-ref'
      ref.textContent = this.oursLabel
      title.appendChild(ref)
    }

    const actions = document.createElement('span')
    actions.className = 'cm-md-conflict-actions'
    const choices: Array<[ConflictChoice, string]> = [
      ['ours', '接受当前'],
      ['theirs', '接受传入'],
      ['both', '保留两者']
    ]
    for (const [choice, label] of choices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-md-conflict-btn'
      button.dataset.conflictAction = choice
      button.textContent = label
      button.title =
        choice === 'ours'
          ? '只保留当前分支的内容'
          : choice === 'theirs'
            ? '只保留传入分支的内容'
            : '当前分支与传入分支的内容都保留(当前在前)'
      button.addEventListener('mousedown', event => event.preventDefault())
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        applyConflictChoice(view, this.startLine, choice)
      })
      actions.appendChild(button)
    }

    bar.append(count, title, actions)
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** 分隔行:传入内容 / diff3 基准内容的标题条 */
export class ConflictDividerWidget extends WidgetType {
  constructor(
    readonly kind: 'incoming' | 'base',
    readonly label: string
  ) {
    super()
  }

  eq(other: ConflictDividerWidget): boolean {
    return other.kind === this.kind && other.label === this.label
  }

  toDOM(): HTMLElement {
    const divider = document.createElement('div')
    divider.className = `cm-md-conflict-divider cm-md-conflict-divider-${this.kind}`
    const left = document.createElement('span')
    left.className = 'cm-md-conflict-divider-line'
    const text = document.createElement('span')
    text.className = 'cm-md-conflict-divider-label'
    text.textContent = this.kind === 'incoming' ? '传入更改' : '基准版本'
    if (this.label) {
      const ref = document.createElement('span')
      ref.className = 'cm-md-conflict-ref'
      ref.textContent = this.label
      text.appendChild(ref)
    }
    const right = document.createElement('span')
    right.className = 'cm-md-conflict-divider-line'
    divider.append(left, text, right)
    return divider
  }

  ignoreEvent(): boolean {
    return true
  }
}

/**
 * 把冲突块的装饰并入 WYSIWYG 的装饰集合。
 *
 * 标记行整行替换成操作栏/分隔条;内容行只加行装饰,文本保持可编辑。标记行
 * 同时进 atomicRanges,方向键不会把光标塞进看不见的标记里。
 */
export function addConflictDecorations(
  decos: Range<Decoration>[],
  atomic: Range<Decoration>[],
  doc: Text,
  blocks: readonly ConflictBlock[]
): void {
  for (const block of blocks) {
    const start = doc.line(block.startLine)
    const separator = doc.line(block.separatorLine)
    const end = doc.line(block.endLine)
    const base = block.baseLine ? doc.line(block.baseLine) : null

    addLine(decos, start, 'cm-md-conflict-host')
    addReplace(
      decos,
      atomic,
      start.from,
      start.to,
      Decoration.replace({
        widget: new ConflictBarWidget(
          block.startLine,
          block.index,
          blocks.length,
          block.oursLabel,
          block.theirsLabel
        )
      })
    )
    styleSection(decos, doc, start.number + 1, (base ?? separator).number - 1, 'current')

    if (base) {
      addLine(decos, base, 'cm-md-conflict-host')
      addReplace(
        decos,
        atomic,
        base.from,
        base.to,
        Decoration.replace({
          widget: new ConflictDividerWidget('base', block.baseLabel)
        })
      )
      styleSection(decos, doc, base.number + 1, separator.number - 1, 'base')
    }

    addLine(decos, separator, 'cm-md-conflict-host')
    addReplace(
      decos,
      atomic,
      separator.from,
      separator.to,
      Decoration.replace({
        widget: new ConflictDividerWidget('incoming', block.theirsLabel)
      })
    )
    styleSection(decos, doc, separator.number + 1, end.number - 1, 'incoming')

    addLine(decos, end, 'cm-md-conflict-host cm-md-conflict-end')
    addReplace(decos, atomic, end.from, end.to, Decoration.replace({}))
  }
}
