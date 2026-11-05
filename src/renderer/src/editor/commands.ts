import { selectAll } from '@codemirror/commands'
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type ChangeSpec, type EditorState, type Line } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MenuCommandId } from '@shared/ipc-channels'
import { getPendingFence } from './pendingFence'

/**
 * 格式命令:工具栏 / 键位 / 原生菜单三端共用。
 * 全部围绕选区操作文档,只动必要字符,undo 记录干净。
 */

// ---------- 包裹类(粗体 / 斜体 / 删除线 / 行内代码) ----------

/**
 * 切换包裹标记:已被同 marker 包裹 → 解开;否则包裹。
 * 选区为空时作用于光标处单词。
 * 选区映射用 ChangeSet.mapPos:包裹时 assoc=1(取插入标记之后),解开时 assoc=-1(取删除区间之前)。
 */
export function toggleWrap(view: EditorView, marker: string): boolean {
  const state = view.state
  const m = marker.length

  interface Target {
    from: number
    to: number
    unwrap: boolean
  }
  const targets: Target[] = []
  for (const r of state.selection.ranges) {
    let range = r
    if (r.empty) {
      const word = state.wordAt(r.from)
      if (!word) continue
      range = EditorSelection.range(word.from, word.to)
    }
    const before = state.sliceDoc(Math.max(0, range.from - m), range.from)
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + m))
    targets.push({ from: range.from, to: range.to, unwrap: before === marker && after === marker })
  }
  if (targets.length === 0) return false

  const changes: { from: number; to?: number; insert?: string }[] = []
  for (const t of targets) {
    if (t.unwrap) {
      changes.push({ from: t.from - m, to: t.from })
      changes.push({ from: t.to, to: t.to + m })
    } else {
      changes.push({ from: t.from, insert: marker })
      changes.push({ from: t.to, insert: marker })
    }
  }
  changes.sort((a, b) => (a.from ?? 0) - (b.from ?? 0))

  const tr = state.update({ changes })
  const newRanges = targets.map(t => {
    if (t.unwrap) {
      return EditorSelection.range(
        tr.changes.mapPos(t.from, -1),
        tr.changes.mapPos(t.to, -1)
      )
    }
    return EditorSelection.range(tr.changes.mapPos(t.from, 1), tr.changes.mapPos(t.to, 1))
  })

  view.dispatch({
    changes: tr.changes,
    selection: EditorSelection.create(newRanges),
    scrollIntoView: true
  })
  return true
}

export function toggleBold(view: EditorView): boolean {
  return toggleWrap(view, '**')
}
export function toggleItalic(view: EditorView): boolean {
  return toggleWrap(view, '*')
}
export function toggleStrikethrough(view: EditorView): boolean {
  return toggleWrap(view, '~~')
}
export function toggleInlineCode(view: EditorView): boolean {
  return toggleWrap(view, '`')
}

// ---------- 行前缀类(列表 / 引用 / 任务) ----------

type PrefixKind = 'bullet' | 'ordered' | 'task' | 'quote'

interface ParsedLine {
  lineFrom: number
  indentEnd: number
  /** 现有前缀结束位置(无前缀时等于 indentEnd) */
  prefixEnd: number
  kind: PrefixKind | null
  prefixText: string
}

function parseLinePrefix(state: EditorState, lineNo: number): ParsedLine {
  const line = state.doc.line(lineNo)
  const text = line.text
  const indentMatch = /^\s*/.exec(text)!
  const indentEnd = indentMatch[0].length
  const rest = text.slice(indentEnd)

  let kind: PrefixKind | null = null
  let prefixLen = 0
  let m: RegExpExecArray | null

  if ((m = /^>\s?/.exec(rest))) {
    kind = 'quote'
    prefixLen = m[0].length
  } else if ((m = /^[-*+]\s(?:\[[ xX]\]\s)?/.exec(rest)) && /\[[ xX]\]/.test(m[0])) {
    kind = 'task'
    prefixLen = m[0].length
  } else if ((m = /^[-*+]\s/.exec(rest))) {
    kind = 'bullet'
    prefixLen = m[0].length
  } else if ((m = /^\d+[.)]\s(?:\[[ xX]\]\s)?/.exec(rest)) && /\[[ xX]\]/.test(m[0])) {
    kind = 'task'
    prefixLen = m[0].length
  } else if ((m = /^\d+[.)]\s/.exec(rest))) {
    kind = 'ordered'
    prefixLen = m[0].length
  }

  return {
    lineFrom: line.from,
    indentEnd: line.from + indentEnd,
    prefixEnd: line.from + indentEnd + prefixLen,
    kind,
    prefixText: prefixLen > 0 ? rest.slice(0, prefixLen) : ''
  }
}

