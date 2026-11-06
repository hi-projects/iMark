import { StateField, type EditorState, type Transaction } from '@codemirror/state'

/**
 * 「刚敲出来、还没回车补全」的开围栏行(行首位置)。没有待定围栏时为 null。
 *
 * 为什么需要单独记一笔,而不是看语法树:在已有笔记中间敲 ``` 时,新围栏可能
 * 和文档下方一条本来就存在的围栏(比如作者还没写完的代码块)配成一对 ——
 * 语法树看到的是一个**已闭合**的代码块,整段正文都被读成代码;只看树既分不清
 * 「正在敲围栏」和「编辑已有代码块的开围栏行」,也没法判断回车该不该补全。
 *
 * 这里只认一种来源:用户敲字把某一行补成了围栏(敲下第三个反引号的那一刻)。
 * 粘贴、撤销、在已有围栏行上改字都不算。记录一直保留到光标离开这行、这行不再
 * 是围栏,或者回车补全把光标送到新插入的空行上为止。
 *
 * 行首围栏的判定与 CommonMark 一致:最多 3 格缩进;反引号围栏的 info string
 * 里不能再有反引号(有的话这一行根本不是围栏)。引用 / 列表里的围栏前面还带
 * 容器标记(如「> ```」「- ```」),判定只看标记后面的围栏部分;这里放宽一点
 * 不会误事 —— 真正要不要补全,commands 那边还会用语法树再核一遍。
 *
 * 块级公式的开标记 `$$` / `\[` 也走同一套「待定围栏」:刚敲完还没回车时按
 * 普通文本显示。只认光秃秃的开标记(后面只允许空白)——`$$x` 已经是用户在
 * 写公式,再按回车该换行,不能替他闭合。`$$$` 不是公式(与解析器一致)。
 */
const FENCE_LINE =
  /^(?:[ \t]*(?:>\s*|[-*+]\s+|\d+[.)]\s+))*[ \t]*(?:`{3,}[^`]*|~{3,}.*|(?:\$\$(?!\$)|\\\[)[ \t]*)$/

/** 整行文本是不是一条围栏行(代码围栏 / 块级公式开标记) */
export function isFenceLineText(text: string): boolean {
  return FENCE_LINE.test(text)
}

/** 单个空选区且贴在行尾 */
function caretAtLineEnd(state: EditorState): boolean {
  const sel = state.selection
  return sel.ranges.length === 1 && sel.main.empty && sel.main.head === state.doc.lineAt(sel.main.head).to
}

/** 单个空选区且贴在 pos 这一行的行尾(光标必须还在这行上) */
function caretAtLineEndOf(state: EditorState, pos: number): boolean {
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return false
  const line = state.doc.lineAt(sel.main.head)
  return line.from === pos && sel.main.head === line.to
}

/** pos 正好是一行围栏的行首 */
function isFenceLineStart(state: EditorState, pos: number): boolean {
  if (pos < 0 || pos > state.doc.length) return false
  const line = state.doc.lineAt(pos)
  return line.from === pos && FENCE_LINE.test(line.text)
}

/** 这次输入是不是把某一行从普通文本补成了围栏 */
function newlyTypedFence(tr: Transaction): number | null {
  const state = tr.state
  if (!caretAtLineEnd(state)) return null
  const line = state.doc.lineAt(state.selection.main.head)
  if (!FENCE_LINE.test(line.text)) return null
  // 变更前这一行已经是围栏:是在改已有围栏(比如补语言名),不是在新建
  const old = tr.startState.doc
  if (line.number <= old.lines && FENCE_LINE.test(old.line(line.number).text)) return null
  return line.from
}

export const pendingFenceField = StateField.define<number | null>({
  create: () => null,
  update(pending, tr) {
    // 旧记录跟着文档平移;仍然是一条围栏行、光标还在行尾才保留。
    // 回车补全后光标落在中间空行上,这里自然把记录清掉。
    if (pending !== null) {
      const pos = tr.changes.mapPos(pending, -1)
      if (isFenceLineStart(tr.state, pos) && caretAtLineEndOf(tr.state, pos)) return pos
    }
    if (!tr.docChanged || !tr.isUserEvent('input.type')) return null
    return newlyTypedFence(tr)
  }
})

export function getPendingFence(state: EditorState): number | null {
  return state.field(pendingFenceField, false) ?? null
}
