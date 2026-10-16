import { WidgetType, type EditorView } from '@codemirror/view'
import katex from 'katex'
import { renderInline } from './inline'

/** 单元格对齐方式,取自 GFM 分隔行里的冒号;null = 文档没声明,交给 CSS */
export type TableAlign = 'left' | 'center' | 'right' | null

/** LaTeX 公式:用 KaTeX 渲染成静态 HTML。throwOnError:false 时错误公式由 KaTeX 自己标红显示 */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.displayMode === this.displayMode
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.displayMode
      ? 'cm-md-math cm-md-math-display cm-md-widget'
      : 'cm-md-math cm-md-math-inline cm-md-widget'
    try {
      katex.render(this.tex, el, {
        displayMode: this.displayMode,
        throwOnError: false,
        output: 'html',
        trust: false
      })
    } catch {
      el.textContent = this.displayMode ? `$$${this.tex}$$` : `$${this.tex}$`
      el.classList.add('cm-md-math-error')
    }
    return el
  }

  // 点击交给 CodeMirror 映射到文档位置 → 光标进入公式区间 → 自动翻回源码
  ignoreEvent(): boolean {
    return false
  }
}

/** 任务复选框:点击直接改写文档中的 [ ]/[x],undo 栈自然记录 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly len: number
  ) {
    super()
  }

  // pos 必须参与比较:若忽略 pos,文档变化后装饰虽重建但旧 DOM(携带旧 pos)被复用,点击会写错位置
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos && other.len === this.len
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-md-checkbox cm-md-widget'
    box.setAttribute('aria-label', '任务')
    box.addEventListener('mousedown', e => e.preventDefault())
    box.addEventListener('click', e => {
      e.preventDefault()
      view.dispatch({
        changes: { from: this.pos, to: this.pos + this.len, insert: this.checked ? '[ ]' : '[x]' }
      })
    })
    return box
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** 图片:光标在节点内时显示原始语法,节点外渲染真图。点击交给 CM(映射到节点边缘 → 触发显形) */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image cm-md-widget'
    const img = document.createElement('img')
    img.src = this.src
    if (this.alt) {
      img.alt = this.alt
      img.title = this.alt
    }
    img.addEventListener('load', () => wrap.classList.add('cm-md-image-loaded'))
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image-error')
      const label = document.createElement('span')
      label.textContent = this.alt || this.src
      wrap.appendChild(label)
    })
    wrap.appendChild(img)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

/**
 * GFM 表格:光标不在表内时整块渲染成真表格。
 *
 * 这个 widget 只替换**表头那一行**,其余行由 cm-md-table-void 折叠成零高度
 * (与块级公式同一套做法 —— CM 不允许插件提供跨行 replace)。
 */
export class TableWidget extends WidgetType {
  constructor(
    /** 整张表的源码。只用来做 eq 签名,不参与渲染 */
    readonly source: string,
    readonly head: string[],
    readonly body: string[][],
    readonly align: TableAlign[]
  ) {
    super()
  }

  /**
   * 只比源码。head / body / align 都是它的**纯函数**(在 rules.ts 里由同一棵语法树推出),
   * 源码没变时它们不可能变。
   *
   * 这一条是硬约束而不是优化:表格内容改了却让 eq 返回 true,CM 会复用旧 DOM,
   * 屏幕上就一直是那张旧表 —— 而且会因为看起来"只是没刷新"而格外难查。
   */
  eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-table-widget cm-md-widget'
    const table = document.createElement('table')

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    this.head.forEach((text, i) => headRow.appendChild(this.cell('th', i, text)))
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of this.body) {
      const tr = document.createElement('tr')
      row.forEach((text, i) => tr.appendChild(this.cell('td', i, text)))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    wrap.appendChild(table)
    return wrap
  }

  private cell(tag: 'th' | 'td', column: number, text: string): HTMLElement {
    const el = document.createElement(tag)
    el.innerHTML = renderInline(text)
    const align = this.align[column]
    if (align) el.style.textAlign = align
    return el
  }

  // 点击交给 CodeMirror 按坐标映射成文档位置 → 光标落在表内 → 自动翻回源码态。
  // 这样"点进去编辑"是白拿的,不用自己写事件回调(也不知道该往哪一列映射)。
  ignoreEvent(): boolean {
    return false
  }
}

/** 水平线 widget;点击由 CM 映射到行边缘,翻回原始语法可编辑 */
export class HrWidget extends WidgetType {
  eq(other: HrWidget): boolean {
    return other instanceof HrWidget
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-hr cm-md-widget'
    return span
  }

  ignoreEvent(): boolean {
    return false
  }
}