function makePrefix(kind: PrefixKind, n: number): string {
  switch (kind) {
    case 'bullet':
      return '- '
    case 'ordered':
      return `${n}. `
    case 'task':
      return '- [ ] '
    case 'quote':
      return '> '
  }
}

/** 行前缀切换:全部已带目标前缀 → 移除;否则统一替换/插入目标前缀 */
export function toggleLinePrefix(view: EditorView, kind: PrefixKind): boolean {
  const state = view.state
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number

  const parsed: ParsedLine[] = []
  for (let n = fromLine; n <= toLine; n++) parsed.push(parseLinePrefix(state, n))
  if (parsed.length === 0) return false

  const allHave = parsed.every(p => p.kind === kind)
  const changes: ChangeSpec[] = []
  let counter = 1
  for (const p of parsed) {
    if (allHave) {
      if (p.prefixEnd > p.indentEnd) {
        changes.push({ from: p.indentEnd, to: p.prefixEnd })
      }
    } else {
      const target = makePrefix(kind, kind === 'ordered' ? counter++ : 1)
      // 任务列表转换时保留原有序号形态;其余行从 1 递增
      changes.push({
        from: p.indentEnd,
        to: p.prefixEnd,
        insert: p.kind === 'ordered' && kind === 'task' ? `${counter++}. [ ] ` : target
      })
    }
  }

  view.dispatch({ changes, scrollIntoView: true })
  return true
}

export function toggleBulletList(view: EditorView): boolean {
  return toggleLinePrefix(view, 'bullet')
}
export function toggleOrderedList(view: EditorView): boolean {
  return toggleLinePrefix(view, 'ordered')
}

/**
 * 删除空的列表项时,把标记和 CodeMirror 补出来的对齐空格一起清掉。
 *
 * `deleteMarkupBackward` 对**非首个**列表项会把标记换成等宽空格,让转成正文的
 * 内容保持缩进;但列表项已经空了时,这些空格只会让光标停在内容列,看起来像
 * 没有顶格。先让它处理(有序列表的重新编号也归它),再把整行只剩空白的缩进清掉。
 *
 * 只处理顶格的空列表项:嵌套列表/引用里的标记仍交给 CodeMirror 逐级反缩进。
 */
export function deleteEmptyListMarkup(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  if (!/^(?:[-+*]|\d{1,9}[.)])[ \t]*$/.test(before) || /\S/.test(after)) return false
  if (!deleteMarkupBackward(view)) return false

  const next = view.state
  const nextSel = next.selection.main
  if (!nextSel.empty) return true
  const nextLine = next.doc.lineAt(nextSel.head)
  if (nextSel.head === nextLine.to && /^[ \t]+$/.test(nextLine.text)) {
    view.dispatch({
      changes: { from: nextLine.from, to: nextLine.to },
      selection: { anchor: nextLine.from },
      userEvent: 'delete'
    })
  }
  return true
}

/**
 * 空的列表项上按回车 = 退出列表。默认的 `insertNewlineContinueMarkup`
 * 只把 `- ` 标记删掉,光标留在原地;如果列表下面紧接着正文(中间没有空行),
 * 用户接下来输入的内容在 CommonMark 里仍算最后一项的懒续行,别的
 * Markdown 编辑器会把这段正文排进列表。
 *
 * 这里在默认命令退出列表之后,让列表和光标之间始终隔一条空行:光标落到
 * 空行**下面**一行,输入的第一个字从新段落开始。源码因此是标准 Markdown,
 * 不依赖 iMark 的显示规则。
 *
 * 只处理顶格列表的最后一项;嵌套列表 / 引用里的空项仍交给默认命令逐级
 * 处理。默认命令把空项改成松散列表(标记还在)时也保持原样。
 */
