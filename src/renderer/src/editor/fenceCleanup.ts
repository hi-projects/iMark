import { syntaxTree } from '@codemirror/language'
import type { Transaction, TransactionSpec } from '@codemirror/state'
import { isFenceLineText } from './pendingFence'

/**
 * 删掉空代码块的开围栏时,把整个块一起删掉 —— 只按一次退格,不留残余。
 *
 * 回车补全出来的代码块长这样(见 commands.ts 的 completeFenceOnEnter):
 *
 * ```
 * (空行)
 * ```
 *
 * 用户删开围栏那几个反引号时,只删掉一个字符的话:开围栏行变成 ` `` ` 这样的
 * 残余,收围栏在语法树里变成一条**未闭合围栏**,渲染层从它开始画代码卡片,
 * 后面的正文全被吞进去。要用户自己再按两次才删干净,既别扭又容易停在半路。
 *
 * 所以开围栏一旦被删得不再是围栏,就在同一个删除事务里把「开围栏这一行到收围栏
 * 行尾」整段删掉(块里只有空白,一起收走),收围栏后面那条换行留着 —— 块的
 * 位置剩一条空段落,撤销一步全回来。
 *
 * 只认**顶层、已闭合、块里只有空白**的围栏块:
 *   - 块里有内容时,删开围栏是用户要把内容变回正文,不能替他删内容行;
 *   - 引用 / 列表里的围栏前缀被删掉后语义更复杂,交给用户手动处理;
 *   - 删完开围栏仍然是合法围栏(比如四个反引号删成三个)时整块不动。
 */
export function emptyFenceDeleteFilter(
  tr: Transaction
): TransactionSpec | readonly TransactionSpec[] {
  // 放行:把原事务原样返回 —— 运行时按 `instanceof Transaction` 处理,类型声明里没有它
  const pass = tr as unknown as TransactionSpec
  if (!tr.docChanged || !tr.isUserEvent('delete')) return pass
  if (!touchesFenceLine(tr)) return pass
  const remove = closingFenceToRemove(tr)
  if (!remove) return pass
  // 追加在这个删除事务之后(新文档坐标)并合成同一个事务:撤销一步就能回来
  return [tr, { changes: remove, sequential: true }]
}

/**
 * 这次删除有没有动到一条「整行看起来就是围栏」的行(或它的上一条换行)。
 *
 * 只是给下面的语法树扫描做个便宜的预筛:删普通正文时连树都不用看。
 * 在开围栏行首退格(删掉上一行末尾的换行)时,`lineAt(fromA)` 拿到的是**上一行**,
 * 所以要连下一行一起看。
 */
function touchesFenceLine(tr: Transaction): boolean {
  const doc = tr.startState.doc
  let hit = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (hit || toA <= fromA) return
    for (const pos of [fromA, Math.min(toA, doc.length)]) {
      const line = doc.lineAt(pos)
      if (isFenceLineText(line.text)) hit = true
      if (line.number < doc.lines && isFenceLineText(doc.line(line.number + 1).text)) hit = true
    }
  })
  return hit
}

/**
 * 删掉空公式块(`$$...$$` / `\[...\]`)的定界符时,把整块一起删掉。
 *
 * 回车补全出来的空公式块长这样:
 *
 * $$
 *
 * $$
 *
 * 用户删定界符时,只删一个字符的话:开标记行剩下 `$` 残余,另一行 `$$` 变成
 * 一条**未闭合**开标记(块解析器会从它开始把后面的正文全吞进公式),要删好
 * 几次才能删干净。所以定界符一旦被删得不再成立,就在同一个删除事务里把
 * 「开标记行首到收标记行尾」整段删掉 —— 按一次就够,撤销一步全回来。
 *
 * 只认**顶层、已闭合、块里只有空白**的公式块:
 *   - 块里有公式内容时,删定界符是用户要把内容变回正文,不能替他删内容行;
 *   - 引用 / 列表里的公式前缀被删掉后语义更复杂,交给用户手动处理;
 *   - 删完定界符仍然成立时整块不动。
 * 开标记和收标记都算:删 `$$` 的任意一个字符都会触发。
 */
export function emptyMathBlockDeleteFilter(
  tr: Transaction
): TransactionSpec | readonly TransactionSpec[] {
  const pass = tr as unknown as TransactionSpec
  if (!tr.docChanged || !tr.isUserEvent('delete')) return pass
  if (!touchesMathDelimiterLine(tr)) return pass
  const remove = emptyMathBlockToRemove(tr)
  if (!remove) return pass
  return [tr, { changes: remove, sequential: true }]
}

/** `$$` 或 `\[` / `\]`:给下面的语法树扫描做便宜的预筛 */
const MATH_DELIM = /\$\$|\\\[|\\\]/

/** 这次删除有没有动到一条带公式定界符的行(或它相邻的行) */
function touchesMathDelimiterLine(tr: Transaction): boolean {
  const doc = tr.startState.doc
  let hit = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (hit || toA <= fromA) return
    for (const pos of [fromA, Math.min(toA, doc.length)]) {
      const line = doc.lineAt(pos)
      if (MATH_DELIM.test(line.text)) hit = true
      if (line.number > 1 && MATH_DELIM.test(doc.line(line.number - 1).text)) hit = true
      if (line.number < doc.lines && MATH_DELIM.test(doc.line(line.number + 1).text)) hit = true
    }
  })
  return hit
}

