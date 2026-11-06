import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Range,
  type Text
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { getPendingFence } from '../pendingFence'
import { touchesLines } from './selection'

/**
 * 相邻代码块组成「文件标签页」(见 rules.ts 的 styleFencedCodeGroup)。
 *
 * 触发条件只看源码结构:两个(或更多)**围栏代码块**连在一起 —— 上一块的闭合
 * 围栏和下一块的开围栏之间只有空白(可以挨着,也可以隔空行;回车补出来的空行
 * 很常见,见 adjacentFence)。文件名的写法是围栏 info string 里的 `title=`:
 *
 *   ```js title="main.js"
 *   ...
 *   ```
 *   ```js title="preload.js"
 *   ...
 *   ```
 *
 * `title=` 不是 Markdown 规范的一部分(CommonMark 只规定 info string 是自由
 * 文本),但很多编辑器/文档站都这么用;别的渲染器读不懂时会忽略多余 token,
 * 第一段语言名仍然有效,源码本身不会坏。
 *
 * 标签条只负责「选文件」,不含任何输入控件:选中块的开围栏行照常按源码显示
 *
 *   ```js title="main.js"
 *
 * 语言和文件名就在这一行上直接改(它本来就是文档里的一行文字),标签名每次
 * 都从 info string 现读 —— 改了 title=,标签跟着变。源码是唯一的真相。
 *
 * 没有 `title=` 的块不拿语言名当标签(否则 ` ```xml ` 会显示成「xml」),
 * 统一叫「未命名代码块1」「未命名代码块2」……。序号只数**没命名**的块:
 * 组里第一块叫 a.js、第二块没命名时,第二块是「未命名代码块1」,不是「…2」。
 */

/** 组里的一块:节点范围、首末行、点标签时光标落到哪、标签文字 */
export interface CodeMember {
  node: SyntaxNode
  /** 节点范围(开围栏行首 → 闭围栏行尾) */
  from: number
  to: number
  /** 点标签时把光标放在这里:开围栏下一行的行首 */
  jump: number
  /** 标签文字(title → 未命名代码块N) */
  title: string
  /** info string 的语言名(第一个 token),空串表示没写 */
  language: string
}

/** 当前选中的文件(按组头行首位置记,换文档位置时靠 StateField 平移) */
export interface CodeTabSelection {
  key: number
  index: number
}

/** 解析围栏 info string:语言取第一个 token,文件名取 title=… */
function parseCodeInfo(doc: Text, code: SyntaxNode): { language: string; title: string } {
  const info = code.getChild('CodeInfo')
  if (!info) return { language: '', title: '' }
  const raw = doc.sliceString(info.from, info.to).trim()
  if (!raw) return { language: '', title: '' }
  // 只写了 `title=…` 时第一个 token 不是语言(语言名里不会有 =)
  const first = raw.split(/\s+/)[0] ?? ''
  const language = first.includes('=') ? '' : first
  // title="main.js" / title='main.js' / title=main.js
  const match = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|([^\s]+))/i.exec(raw)
  const title = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
  return { language, title }
}

/** 这一段围栏是不是不该参与标签组(Mermaid 有自己的渲染态) */
function excluded(language: string): boolean {
  return language.toLowerCase() === 'mermaid'
}

/** 这一行是不是「刚敲出来、还没回车补全」的围栏(见 editor/pendingFence.ts) */
function isPending(doc: Text, code: SyntaxNode, pending: number | null): boolean {
  if (pending === null) return false
  const first = code.firstChild
  return (
    !!first && first.name === 'CodeMark' && doc.lineAt(first.from).from === pending
  )
}

/** 能进组的围栏:顶层、非 Mermaid、不是待定围栏 */
function groupable(doc: Text, code: SyntaxNode, pending: number | null): boolean {
  if (code.name !== 'FencedCode' || code.parent?.name !== 'Document') return false
  if (isPending(doc, code, pending)) return false
  return !excluded(parseCodeInfo(doc, code).language)
}

/**
 * 上一个/下一个可以合组的围栏兄弟节点。
 *
 * 两块之间只允许空白(换行、空行)。写完一块按回车再写下一块时,编辑器会在
 * 中间补一个段落空行;源码上虽然隔了一行,在用户眼里仍是「连在一起」的两块,
 * 不该因此拆散(否则正常输入根本凑不出标签组)。中间只要夹了正文(哪怕一个
 * 字符)就是两个独立的代码块,各自按普通代码块渲染。
 */