export function exitListOnEmptyItem(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection.main
  if (!sel.empty) return false
  if (!isLastTopLevelEmptyListItem(state, state.doc.lineAt(sel.head))) return false
  if (!insertNewlineContinueMarkup(view)) return false

  const next = view.state
  const caretLine = next.doc.lineAt(next.selection.main.head)
  // 标记没被删掉(例如改成松散列表):这次回车不是在退出列表
  if (/\S/.test(caretLine.text)) return true
  // 光标这行上面已经是一条空行(松散列表再退一次):已经隔开了,不用再补
  if (caretLine.number > 1 && !/\S/.test(next.doc.line(caretLine.number - 1).text)) return true
  const after = caretLine.number < next.doc.lines ? next.doc.line(caretLine.number + 1) : null
  if (after && !/\S/.test(after.text)) {
    // 下面已经是一条空行:它留作分隔,光标移过去
    view.dispatch({ selection: { anchor: after.from }, scrollIntoView: true })
  } else {
    // 下面直接是正文(或已经是文末):补一条空行,光标落到新空行的行首
    view.dispatch({
      changes: { from: caretLine.to, insert: next.lineBreak },
      selection: { anchor: caretLine.to + next.lineBreak.length },
      scrollIntoView: true
    })
  }
  return true
}

/** 顶格列表里最后一个、且只剩标记的空项(`- ` / `1. `) */
function isLastTopLevelEmptyListItem(state: EditorState, line: Line): boolean {
  if (!/^(?:[-+*]|\d{1,9}[.)])[ \t]+$/.test(line.text)) return false
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + 1, 1); node; node = node.parent) {
    if (node.name !== 'ListItem') continue
    const list = node.parent
    if (!list || (list.name !== 'BulletList' && list.name !== 'OrderedList')) return false
    if (list.parent?.name !== 'Document') return false
    return !node.nextSibling
  }
  return false
}

// ---------- 段落回车 / 段内换行 ----------

/**
 * 这些节点里的回车不该改文档结构:代码块、表格、公式、HTML 块、分隔线。
 * 光标在这些地方回车,仍走原来的命令(补普通换行)。
 */
const ATOMIC_BLOCKS = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'Table',
  'TableHeader',
  'TableRow',
  'TableCell',
  'MathBlock',
  'DisplayMath',
  'InlineMath',
  'HTMLBlock',
  'HorizontalRule'
])

const QUOTE_NODES = new Set(['Blockquote'])

const HEADING_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2'
])

/**
 * 正文里回车 = 新段。
 *
 * Markdown 的段落由空行分隔。界面上把回车理解成「换段」,所以源码里补一个
 * 换行符 —— 行尾多出的那条空行就是段落分隔,光标落在空行下面,敲下的第一个
 * 字直接开始新段。导出的文件在任何 Markdown 编辑器里都是两段,不依赖 iMark
 * 自己的显示规则。
 *
 * 空行上回车只补一行:空行本身就是分隔,再补两行会连出三条空行。
 * 标题行尾回车也按新段,但标题本身就是块边界,新段不需要再和它隔空行 ——
 * 比正文少补一条,否则标题后面一按回车同样会连出三条空行。
 * 代码 / 表格 / 公式 / 引用 / 列表标记行 / 缩进行返回 false,交给原有命令
 * (继续列表、继续引用、代码里换行等),那个方向上的语义不变。
 */
