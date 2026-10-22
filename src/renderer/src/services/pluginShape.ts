/**
 * 市场/安装确认/设置页共用的**形态徽标**。
 *
 * 扩展只有两种形态:含代码(有 main 入口)与纯声明式。所有界面都从这里取标签,
 * 避免各写一套条件、更避免 `v-else` 把未知形态误标成「纯声明」。
 */
import type { MarketPluginShape } from '@shared/market'

export type ShapeTone = 'code' | 'declarative'

export interface ShapeLabel {
  label: string
  tone: ShapeTone
}

export function shapeOf(value: { hasMain?: boolean }): MarketPluginShape {
  return { hasMain: value.hasMain === true }
}

export function shapeLabels(shape: MarketPluginShape): ShapeLabel[] {
  return shape.hasMain
    ? [{ label: '含代码', tone: 'code' }]
    : [{ label: '纯声明', tone: 'declarative' }]
}
