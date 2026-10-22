import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { MenuCommandId } from '@shared/ipc-channels'

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