export function insertParagraph(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection
  // 多光标 / 有选区:交给默认回车,先删选区再断行
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  const pos = sel.main.head
  const line = state.doc.lineAt(pos)
  const kind = bodyLineKind(state, line)
  if (kind === 'other') return false
  const lb = state.lineBreak

  // 空行上回车只补一行:空行本身就是分隔
  if (kind === 'blank') return breakAt(view, pos, lb, lb.length)

  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null
  // 标题到行尾就自己结束了:下面接正文不需要空行分隔,新段可以紧贴着标题。
  // 所以比正文少补一个换行 —— 少补的正是「标题和它下面那条空行之间」那条,
  // 不然标题后面一按回车,屏幕上就连出三条空行。段中回车是断标题,仍按正文处理。
  const selfEnding = kind === 'heading' && pos === line.to

  // 光标在行尾、下一行还是同一段(源码里的软换行):从中间断段,光标落到
  // 断点之后的文字上 —— 和普通编辑器「段落中间回车」一致。这里只需要补一个
  // 换行:原来的行尾换行就是新段和前一段之间的空行。
  if (pos === line.to && next && /\S/.test(next.text)) {
    if (inSameParagraph(state, line, next)) return breakAt(view, pos, lb, lb.length * 2)
    // 下一行已经是另一个块的开头:新段两边都得留空行,否则会并进相邻段落。
    // 标题上面那一侧不用留,少补一条。
    return selfEnding
      ? breakAt(view, pos, lb + lb, lb.length)
      : breakAt(view, pos, lb + lb + lb, lb.length * 2)
  }
  // 标题后面只剩空行(文末):直接把光标挪到下面那条空行上。文件末尾本来
  // 就有换行,再补就是往源码里堆空行。敲下的字紧接在标题下面,仍是新段。
  if (selfEnding && next && !hasContentAfter(state, next)) {
    view.dispatch({ selection: EditorSelection.cursor(next.from), scrollIntoView: true })
    return true
  }
  // 段尾(下一行是空行或文末)/ 行中间:补一条空行,光标落到空行下面
  return selfEnding
    ? breakAt(view, pos, lb, lb.length)
    : breakAt(view, pos, lb + lb, lb.length * 2)
}

/** 这一行往下还有没有正文(标题后面全是空行 = 文末) */
function hasContentAfter(state: EditorState, line: Line): boolean {
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    if (/\S/.test(state.doc.line(n).text)) return true
  }
  return false
}

