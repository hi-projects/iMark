import type { EditorSelection, Text } from '@codemirror/state'

/**
 * 闭区间相交判定:双端都取 <= / >=。
 * 光标恰好贴在 from 或 to 上也算相交 → 显示原始标记,
 * 否则光标贴边时无法进入/退出隐藏态,产生"光标在但标记消失"的抖动。
 */
export function touches(sel: EditorSelection, from: number, to: number): boolean {
  return sel.ranges.some(r => r.from <= to && r.to >= from)
}

/** 行粒度判定:选区覆盖的行区间与 [fromLine, toLine] 相交即算 */
export function touchesLines(sel: EditorSelection, doc: Text, from: number, to: number): boolean {
  const l1 = doc.lineAt(from).number
  const l2 = doc.lineAt(to).number
  return sel.ranges.some(r => {
    const a = doc.lineAt(r.from).number
    const b = doc.lineAt(r.to).number
    return b >= l1 && a <= l2
  })
}