function adjacentFence(
  doc: Text,
  code: SyntaxNode,
  direction: -1 | 1,
  pending: number | null
): SyntaxNode | null {
  const other = direction === -1 ? code.prevSibling : code.nextSibling
  if (!other || other.name !== 'FencedCode') return null
  const gap =
    direction === -1
      ? doc.sliceString(other.to, code.from)
      : doc.sliceString(code.to, other.from)
  if (!/^\s*$/.test(gap)) return null
  return groupable(doc, other, pending) ? other : null
}

function memberOf(
  doc: Text,
  node: SyntaxNode,
  language: string,
  title: string
): CodeMember {
  const openLine = doc.lineAt(node.from).number
  const closeLine = doc.lineAt(node.to).number
  // 空块只有围栏两行:光标落到闭合围栏行(开着的那一行会露源码)
  const jump = doc.line(Math.min(openLine + 1, closeLine)).from
  return { node, from: node.from, to: node.to, jump, title, language }
}

/**
 * code 所在的标签组;不属于任何组(没有紧邻的围栏)时返回 null。
 *
 * 组头是一次向前/向后扩张的结果,所以同一个组里的每一块都会得到同一份
 * members —— rules.ts 里只让「视口内第一块」负责生成装饰,避免重复。
 */
export function codeGroupAt(
  doc: Text,
  code: SyntaxNode,
  pending: number | null
): CodeMember[] | null {
  if (!groupable(doc, code, pending)) return null
  let head = code
  let prev = adjacentFence(doc, head, -1, pending)
  while (prev) {
    head = prev
    prev = adjacentFence(doc, head, -1, pending)
  }
  if (head === code && !adjacentFence(doc, code, 1, pending)) return null
  const nodes: SyntaxNode[] = []
  for (let cur: SyntaxNode | null = head; cur; cur = adjacentFence(doc, cur, 1, pending)) {
    nodes.push(cur)
  }
  if (nodes.length < 2) return null
  // 编号只数没写 title= 的块:组里第一个未命名的叫「未命名代码块1」,
  // 不管它排在整组的第几位(前面已命名的块不占号)。
  const members: CodeMember[] = []
  let unnamed = 0
  for (const node of nodes) {
    const { language, title } = parseCodeInfo(doc, node)
    if (!title) unnamed += 1
    members.push(memberOf(doc, node, language, title || `未命名代码块${unnamed}`))
  }
  return members
}

// ---------- 当前选中的文件 ----------

/** 光标所在的顶层围栏代码块(不在任何块里时为 null) */
function fencedAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTree(state)
  // 位置正好落在节点边界时,向前/向后两种解析各试一次
  for (const bias of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, bias); node; node = node.parent) {
      if (node.name === 'FencedCode' && node.parent?.name === 'Document') return node
    }
  }
  return null
}

/** 光标所在的那一块(组头行首 + 组内下标);不在标签组里时为 null */
function cursorGroup(state: EditorState): CodeTabSelection | null {
  const head = state.selection.main.head
  const code = fencedAt(state, head)
  if (!code) return null
  const members = codeGroupAt(state.doc, code, getPendingFence(state))
  if (!members) return null
  const index = members.findIndex(m => head >= m.from && head <= m.to)
  if (index < 0) return null
  return { key: state.doc.lineAt(members[0].from).from, index }
}

/**
 * 记住每组里选中的文件。位置用组头行首记,文档改动时随变更平移;
 * 行被删掉 / 组散开时这条记录匹配不上任何组,自然失效(不做清理)。
 *
 * 两个来源,后者覆盖前者:
 *   · 点标签派发的 setCodeTabsActive(显式选择);
 *   · 光标落在某一块里 —— 用鼠标点正文、键盘上下移动进来也算。光标离开组后
 *     仍显示这一块,不会跳回第一块(「在哪个就在哪个」)。
 */
export const setCodeTabsActive = StateEffect.define<CodeTabSelection>()