function breakAt(view: EditorView, pos: number, insert: string, caretOffset: number): boolean {
  view.dispatch({
    changes: { from: pos, insert },
    selection: EditorSelection.cursor(pos + caretOffset),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/**
 * 光标这一行和下一行是不是同一个段落 —— 也就是源码里的软换行。
 * 段落节点跨过两行时,下一行的行首还落在同一个 Paragraph 的范围内。
 */
function inSameParagraph(state: EditorState, line: Line, next: Line): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.to - 1, -1)
  while (node && node.name !== 'Paragraph') node = node.parent
  return !!node && next.from < node.to
}

/**
 * Shift+回车 = 段内换行。源码写成硬换行(行尾两个空格 + 换行),别的编辑器
 * 渲染成同一段里的一次换行;iMark 里两行仍是同一个段落(行间距,不是段间距)。
 *
 * 列表项 / 引用里要留在原来的容器里:把容器前缀复制到下一行(列表换成等宽
 * 缩进,引用保留 `> `),否则下一行会掉出列表或引用。代码块里两个空格会被
 * 当成代码内容,只插普通换行;空行和标题行也没有「段内」可言。
 */
export function insertHardBreak(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  const pos = sel.main.head
  const line = state.doc.lineAt(pos)
  const node = nodeAtLineStart(state, line)
  const plain =
    !/\S/.test(line.text) ||
    hasAncestor(node, HEADING_NODES) ||
    hasAncestor(node, ATOMIC_BLOCKS) ||
    codeBlockCovering(state, pos) !== null
  const insert = plain ? state.lineBreak : '  ' + state.lineBreak + continuationPrefix(line.text)
  view.dispatch({
    changes: { from: pos, insert },
    selection: EditorSelection.cursor(pos + insert.length),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/**
 * 光标所在行在 Markdown 结构里算什么。
 *
 * plain 是正文段落行(含列表下面没带标记的懒续行),heading 是标题行,
 * blank 是段落之间的空行;代码 / 表格 / 公式 / HTML 块 / 分隔线、引用里的人
 * 任何一行、列表标记行、缩进行都算 other,回车交给原有命令。
 */
function bodyLineKind(state: EditorState, line: Line): 'plain' | 'heading' | 'blank' | 'other' {
  const node = nodeAtLineStart(state, line)
  if (hasAncestor(node, ATOMIC_BLOCKS) || codeBlockCovering(state, line.from)) return 'other'
  if (!/\S/.test(line.text)) return 'blank'
  // 引用:行首带 `>`,或者是引用里的懒续行(祖先里有 Blockquote)
  if (/^[ \t]*>/.test(line.text) || hasAncestor(node, QUOTE_NODES)) return 'other'
  // 列表标记行(列表项之间的回车由 markdownKeymap 负责)
  if (/^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line.text)) return 'other'
  // 缩进行:缩进代码块已经排除,剩下的是列表 / 引用的续行
  if (/^[ \t]/.test(line.text)) return 'other'
  if (hasAncestor(node, HEADING_NODES)) return 'heading'
  return 'plain'
}

/** 行首第一个非空白字符处的语法节点;整行空白时取行首 */
function nodeAtLineStart(state: EditorState, line: Line): SyntaxNode | null {
  const offset = line.text.search(/\S/)
  return syntaxTree(state).resolveInner(line.from + (offset < 0 ? 0 : offset), 1)
}

function hasAncestor(node: SyntaxNode | null, names: ReadonlySet<string>): boolean {
  for (let cur = node; cur; cur = cur.parent) if (names.has(cur.name)) return true
  return false
}

/**
 * 段内换行后下一行的行首前缀。
 *
 * 引用标记原样保留(可以多层);列表标记换成内容列的等宽空格,下一行仍是
 * 同一项的内容;普通缩进行保留缩进。懒续行 / 正文返回空串。
 */
function continuationPrefix(text: string): string {
  let i = 0
  let quote = ''
  for (;;) {
    const m = /^[ \t]*>[ \t]?/.exec(text.slice(i))
    if (!m) break
    quote += m[0]
    i += m[0].length
  }
  const rest = text.slice(i)
  const list = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(rest)
  if (list) {
    const contentCol = i + list[0].length
    return quote + ' '.repeat(Math.max(0, contentCol - quote.length))
  }
  if (quote) return quote
  return /^[ \t]*/.exec(text)![0]
}

export function toggleTaskList(view: EditorView): boolean {
  return toggleLinePrefix(view, 'task')
}
export function toggleBlockQuote(view: EditorView): boolean {
  return toggleLinePrefix(view, 'quote')
}

// ---------- 标题 ----------

export function setHeading(view: EditorView, level: number): boolean {
  const state = view.state
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const changes: ChangeSpec[] = []
  let touched = false

  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n)
    const m = /^(\s*)(#{1,6}\s+)?/.exec(line.text)!
    const indentEnd = line.from + m[1].length
    const currentLevel = m[2] ? m[2].trim().length : 0
    const target = level === 0 || currentLevel === level ? '' : `${'#'.repeat(level)} `
    if ((m[2] ?? '') !== target) {
      changes.push({ from: indentEnd, to: indentEnd + (m[2]?.length ?? 0), insert: target })
      touched = true
    }
  }
  if (!touched) return false
  view.dispatch({ changes, scrollIntoView: true })
  return true
}

// ---------- 插入类 ----------

export function insertCodeBlock(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection.main
  const text = state.sliceDoc(sel.from, sel.to)
  const insert = '```\n' + text + (text === '' || text.endsWith('\n') ? '' : '\n') + '```\n'
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.cursor(sel.from + 4),
    scrollIntoView: true
  })
  return true
}

/**
 * 围栏行尾回车:把「刚敲出来的半个代码块」一次性补完整。
 *
 * 在空行上敲 ``` 时,CommonMark 立刻把后面所有内容都读成代码 —— 光标还在
 * 围栏行上,下面的正文却已经变成代码正文,再往下写什么都进了代码块。这里在
 * 回车时补一条空行和闭合围栏,块里只留一行可写的空行,后面的内容仍是正文。
 *
 * 只对 pendingFence.ts 记下的「刚敲出来的围栏行」生效,而且光标必须还在
 * 行尾:已有代码块的开围栏行、闭合围栏行、光标停在围栏行中间,回车都照常
 * 断行——在已有围栏行上回车不该凭空多出一条闭合围栏。
 *
 * 这里刻意不要求语法树里围栏「未闭合」:笔记下方可能本来就有一条没写完的
 * 围栏,新敲的这条会和它配成对,树看到的是已闭合的块。用户要的是在光标处
 * 新建一个空代码块,不该和远处那条围栏扯上关系。
 */
