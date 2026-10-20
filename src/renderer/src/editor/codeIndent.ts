import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { EDITOR_DEFAULTS, type CodeIndentSize } from '@shared/editorSettings'

/**
 * 代码块内的 Tab:在光标处插入空格,而不是把焦点移出编辑器。
 *
 * 和软换行一样,这是「偏好」而不是文档状态:Tab 只在按键那一刻读值,
 * 所以不需要 compartment、也不用重建 state —— 设置面板改完,下一次按键就生效。
 * 放在模块级变量里还避免了让 keymap 去 import Vue store(编辑器层目前不依赖它)。
 */
let codeIndentSize: CodeIndentSize = EDITOR_DEFAULTS.codeIndentSize

export function setCodeIndentPreference(size: CodeIndentSize): void {
  codeIndentSize = size
}

/**
 * 这一行是否属于代码块**内容**。
 *
 * 围栏行(```python / ```)不算:它们只有 CodeMark / CodeInfo,没有 CodeText。
 * 在围栏行行首按 Tab 会往 ``` 前面塞空格,把围栏变成缩进代码块 —— 得留给默认行为。
 * 缩进代码块也一样有 CodeText(或外层 CodeBlock),空行则被跨行的 CodeText 覆盖。
 */
function lineHasCode(state: EditorState, from: number, to: number): boolean {
  let found = false
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'CodeText' || node.name === 'CodeBlock') {
        found = true
        return false
      }
      return undefined
    }
  })
  return found
}

/**
 * Tab 键命令:所有选区都完整落在代码块里时,用 N 个空格替换选区(空选区即插入);
 * 否则返回 false,让 Tab 走默认路径(移动焦点)。
 *
 * 按行遍历而不是只看光标位置:缩进代码块的节点从第 5 列才开始,光标停在行首
 * 那 4 个空格里时 resolveInner 找不到它(和 lineMenu 的 inCodeBlock 同一个原因)。
 */
export function insertCodeIndent(view: EditorView): boolean {
  const { state } = view
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from)
    const last = state.doc.lineAt(range.to)
    for (let n = first.number; n <= last.number; n++) {
      const line = state.doc.line(n)
      if (!lineHasCode(state, line.from, line.to)) return false
    }
  }

  const spaces = ' '.repeat(codeIndentSize)
  view.dispatch(
    state.update(state.replaceSelection(spaces), { scrollIntoView: true, userEvent: 'input' })
  )
  return true
}