export const codeTabsField = StateField.define<readonly CodeTabSelection[]>({
  create: () => [],
  update(entries, tr) {
    const doc = tr.state.doc
    // 按行首归一:光标在同一行里左右移动、行首插入字符都不会让 key 失配
    const saved = new Map<number, number>()
    const put = (rawKey: number, index: number): void => {
      if (rawKey < 0 || rawKey > doc.length) return
      saved.set(doc.lineAt(rawKey).from, index)
    }
    for (const entry of entries) put(tr.changes.mapPos(entry.key, 1), entry.index)
    for (const effect of tr.effects) {
      if (effect.is(setCodeTabsActive)) put(effect.value.key, effect.value.index)
    }
    if (tr.selection || tr.docChanged) {
      const at = cursorGroup(tr.state)
      if (at) put(at.key, at.index)
    }
    return [...saved].map(([key, index]) => ({ key, index }))
  }
})

/** 组头行首对应的选中下标;没点过标签时为 null */
export function lookupCodeTab(
  entries: readonly CodeTabSelection[] | undefined,
  key: number
): number | null {
  if (!entries) return null
  for (const entry of entries) if (entry.key === key) return entry.index
  return null
}

/**
 * 组里该高亮 / 显示哪一块。
 *
 * 有选区时看光标落在哪一块(拖选、Ctrl+A 时每块都被「碰到」,hence 另给一份
 * touched);光标不在组里时用记住的选择(默认第一块)。标签条和渲染必须按同一
 * 份结果走,否则会出现「高亮 a.js、正文却是 b.js」。
 */
export function resolveGroupActive(
  doc: Text,
  sel: EditorSelection,
  stored: readonly CodeTabSelection[] | undefined,
  key: number,
  members: CodeMember[]
): { active: number; touched: boolean[] } {
  const touched = members.map(m => touchesLines(sel, doc, m.from, m.to))
  const anyTouched = touched.some(Boolean)
  const headLine = doc.lineAt(sel.main.head).number
  const cursorIndex = members.findIndex(
    m => headLine >= doc.lineAt(m.from).number && headLine <= doc.lineAt(m.to).number
  )
  const saved = lookupCodeTab(stored, key)
  const fallback = saved === null ? 0 : Math.min(Math.max(saved, 0), members.length - 1)
  // 光标不在任何一块里(选区从组外拉进来)就取第一块被碰到的
  const touchedFirst = touched.indexOf(true)
  const active = anyTouched
    ? cursorIndex >= 0
      ? cursorIndex
      : Math.max(touchedFirst, 0)
    : fallback
  return { active, touched }
}

// ---------- 自动补 title ----------

/**
 * 光标所在标签组的源码范围 [组头行首, 组尾]。
 *
 * 自动补 title 用它判断「这次改动是不是就发生在这个组里」:光标停在组里
 * (比如刚打开文件、光标落在围栏行上)并不代表用户在编辑这一组 —— 点文末
 * 新起段落之类的改动也发生在组外,不该顺带改源码。
 */
export function caretGroupRange(state: EditorState): { from: number; to: number } | null {
  const code = fencedAt(state, state.selection.main.head)
  if (!code) return null
  const mem = codeGroupAt(state.doc, code, getPendingFence(state))
  if (!mem) return null
  return { from: mem[0].from, to: mem[mem.length - 1].to }
}

/**
 * 未命名块自动补上 `title="未命名代码块N"`。
 *
 * 标签上的自动名不是纯显示:名字要真的写进源码 —— 这样它和用户手写的
 * `title=` 地位相同,别的编辑器 / 导出都看得到,用户也能直接在围栏行上改。
 *
 * 只补**光标所在组**里没写 title 的块,并且跳过光标正停着的那条围栏行:
 * 用户可能正在那一行手敲 `title=…`,写进去会把输入顶掉。光标离开后再补。
 *
 * 返回一组插入改动(不改 info string 的其余 token);没有可补的返回空数组。
 */
export function autoTitleChanges(
  state: EditorState
): { from: number; to: number; insert: string }[] {
  if (state.readOnly) return []
  const sel = state.selection
  const code = fencedAt(state, sel.main.head)
  if (!code) return []
  const mem = codeGroupAt(state.doc, code, getPendingFence(state))
  if (!mem) return []
  const doc = state.doc
  const changes: { from: number; to: number; insert: string }[] = []
  for (const member of mem) {
    if (parseCodeInfo(doc, member.node).title) continue
    const fence = doc.lineAt(member.from)
    if (sel.ranges.some(r => r.from <= fence.to && r.to >= fence.from)) continue
    const info = member.node.getChild('CodeInfo')
    const mark = member.node.firstChild
    // 没有 info string 时补在围栏后面(往里写语言也安全)
    const at = info ? info.to : mark ? mark.to : member.from
    changes.push({ from: at, to: at, insert: ` title="${member.title}"` })
  }
  return changes
}

