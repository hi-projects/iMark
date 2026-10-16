/**
 * 插件的**编辑器扩展点** —— 渲染层这一半。
 *
 * 插件永远拿不到编辑器实例(它跑在主进程或自己的页面里),它能做的是三件事:
 * **读**、**改**、**加标记**。前两件是宿主代劳,第三件落在 CodeMirror 的装饰上,
 * 就是这里。
 *
 * 三条设计约束,每一条都对应一个真会出问题的场景:
 *
 * 1. **装饰是可回收的,按插件分开存**。停用/卸载一个插件要能一把撤掉它画的所有东西
 *    —— 混成一坨的话,用户只能看着残留的高亮去猜是谁干的。
 * 2. **位置要跟着文档走**(`map(tr.changes)`)。插件标的是"第 100 到 200 个字",
 *    用户在标记前面打一个字,不映射的话标记就整体错位一格 —— 而插件不会再收到
 *    通知,它没有机会修正。
 * 3. **样式只能落在自己标出来的元素上**。插件写的 CSS 由宿主包一层 `@scope`
 *    (见 pluginUi.ts 的注入实现),而标记元素带着 `data-imk-plugin="<id>"`,
 *    于是它的选择器天然只能命中自己画的东西。
 */

import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export interface PluginDecorationSpec {
  from: number
  to: number
  class: string
}

const setDecorations = StateEffect.define<{ pluginId: string; specs: PluginDecorationSpec[] }>()
const clearDecorations = StateEffect.define<{ pluginId: string }>()

function markFor(pluginId: string, cls: string): Decoration {
  return Decoration.mark({
    class: cls,
    // 归属标记是样式作用域的锚点(`@scope ([data-imk-plugin="…"])`),
    // 也是"这条装饰是谁画的"在 DOM 上的唯一线索
    attributes: { 'data-imk-plugin': pluginId }
  })
}

/** 把插件给的规格变成可用的装饰(位置先夹进文档范围,免得插件拿着过期的偏移) */
function buildSet(pluginId: string, specs: PluginDecorationSpec[], docLength: number) {
  const ranges = specs.map(spec => {
    const from = Math.max(0, Math.min(docLength, spec.from))
    const to = Math.max(from, Math.min(docLength, spec.to))
    return markFor(pluginId, spec.class).range(from, to)
  })
  // sort: true 允许乱序与重叠 —— 插件们各画各的,互相不知道对方标了哪儿,
  // 要求它们给出排好序且不重叠的区间是强人所难,而 CodeMirror 本来就支持
  return Decoration.set(ranges, true)
}

/**
 * 所有插件的装饰。值是一个 Map,键是插件 id。
 *
 * 每次更新都重建**整份** `DecorationSet`(而不是增量 add/filter):插件的标记数量
 * 上限是 2000 条,重建的成本远低于维护"哪条是谁的"这套账 —— 而后者正是把
 * 撤销一个插件的装饰搞成一团乱麻的原因。
 */
export const pluginDecorations = StateField.define<Map<string, DecorationSet>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, DecorationSet> | null = null
    for (const effect of tr.effects) {
      if (effect.is(setDecorations)) {
        next ??= new Map(value)
        next.set(effect.value.pluginId, buildSet(effect.value.pluginId, effect.value.specs, tr.state.doc.length))
      } else if (effect.is(clearDecorations)) {
        if (value.has(effect.value.pluginId)) {
          next ??= new Map(value)
          next.delete(effect.value.pluginId)
        }
      }
    }
    if (next) return next
    // 文档变了:每一份都要跟着映射,否则标记会整体错位(见文件头第 2 条)
    if (tr.docChanged && value.size > 0) {
      const mapped = new Map<string, DecorationSet>()
      for (const [id, set] of value) mapped.set(id, set.map(tr.changes))
      return mapped
    }
    return value
  },
  provide: field => EditorView.decorations.from(field, sets => mergeAll(sets))
})

/** 把每个插件的那一份合成一份交给 CodeMirror */
function mergeAll(sets: Map<string, DecorationSet>): RangeSet<Decoration> {
  if (sets.size === 0) return Decoration.none
  if (sets.size === 1) return [...sets.values()][0] as DecorationSet
  const all: ReturnType<Decoration['range']>[] = []
  for (const set of sets.values()) {
    set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
      all.push({ from, to, value })
    })
  }
  return Decoration.set(all, true)
}

/** 编辑器扩展(装进 buildExtensions) */
export function pluginEditorExtension() {
  return pluginDecorations
}

// ---------- 对外的几个动作(由 services/pluginUi.ts 调用) ----------

export function applyDecorations(view: EditorView, pluginId: string, specs: PluginDecorationSpec[]): void {
  view.dispatch({ effects: setDecorations.of({ pluginId, specs }) })
}

export function dropDecorations(view: EditorView, pluginId: string): void {
  view.dispatch({ effects: clearDecorations.of({ pluginId }) })
}

/**
 * 停止某插件的装饰。
 *
 * 换文档时 state 会整个重建(见 setup.ts 的 loadDocument),那些装饰自然就没了 ——
 * 但**主进程那边的账还在**,插件以为自己的标记还画着。所以停用插件时统一走这里清一次。
 */
export function clearPluginDecorations(view: EditorView | null, pluginId: string): void {
  if (!view) return
  view.dispatch({ effects: clearDecorations.of({ pluginId }) })
}
