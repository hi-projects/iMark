/**
 * 编辑公式时的浮动预览。
 *
 * 光标进入 $...$ / $$...$$ 后,wysiwyg 会把公式翻回源码态(不翻就没法改)。
 * 这里在源码的右侧(放不下时退到下方/上方)浮一块 KaTeX 实时预览:改一个字,
 * 预览跟着变,不用把光标移出公式才能看到结果。
 *
 * 与 wysiwyg/widgets.ts 的 MathWidget 保持同一套 KaTeX 选项(html 输出、信任关闭、
 * 语法错误由 KaTeX 自己标红),这样预览与渲染态长得一致。
 */

import { syntaxTree } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import katex from 'katex'
import { mathSource } from './math'

/** 源码与预览之间、预览与编辑区边缘之间的距离(px) */
const GAP = 10
const EDGE = 8

interface MathHit {
  /** 公式节点(含前后 $ 标记)在文档里的范围 */
  from: number
  to: number
  /** 不带 $ 标记的 TeX 源码 */
  tex: string
  display: boolean
}

/** 三种公式节点:行内 $...$、段落内的 $$...$$、块解析器产出的行首 $$...$$ */
function isMathNode(name: string): boolean {
  return name === 'InlineMath' || name === 'DisplayMath' || name === 'MathBlock'
}

/** 光标所在的公式节点 */
function mathAtCursor(view: EditorView): MathHit | null {
  const state = view.state
  const head = state.selection.main.head
  const tree = syntaxTree(state)
  /*
   * 光标恰好贴在节点边界时,bias 决定 resolveInner 落到节点里还是外。
   * wysiwyg 那边把「贴着 $」也算在公式内(touches 是闭区间),这里两个方向都试,
   * 免得在公式首尾出现「源码态却没有预览」的空档。
   */
  for (const bias of [-1, 1] as const) {
    let node = tree.resolveInner(head, bias)
    while (node.parent && !isMathNode(node.name)) {
      node = node.parent
    }
    if (!isMathNode(node.name)) continue
    if (head < node.from || head > node.to) continue
    const tex = mathSource(state.doc, node)
    if (!tex.trim()) continue
    return { from: node.from, to: node.to, tex, display: node.name !== 'InlineMath' }
  }
  return null
}

/** 一个盒子的屏幕坐标 */
interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** 公式源码在屏幕上的包围盒;逐行取端点,多行公式才不会按最后一行(通常最短)算偏 */
function sourceBox(view: EditorView, hit: MathHit): Box | null {
  const doc = view.state.doc
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  const take = (a: Box | null, b: Box | null): void => {
    if (!a) return
    left = Math.min(left, a.left)
    right = Math.max(right, b ? b.right : a.right)
    top = Math.min(top, a.top)
    bottom = Math.max(bottom, b ? b.bottom : a.bottom)
  }
  if (hit.display) {
    // 块级公式可能跨多行:每一行都量一遍,最宽的那行决定右边界
    const first = doc.lineAt(hit.from).number
    const last = doc.lineAt(hit.to).number
    for (let n = first; n <= last; n++) {
      const line = doc.line(n)
      const a = view.coordsAtPos(line.from)
      const b = view.coordsAtPos(line.to)
      take(a, b)
    }
  } else {
    take(view.coordsAtPos(hit.from), view.coordsAtPos(hit.to))
  }
  if (!isFinite(left)) return null
  return { left, right, top, bottom }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

const mathPreviewPlugin = ViewPlugin.fromClass(
  class {
    private readonly el: HTMLElement
    /** 当前预览的公式(文档一变位置就可能变,滚动时靠它重算坐标) */
    private hit: MathHit | null = null
    /** 上一次真正渲染的源码;光移光标不重渲染 KaTeX */
    private rendered: { tex: string; display: boolean } | null = null
    private scrollRaf = 0
    private refreshTimer: ReturnType<typeof setTimeout> | undefined

    constructor(readonly view: EditorView) {
      this.el = document.createElement('div')
      this.el.className = 'cm-md-math-preview'
      this.el.setAttribute('aria-hidden', 'true')
      view.dom.appendChild(this.el)
      this.scheduleRefresh()
      // 滚动不产生事务(视口没跨出可见区时),预览得自己跟着源码走
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      window.addEventListener('resize', this.onScroll)
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.viewportChanged
      ) {
        this.scheduleRefresh()
      }
    }

    destroy(): void {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      window.removeEventListener('resize', this.onScroll)
      if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf)
      clearTimeout(this.refreshTimer)
      this.el.remove()
    }

    /**
     * update() 跑在 CodeMirror 的事务里,此刻 coordsAtPos() 会报
     * "Reading the editor layout isn't allowed during an update" 并把插件打崩。
     * 推到本轮更新结束后的任务里再做(顺带合并同一轮里的多次变化)。
     */
    private scheduleRefresh(): void {
      if (this.refreshTimer !== undefined) return
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = undefined
        this.refresh()
      }, 0)
    }

    private readonly onScroll = (): void => {
      if (this.scrollRaf) return
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0
        this.reposition()
      })
    }

    /** 文档/选区变了:重新找公式、必要时重渲染 */
    private refresh(): void {
      // 焦点离开编辑器(点设置、切窗口)时不该留一个悬空预览
      const hit = this.view.hasFocus ? mathAtCursor(this.view) : null
      this.hit = hit
      this.el.style.visibility = 'hidden'
      if (!hit) return
      if (this.rendered?.tex !== hit.tex || this.rendered.display !== hit.display) {
        this.render(hit)
      }
      this.place(hit)
    }

    /** 只滚动了:内容没变,按旧位置重算坐标 */
    private reposition(): void {
      const hit = this.hit
      this.el.style.visibility = 'hidden'
      if (hit) this.place(hit)
    }

    private render(hit: MathHit): void {
      this.el.classList.remove('cm-md-math-preview-error')
      try {
        katex.render(hit.tex, this.el, {
          displayMode: hit.display,
          throwOnError: false,
          output: 'html',
          trust: false
        })
      } catch {
        // MathWidget 同款兜底:KaTeX 自己都抛了,至少把源码露出来
        this.el.textContent = hit.display ? `$${hit.tex}$$` : `$${hit.tex}$`
        this.el.classList.add('cm-md-math-preview-error')
      }
      this.rendered = { tex: hit.tex, display: hit.display }
    }

    /** 优先放右侧;右边放不下放下方,下方也放不下放上方 */
    private place(hit: MathHit): void {
      const box = sourceBox(this.view, hit)
      if (!box) return
      const pane = this.view.dom.getBoundingClientRect()
      // 公式已经滚出编辑区(或本来就在视口外):没有参照物,不显示
      if (box.bottom < pane.top || box.top > pane.bottom) return

      const w = this.el.offsetWidth
      const h = this.el.offsetHeight
      let x = box.right + GAP
      let y = box.top
      if (x + w > pane.right - EDGE) {
        x = clamp(box.left, pane.left + EDGE, Math.max(pane.left + EDGE, pane.right - EDGE - w))
        y = box.bottom + GAP
        if (y + h > pane.bottom - EDGE) y = box.top - GAP - h
      }
      x = clamp(x, pane.left + EDGE, Math.max(pane.left + EDGE, pane.right - EDGE - w))
      y = clamp(y, pane.top + EDGE, Math.max(pane.top + EDGE, pane.bottom - EDGE - h))
      this.el.style.left = `${Math.round(x)}px`
      this.el.style.top = `${Math.round(y)}px`
      this.el.style.visibility = 'visible'
    }
  }
)

export function mathPreview(): Extension {
  return mathPreviewPlugin
}
