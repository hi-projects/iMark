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