function fenceAtLineStart(state: EditorState, line: Line): { fence: string; prefix: string } | null {
  let found: { fence: string; prefix: string } | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(ref) {
      if (ref.name !== 'FencedCode') return undefined
      const first = ref.node.firstChild
      // 开围栏必须在这一行上;块从上一行开始时,这一行是代码正文
      if (!first || first.name !== 'CodeMark' || first.from < line.from) return false
      found = {
        fence: state.sliceDoc(first.from, first.to),
        prefix: state.sliceDoc(line.from, first.from)
      }
      return false
    }
  })
  return found
}

/**
 * 补出来的空行和闭合围栏要用的行首前缀。
 *
 * 顶栏围栏(只带缩进)一律顶格:闭合围栏允许 0–3 空格,空行更不该平白往代码
 * 里塞两个空格。引用 / 列表里的围栏必须留在容器里:引用标记原样保留,列表标记
 * 换成等宽空格(与内容列对齐),否则新行会掉出容器,围栏也闭合不到块里。
 */
function fencePrefix(prefix: string): string {
  return /^\s*$/.test(prefix) ? '' : prefix.replace(/[^\s>]/g, ' ')
}

export function completeFenceOnEnter(view: EditorView): boolean {
  const state = view.state
  const sel = state.selection
  // 多光标 / 有选区:交给默认回车,别替用户决定在哪儿补围栏
  if (sel.ranges.length > 1 || !sel.main.empty) return false
  const pos = sel.main.head
  const line = state.doc.lineAt(pos)
  if (pos !== line.to) return false
  // 只认刚敲出来、光标还停着的围栏行(见 pendingFence.ts)
  if (getPendingFence(state) !== line.from) return false
  const opener = fenceAtLineStart(state, line)
  if (!opener) return false
  const prefix = fencePrefix(opener.prefix)
  const insert = `\n${prefix}\n${prefix}${opener.fence}`
  view.dispatch({
    changes: { from: pos, insert },
    // 光标落在开围栏和闭合围栏中间的那条空行上
    selection: EditorSelection.cursor(pos + 1 + prefix.length),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

export function insertHorizontalRule(view: EditorView): boolean {
  const state = view.state
  const line = state.doc.lineAt(state.selection.main.to)
  view.dispatch({
    changes: { from: line.to, insert: '\n\n---\n\n' },
    selection: EditorSelection.cursor(line.to + 7),
    scrollIntoView: true
  })
  return true
}

export function insertLink(view: EditorView): boolean {
  return insertLinkLike(view, '[', ']($0)', 'https://')
}

export function insertImage(view: EditorView): boolean {
  return insertLinkLike(view, '![', ']($0)', 'https://')
}

/**
 * 插入链接/图片并选中 URL 占位文本。
 * $0 表示 URL 占位:生成 `[label](url)`,选中 url 部分。
 */
function insertLinkLike(view: EditorView, head: string, tail: string, urlPlaceholder: string): boolean {
  const state = view.state
  const sel = state.selection.main
  const label = state.sliceDoc(sel.from, sel.to) || '链接'
  const insert = head + label + tail.replace('$0', urlPlaceholder)
  // head + label 之后,跳过 tail 中 $0 之前的字符(如 '(',得到 URL 起始位置
  const urlStart = sel.from + head.length + label.length + tail.indexOf('$0')
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + urlPlaceholder.length),
    scrollIntoView: true
  })
  return true
}

// ---------- 菜单命令分发 ----------