/** 要一起删掉的整块范围(新文档坐标);不需要清理时返回 null */
function emptyMathBlockToRemove(tr: Transaction): { from: number; to: number } | null {
  const start = tr.startState
  const newDoc = tr.newDoc
  let remove: { from: number; to: number } | null = null

  syntaxTree(start).iterate({
    enter(ref) {
      if (ref.name !== 'MathBlock' || ref.node.parent?.name !== 'Document') return undefined
      const node = ref.node
      const first = node.firstChild
      const last = node.lastChild
      if (!first || !last || first.name !== 'MathMark' || last.name !== 'MathMark') return false
      // 未闭合的公式块只有开标记,没有「配对」可删
      if (first.from === last.from) return false
      // 块里只允许空白:有公式内容时删定界符是用户要把内容变回正文
      if (/\S/.test(start.doc.sliceString(first.to, last.from))) return false

      const opener = start.doc.lineAt(first.from)
      const closer = start.doc.lineAt(last.from)
      const openMarker = start.doc.sliceString(first.from, first.to)
      const closeMarker = start.doc.sliceString(last.from, last.to)
      let touchedOpener = false
      let touchedCloser = false
      let spans = false
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (toA <= fromA) return
        if (fromA <= opener.to && toA >= opener.from) touchedOpener = true
        if (fromA <= closer.to && toA >= closer.from) touchedCloser = true
        // 一次删除跨过两个定界符(整块选中删除):用户自己删干净了,不补刀
        if (fromA < first.to && toA > last.from) spans = true
      })
      if (spans || (!touchedOpener && !touchedCloser)) return false
      // 两个定界符都被同一次删除碰到时,块已经不完整,不猜用户要保留哪边
      if (touchedOpener && touchedCloser) return false

      const mappedOpener = tr.changes.mapPos(opener.from, -1)
      const mappedCloser = tr.changes.mapPos(closer.from, 1)
      const openerLine = newDoc.lineAt(mappedOpener)
      const closerLine = newDoc.lineAt(mappedCloser)

      // 删完这一侧仍然是合法定界符(比如 `$$x` 删掉 x 前的内容):块还成立,不动
      if (touchedOpener && isMathOpenerLine(openerLine.text, openMarker)) return false
      if (touchedCloser && isMathCloserLine(closerLine.text, closeMarker)) return false

      // 开标记行首被这次删除带走了(并进上一行)时,从残迹处删起,别带走上一行的字
      const from = openerLine.from === mappedOpener ? openerLine.from : mappedOpener
      remove = { from, to: closerLine.to }
      return false
    }
  })
  return remove
}

/** 行首仍然是公式开标记(`$$$` 不算,与解析器一致) */
function isMathOpenerLine(text: string, marker: string): boolean {
  if (!text.startsWith(marker)) return false
  return !(marker === '$$' && text.charCodeAt(2) === 36 /* $ */)
}

/** 行尾仍然是公式收标记(收标记后面只允许空白,与解析器一致) */
function isMathCloserLine(text: string, marker: string): boolean {
  return text.trimEnd().endsWith(marker)
}

/** 要一起删掉的整块范围(新文档坐标);不需要清理时返回 null */
function closingFenceToRemove(tr: Transaction): { from: number; to: number } | null {
  const start = tr.startState
  const newDoc = tr.newDoc
  let remove: { from: number; to: number } | null = null

  syntaxTree(start).iterate({
    enter(ref) {
      if (ref.name !== 'FencedCode' || ref.node.parent?.name !== 'Document') return undefined
      const node = ref.node
      const first = node.firstChild
      const last = node.lastChild
      if (!first || !last || first.name !== 'CodeMark' || last.name !== 'CodeMark') return false
      // 未闭合的围栏只有开标记,没有「配对」可删
      if (first.from === last.from) return false
      // 块里只允许空白:有正文时删开围栏是用户要把内容变回正文,别动内容行
      if (/\S/.test(start.doc.sliceString(first.to, last.from))) return false

      const opener = start.doc.lineAt(first.from)
      let touched = false
      let touchedCloser = false
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (toA <= fromA) return
        if (fromA <= opener.to && toA >= opener.from) touched = true
        // 选区跨到了收围栏甚至更远:这不是「删开围栏」,不要跟着乱删
        if (fromA < last.to && toA > last.from) touchedCloser = true
      })
      if (!touched || touchedCloser) return false

      // 删完这一行仍然是合法围栏(比如四个反引号删成三个):块还成立,不动
      const mappedOpener = tr.changes.mapPos(opener.from, -1)
      if (isFenceLineText(newDoc.lineAt(mappedOpener).text)) return false

      const closerFrom = tr.changes.mapPos(last.from, 1)
      const closer = newDoc.lineAt(closerFrom)
      // 收围栏必须仍在自己那一行的行首(顶层围栏不会带容器前缀),
      // 且这一行除了收标记没有别的内容 —— 前面已经确认块里只有空白。
      if (closer.from !== closerFrom) return false
      if (!isFenceLineText(closer.text)) return false

      // 从开围栏这一行的行首删到收围栏行尾。开围栏行首被这次删除带走了
      // (比如在行首退格、把它接进上一行)时,行首已经属于上一行的正文,
      // 只能从围栏残迹处删起,别把上一行的字一起带走。
      const openerLine = newDoc.lineAt(mappedOpener)
      const from = openerLine.from === mappedOpener ? openerLine.from : mappedOpener
      remove = { from, to: closer.to }
      return false
    }
  })
  return remove
}
