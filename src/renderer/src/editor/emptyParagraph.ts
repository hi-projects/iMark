import { Annotation, StateField, type EditorState } from '@codemirror/state'

/**
 * 这次事务是「回车 = 新段」补出来的(见 commands.ts 的 breakAt)。
 *
 * 只有它会在光标落在空行上时留下空段落;方向键在空行之间移动、Shift+回车、
 * 代码块里回车都不算。
 */
export const paragraphBreak = Annotation.define<boolean>()

/**
 * 同 paragraphBreak,但**不**留下回车前的那条空行。
 *
 * 退出列表时,空项行会被删成空行,再在下面补一条分隔空行;前一条是结构
 * 分隔,不是用户的空段落,记下来会让列表后凭空多出一整行。
 */
export const paragraphBreakAfter = Annotation.define<boolean>()

/**
 * 点击文末空白新起的段落(见 build.ts 的 clickBelowDocEnd / openTailParagraph)。
 *
 * 文档里临时补出来的空行只在用户真输入时留下;光标一移开就撤回,
 * 但撤回前这一行也是「空段落」,得按整行留高,否则光标会落进收紧后的间距里。
 */
export const paragraphClick = Annotation.define<boolean>()

/**
 * 回车创建、还空着的段落行首位置(升序)。没有空段落时是空数组。
 *
 * 「回车 = 新段」在源码里补出来的新段是一条空行。光标停上去时靠
 * caretOnGapLine 撑成整行;光标一离开,这条空行就和相邻的结构空行一起被
 * collapseBlankRuns 收紧成段间距,点击又会落进 `cm-md-block-gap` 的点击
 * 重定向 —— 第二段既看不见也点不回去,像是被第一段吞掉了。
 *
 * 所以**回车时**把光标落到的空行记下来(在空行上回车时,回车前那条空段落
 * 也一并留下:它也是一段)。这些行在渲染时继续按整行留出(见 rules 的
 * collapseBlankRuns / addGapBefore),点击和方向键也把它们当作正文落点。
 * 行里一旦有字、或者这一行被删掉,记录自动清掉。
 *
 * 刻意不从「光标离开空行」反推:方向键在结构空行(段间距)上会短暂停留,
 * 那样会把纯排版用的空行也记成段落,走一圈下来满屏都是「段内换行」。
 */
export const emptyParagraphsField = StateField.define<readonly number[]>({
  create: () => [],
  update(prev, tr) {
    const kept = new Set<number>()
    const add = (pos: number): void => {
      if (isBlankLineStart(tr.state, pos)) kept.add(pos)
    }
    // 旧记录跟着文档平移;行里已经有字 / 行被删掉 → 不再是空段落
    for (const pos of prev) add(tr.changes.mapPos(pos, -1))
    if (tr.annotation(paragraphBreak) === true) {
      const before = tr.startState.selection
      if (before.ranges.length === 1 && before.main.empty) {
        const line = tr.startState.doc.lineAt(before.main.head)
        // 在空行上回车:回车前这条空段落也要留下
        if (!/\S/.test(line.text)) add(tr.changes.mapPos(line.from, -1))
      }
      const after = tr.state.selection
      if (after.ranges.length === 1 && after.main.empty) {
        const line = tr.state.doc.lineAt(after.main.head)
        // 光标落在空行上:这是刚起的新空段落
        if (!/\S/.test(line.text)) add(line.from)
        // 在块 / 段的行首回车:光标按普通编辑器的习惯留在原来那一行的行首,
        // 新段是它上面那条空行 —— 两条新换行插在光标前,光标没落上去也得记下来。
        // 不记的话它会被当成结构空行收紧成块间距,点击又被重定向到上一块,
        // 新段看着在那儿却点不进去(见 rules 的 collapseBlankRuns /
        // markHeadingSpaceBefore 与 build 的 gapLineClickAnchor)。
        else if (after.main.head === line.from && line.number > 1) {
          const above = tr.state.doc.line(line.number - 1)
          if (!/\S/.test(above.text)) add(above.from)
        }
      }
    } else if (
      tr.annotation(paragraphBreakAfter) === true ||
      tr.annotation(paragraphClick) === true
    ) {
      const after = tr.state.selection
      if (after.ranges.length === 1 && after.main.empty) {
        const line = tr.state.doc.lineAt(after.main.head)
        if (!/\S/.test(line.text)) add(line.from)
      }
    }
    // 删除把光标所在行清空时,它又成了空段落(例如敲了 `-` 再删掉、
    // 或把整行正文删光)。只认删除事务:方向键移动、回车命令(比如退出列表
    // 时默认命令先删掉标记)都不会走到这里,免得把结构空行记成用户空段落。
    if (tr.docChanged && tr.isUserEvent('delete')) {
      const after = tr.state.selection
      if (after.ranges.length === 1 && after.main.empty) {
        const line = tr.state.doc.lineAt(after.main.head)
        if (!/\S/.test(line.text)) add(line.from)
      }
    }
    return [...kept].sort((a, b) => a - b)
  }
})

/** 行首位置 pos 真的是一行的行首,且整行只有空白 */
function isBlankLineStart(state: EditorState, pos: number): boolean {
  if (pos < 0 || pos > state.doc.length) return false
  const line = state.doc.lineAt(pos)
  return line.from === pos && !/\S/.test(line.text)
}

export function getEmptyParagraphs(state: EditorState): readonly number[] {
  return state.field(emptyParagraphsField, false) ?? []
}