export function runFormatCommand(view: EditorView, id: MenuCommandId): void {
  view.focus()
  switch (id) {
    case 'format:bold':
      toggleBold(view)
      break
    case 'format:italic':
      toggleItalic(view)
      break
    case 'format:strike':
      toggleStrikethrough(view)
      break
    case 'format:inline-code':
      toggleInlineCode(view)
      break
    case 'format:code-block':
      insertCodeBlock(view)
      break
    case 'format:quote':
      toggleBlockQuote(view)
      break
    case 'format:bullet-list':
      toggleBulletList(view)
      break
    case 'format:ordered-list':
      toggleOrderedList(view)
      break
    case 'format:task-list':
      toggleTaskList(view)
      break
    case 'format:hr':
      insertHorizontalRule(view)
      break
    case 'format:h1':
      setHeading(view, 1)
      break
    case 'format:h2':
      setHeading(view, 2)
      break
    case 'format:h3':
      setHeading(view, 3)
      break
    case 'format:h4':
      setHeading(view, 4)
      break
    case 'format:h5':
      setHeading(view, 5)
      break
    case 'format:h6':
      setHeading(view, 6)
      break
    case 'format:plain':
      setHeading(view, 0)
      break
    case 'format:link':
      insertLink(view)
      break
    case 'format:image':
      insertImage(view)
      break
    default:
      break
  }
}

// ---------- 全选 ----------

/**
 * 覆盖这一行的代码块节点(FencedCode / 缩进 CodeBlock)。
 *
 * 按行遍历而不是只看光标位置:缩进代码块的节点从第 5 列才开始,
 * 光标停在行首那 4 个空格里时 resolveInner 找不到它(和 codeIndent 同一个原因)。
 */
function codeBlockCovering(state: EditorState, pos: number): SyntaxNode | null {
  const line = state.doc.lineAt(pos)
  let found: SyntaxNode | null = null
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(ref) {
      if (ref.name === 'FencedCode' || ref.name === 'CodeBlock') {
        found = ref.node
        return false
      }
      return undefined
    }
  })
  return found
}

/**
 * 代码块正文的范围。
 *
 * 围栏块:只取 CodeText 子节点 —— 围栏行本身,以及引用 / 列表的容器前缀
 * (`> ` / `- `)都不算正文,和右上角复制按钮取的是同一段源码
 * (见 wysiwyg/rules.ts 的 readCodeSource)。
 * 缩进块:选整行(含行首的 4 个空格),复制出去仍是合法的缩进代码块。
 */
function codeContentRange(state: EditorState, block: SyntaxNode): { from: number; to: number } | null {
  if (block.name === 'CodeBlock') {
    return { from: state.doc.lineAt(block.from).from, to: state.doc.lineAt(block.to).to }
  }
  let from = -1
  let to = -1
  for (let child = block.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'CodeText') continue
    if (from < 0) from = child.from
    to = child.to
  }
  return from < 0 ? null : { from, to }
}

/**
 * Ctrl+A:光标 / 选区在代码块里时,永远只选这一块代码(重复按也不扩大)。
 * 要选整篇得先把光标移出代码块。
 *
 * 不在代码块里返回 false,全选行为完全交给默认 keymap。
 */
export function selectAllInCodeBlock(view: EditorView): boolean {
  const state = view.state
  // 多光标:按常规全选处理,别只改主选区
  if (state.selection.ranges.length > 1) return false
  const sel = state.selection.main
  const block = codeBlockCovering(state, sel.from)
  if (!block) return false
  // 选区另一头已经跨出这个代码块(例如上一次已是整篇):交给整篇全选
  const tail = codeBlockCovering(state, sel.to)
  if (!tail || tail.from !== block.from || tail.to !== block.to) return false
  const content = codeContentRange(state, block)
  if (!content) return false
  // 已经正好选中这块:不重复派发事务,直接吃掉这次按键
  if (sel.from === content.from && sel.to === content.to) return true
  view.dispatch({
    selection: { anchor: content.from, head: content.to },
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

/** 菜单「全选」:编辑器拿着焦点时先按代码块选,其余情况用 CM 的整篇全选 */
export function selectAllSmart(view: EditorView): void {
  if (selectAllInCodeBlock(view)) return
  selectAll(view)
}
