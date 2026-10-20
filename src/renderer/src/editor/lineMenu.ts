/**
 * 光标行行首的「+」按钮。
 *
 * 为什么是独立的 ViewPlugin,而不是塞进 wysiwyg/ 那套按语法树分发的规则里:
 * 那个插件每次文档变更都要全量重建装饰,还带一段 IME 组合期的重映射分支;
 * 而这里只关心「光标在第几行」,两件事的生命周期完全不同,挂在一起只会互相拖累。
 *
 * 只**画**按钮,不决定菜单里有什么 —— 条目来自插件贡献点(services/lineMenu.ts)。
 */

import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import {
  closeLineMenu,
  lineMenuEntries,
  lineMenuRefreshEffect,
  lineMenuStore,
  openLineMenu
} from '../services/lineMenu'

/**
 * 行首那个圆按钮。
 *
 * 照 wysiwyg/widgets.ts 里 CheckboxWidget 的模板写:带位置的 eq()(忽略了行号,
 * 文档一变装饰重建、旧 DOM 被复用,按钮就会拿着**上一行**的行号去开菜单)、
 * ignoreEvent() 为真、事件自己处理。
 */
class LinePlusWidget extends WidgetType {
  constructor(readonly line: number) {
    super()
  }

  eq(other: LinePlusWidget): boolean {
    return other.line === this.line
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'line-plus'
    btn.textContent = '+'
    btn.title = '插入内容'
    btn.setAttribute('aria-label', '插入内容')
    // 按住时别让编辑器丢焦点:丢了选区会跳、菜单也会跟着关掉
    btn.addEventListener('mousedown', e => e.preventDefault())
    btn.addEventListener('click', e => {
      e.preventDefault()
      const rect = btn.getBoundingClientRect()
      openLineMenu(this.line, rect)
    })
    return btn
  }

  ignoreEvent(): boolean {
    return true
  }

  /**
   * 声明为「不参与坐标计算」的 widget。
   *
   * 按钮是绝对定位的装饰,视觉上藏在行首左侧的 padding 里、不占任何版式空间;
   * 但 CodeMirror 仍把它当成行内节点,给光标算坐标时会从它身上取矩形。
   * 最后一行是空行时,光标位置(文档末尾)正好等于按钮所在的 pos,点击末行
   * 下方的空白会让 CM 以 `assoc: -1` 落点——按「位置之前的那块」找矩形,于是
   * 找到按钮:光标变成 20×20、并左移到按钮所在的 padding 里(见 verify/cursor-harness.ts)。
   *
   * isHidden 是 CM 内部用来标记「不占据行内位置、不该被测量」的节点(BreakWidget
   * 的 `<br>` 也是这么写的)。声明之后 coordsAtPos 会跳过它,改用同一位置的行内
   * 内容/换行节点,光标在两种落点下保持一致。
   */
  get isHidden(): boolean {
    return true
  }
}

/**
 * 某个位置是否落在引用里。
 *
 * 引用行用 margin-left: 1em 缩进、竖线画在正文栏左缘(见 editor.css),而「+」是相对
 * .cm-line 绝对定位的 —— 在引用行上它会跟着右移 1em,正好挤在竖线与 `>` 之间。
 * 所以引用行整行不画按钮。
 *
 * 传**行首位置**而不是光标:光标贴在行尾时,位置正好落在 Blockquote 节点的右边界上,
 * resolveInner 的 side 有可能把它解析到节点外面去。
 */
function inBlockquote(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'Blockquote') return true
    node = node.parent
  }
  return false
}

/**
 * 这一行是否落在代码块里(围栏块或缩进块)。
 *
 * 代码块内不画「+」:菜单里全是 Markdown 块(表格 / 公式 / 引用…),插进代码里
 * 只会变成一段源码;而且代码块左侧那 1.25em 留白正好是按钮的落点,按钮会压在代码上。
 *
 * 不能只拿行首 resolveInner:缩进代码块的节点从第 5 列才开始,行首落在节点外。
 * 用整行的范围去遍历,块内的每一行(包括空行)都会被 FencedCode / CodeBlock 覆盖到。
 */
function inCodeBlock(state: EditorState, from: number, to: number): boolean {
  let found = false
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        found = true
        return false
      }
      return undefined
    }
  })
  return found
}

function buildDecorations(view: EditorView): DecorationSet {
  // 没有插件贡献菜单条目时不画按钮 —— 免得点了弹出一个空菜单
  if (lineMenuEntries().length === 0) return Decoration.none
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  // 引用行不画:见 inBlockquote
  if (inBlockquote(view.state, line.from)) return Decoration.none
  // 代码块内的行不画:见 inCodeBlock
  if (inCodeBlock(view.state, line.from, line.to)) return Decoration.none
  // side: -1 让它落在行首第一个字符之前;实际位置由 CSS 绝对定位到行内的空白里
  return Decoration.set([
    Decoration.widget({ widget: new LinePlusWidget(line.number), side: -1 }).range(line.from)
  ])
}

const lineMenuPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      // 光标一动就收起菜单:它属于「那一行」,行变了就不该还开着
      if (update.selectionSet && lineMenuStore.open) closeLineMenu()
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.transactions.some(tr => tr.effects.some(e => e.is(lineMenuRefreshEffect)))
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: v => v.decorations }
)

export function lineMenu(): Extension {
  return lineMenuPlugin
}
