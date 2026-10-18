/**
 * 市场/安装确认/设置页共用的**层徽标**。
 *
 * 插件不再有四种 kind:一个插件可以同时有 main 与 render,也可以只有其中一层,
 * 或者无代码绑定内置能力。所有界面都从这里取标签,避免五处各写一套条件、
 * 更避免 `v-else` 把未知形态误标成“不含代码”。
 */
import type { MarketPluginShape } from '@shared/market'

export type ShapeTone = 'node' | 'restricted' | 'render' | 'capability' | 'unknown'

export interface ShapeLabel {
  label: string
  tone: ShapeTone
}

export function shapeOf(value: {
  mainMode?: 'restricted' | 'node' | null
  hasRender?: boolean
  capability?: string | null
}): MarketPluginShape {
  return {
    mainMode: value.mainMode ?? null,
    hasRender: value.hasRender === true,
    capability: value.capability ?? null
  }
}

export function shapeLabels(shape: MarketPluginShape): ShapeLabel[] {
  const out: ShapeLabel[] = []
  if (shape.mainMode === 'node') out.push({ label: '完整权限插件', tone: 'node' })
  else if (shape.mainMode === 'restricted') out.push({ label: '受限权限插件', tone: 'restricted' })
  if (shape.hasRender) out.push({ label: 'Render 层', tone: 'render' })
  if (shape.capability) out.push({ label: '内置能力', tone: 'capability' })
  if (out.length === 0) out.push({ label: '未知形态', tone: 'unknown' })
  return out
}

/** 一行文字摘要;用于详情页标题下/设置页 */
export function shapeSummary(shape: MarketPluginShape): string {
  const parts = shapeLabels(shape).map(s => s.label)
  return parts.join(' + ')
}

/** 是否存在需要安装确认的任意代码层(node main 或 render) */
export function needsTrustAck(shape: MarketPluginShape): boolean {
  return shape.mainMode === 'node' || shape.hasRender
}
