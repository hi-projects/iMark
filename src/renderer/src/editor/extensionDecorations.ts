/**
 * 扩展的文本装饰(`TextEditor.setDecorations`)在 CM6 侧的落点。
 *
 * 数据流刻意做成「状态字段 + Effect」而不是直接往视图上挂 DecorationSet:
 * 每个标签各有一份 EditorState,装饰必须随 state 走 —— 切到别的标签再切回来,
 * 装饰还在;后台标签也能在文档变化时把自己那份偏移量映射过去。
 *
 * 扩展给的样式一律过白名单:颜色只认 hex/rgb/hsl/`var(--x)`,边框只认
 * solid/dashed/dotted 与 px/em/rem。任何一个"原样塞进 style"的捷径,
 * 都等于让扩展往宿主页面里注入任意 CSS。
 */

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { DecorationRenderOptionsDto } from '@shared/extensionProtocol'

export interface ExtensionDecorationEntry {
  typeId: string
  ranges: readonly { from: number; to: number }[]
  options: DecorationRenderOptionsDto
}

/** `null` = 清空全部装饰(扩展被卸载/停用时) */
export const setExtensionDecorationsEffect = StateEffect.define<ExtensionDecorationEntry | null>()

const MAX_RANGES = 2000

const decorationField = StateField.define<ReadonlyMap<string, ExtensionDecorationEntry>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, ExtensionDecorationEntry> | null = null
    const writable = (): Map<string, ExtensionDecorationEntry> => {
      if (!next) next = new Map(value)
      return next
    }

    if (tr.docChanged) {
      const mapped = new Map<string, ExtensionDecorationEntry>()
      for (const [typeId, entry] of value) {
        const ranges = entry.ranges
          .map(range => ({
            from: tr.changes.mapPos(range.from, 1),
            to: tr.changes.mapPos(range.to, -1)
          }))
          .filter(range => range.to > range.from)
        mapped.set(typeId, { ...entry, ranges })
      }
      next = mapped
    }

    for (const effect of tr.effects) {
      if (!effect.is(setExtensionDecorationsEffect)) continue
      const target = writable()
      if (effect.value === null) {
        target.clear()
        continue
      }
      const { typeId, ranges, options } = effect.value
      if (ranges.length === 0) target.delete(typeId)
      else target.set(typeId, { typeId, ranges: ranges.slice(0, MAX_RANGES), options })
    }
    return next ?? value
  }
})

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|var\(--[\w-]+\))$/i
const WIDTH = /^\d+(?:\.\d+)?(?:px|em|rem)$/i
const DECORATION_TOKENS = new Set(['underline', 'line-through', 'overline', 'none'])

function safeColor(value: string | undefined): string | null {
  return value && COLOR.test(value.trim()) ? value.trim() : null
}

function styleOf(options: DecorationRenderOptionsDto): string {
  const parts: string[] = []
  const background = safeColor(options.backgroundColor)
  if (background) parts.push(`background-color:${background}`)
  const color = safeColor(options.color)
  if (color) parts.push(`color:${color}`)

  const borderColor = safeColor(options.borderColor)
  const style =
    options.borderStyle === 'dashed' || options.borderStyle === 'dotted'
      ? options.borderStyle
      : options.borderStyle === 'solid'
        ? 'solid'
        : null
  const width = options.borderWidth && WIDTH.test(options.borderWidth.trim())
    ? options.borderWidth.trim()
    : null
  if (borderColor && style) {
    // 只给了颜色时补一条 1px;给了宽度才用宽度 —— 宽度本身也过白名单
    parts.push(`border-bottom:${width ?? '1px'} ${style} ${borderColor}`)
  }

  if (options.textDecoration) {
    const tokens = options.textDecoration.trim().split(/\s+/)
    if (tokens.length > 0 && tokens.every(token => DECORATION_TOKENS.has(token))) {
      parts.push(`text-decoration:${tokens.join(' ')}`)
    }
  }
  if (options.fontWeight && /^(normal|bold|[1-9]00)$/.test(options.fontWeight.trim())) {
    parts.push(`font-weight:${options.fontWeight.trim()}`)
  }
  if (options.fontStyle && /^(normal|italic|oblique)$/.test(options.fontStyle.trim())) {
    parts.push(`font-style:${options.fontStyle.trim()}`)
  }
  return parts.join(';')
}

function buildDecorations(state: EditorStateLike): DecorationSet {
  const entries = state.field(decorationField)
  const builder = new RangeSetBuilder<Decoration>()
  const all: Array<{ from: number; to: number; decoration: Decoration }> = []

  for (const entry of entries.values()) {
    const style = styleOf(entry.options)
    if (!style) continue
    const decoration = Decoration.mark({
      attributes: { style, class: 'imark-ext-decoration' }
    })
    for (const range of entry.ranges) {
      let from = Math.min(Math.max(range.from, 0), state.doc.length)
      let to = Math.min(Math.max(range.to, 0), state.doc.length)
      if (entry.options.isWholeLine) {
        from = state.doc.lineAt(from).from
        to = state.doc.lineAt(to).to
      }
      if (to <= from) continue
      all.push({ from, to, decoration })
    }
  }

  // RangeSet 的构建器要求有序且不重叠:同一段文本被两个扩展标记时,
  // 后一个从上一个的末尾开始 —— 少画几个字符,总好过整个装饰集抛错。
  all.sort((a, b) => a.from - b.from || a.to - b.to)
  let end = 0
  for (const item of all) {
    const from = Math.max(item.from, end)
    if (item.to <= from) continue
    builder.add(from, item.to, item.decoration)
    end = item.to
  }
  return builder.finish()
}

/** 只用到 doc 与 field,避免把 EditorState 的完整泛型拖进计算式 */
interface EditorStateLike {
  doc: { length: number; lineAt(pos: number): { from: number; to: number } }
  field(field: typeof decorationField): ReadonlyMap<string, ExtensionDecorationEntry>
}

const decorations = EditorView.decorations.compute([decorationField], state =>
  buildDecorations(state as unknown as EditorStateLike)
)

export const extensionDecorationsExtension = [decorationField, decorations]
