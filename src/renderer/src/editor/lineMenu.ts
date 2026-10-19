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
import type { Extension } from '@codemirror/state'
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

function buildDecorations(view: EditorView): DecorationSet {
  // 没有插件贡献菜单条目时不画按钮 —— 免得点了弹出一个空菜单
  if (lineMenuEntries().length === 0) return Decoration.none
  const line = view.state.doc.lineAt(view.state.selection.main.head)
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