// ---------- 标签条 ----------

export interface CodeTabsSpec {
  /** 组头行首(点击标签时用于定位这一组) */
  key: number
  titles: string[]
  active: number
  /** 每个标签点击后光标落点 */
  jumps: number[]
}

/** 每个组头一条:该组选中哪块 / 标签叫什么,直接由当前 state 现算 */
function stripSpecs(state: EditorState): CodeTabsSpec[] {
  const doc = state.doc
  const pending = getPendingFence(state)
  const stored = state.field(codeTabsField, false)
  const specs: CodeTabsSpec[] = []
  const tree = syntaxTree(state)
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'FencedCode') continue
    const members = codeGroupAt(doc, node, pending)
    if (!members) continue
    // 组头是把 code 向前扩张到底的结果;对组里其它块不重复生成
    if (members[0].from === node.from) {
      const key = doc.lineAt(members[0].from).from
      const { active } = resolveGroupActive(doc, state.selection, stored, key, members)
      specs.push({
        key,
        titles: members.map(m => m.title),
        active,
        jumps: members.map(m => m.jump)
      })
    }
    node = members[members.length - 1].node
  }
  return specs
}

/**
 * 标签条装饰。
 *
 * 块级 widget 不能由 ViewPlugin 提供(CM6 会直接抛
 * 「Block decorations may not be specified via plugins」),所以标签条单独放在
 * 这个 StateField 里;组内其余装饰(折叠、行底色)仍在 rules.ts 的 ViewPlugin。
 */
export const codeTabsStripField = StateField.define<DecorationSet>({
  create: state => stripDecorations(state),
  update: (_deco, tr) => stripDecorations(tr.state),
  provide: field => EditorView.decorations.from(field)
})

function stripDecorations(state: EditorState): DecorationSet {
  // 全文档算一遍:装饰集不受视口裁剪,远处的组到渲染时才建 DOM
  const decos: Range<Decoration>[] = stripSpecs(state).map(spec => ({
    from: spec.key,
    to: spec.key,
    value: Decoration.widget({
      widget: new CodeTabsWidget(spec),
      side: -1,
      block: true
    })
  }))
  return Decoration.set(decos, true)
}

function sameSpec(a: CodeTabsSpec, b: CodeTabsSpec): boolean {
  return (
    a.key === b.key &&
    a.active === b.active &&
    a.titles.length === b.titles.length &&
    a.titles.every((title, i) => title === b.titles[i]) &&
    a.jumps.every((jump, i) => jump === b.jumps[i])
  )
}

/**
 * 组头上方的文件标签条。它是块级 widget,挂在组头开围栏行的**上方**,不替换
 * 任何源码 —— 开围栏行照常显示 ` ```js title="main.js" `,语言和文件名就在
 * 那一行上改(见 rules.ts 的 styleGroupMember)。
 *
 * 点击标签 = 选中文件:派发一个状态效果(记住选择)并把光标放进那一块的
 * 第一行 —— 光标落在哪块,渲染就显示哪块(见 rules.ts 的 styleFencedCodeGroup),
 * 键盘上下移动也能自然地在文件之间切换。
 */
export class CodeTabsWidget extends WidgetType {
  constructor(readonly spec: CodeTabsSpec) {
    super()
  }

  eq(other: CodeTabsWidget): boolean {
    return sameSpec(this.spec, other.spec)
  }

  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-md-code-tabs'
    const row = document.createElement('div')
    row.className = 'cm-md-code-tabs-row'
    row.setAttribute('role', 'tablist')
    this.spec.titles.forEach((title, index) => {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'cm-md-code-tab' + (index === this.spec.active ? ' is-active' : '')
      tab.textContent = title
      tab.title = title
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(index === this.spec.active))
      // 按住别让编辑器丢焦点(丢焦点选区会跳,代码块还会翻回源码态)
      tab.addEventListener('mousedown', e => e.preventDefault())
      tab.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch({
          effects: setCodeTabsActive.of({ key: this.spec.key, index }),
          selection: EditorSelection.cursor(this.spec.jumps[index]),
          scrollIntoView: true
        })
        view.focus()
      })
      row.appendChild(tab)
    })
    bar.appendChild(row)
    return bar
  }

  ignoreEvent(): boolean {
    return true
  }
}
