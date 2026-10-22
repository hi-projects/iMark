/**
 * 市场/安装确认/设置页共用的**形态徽标**。
 *
 * v2 只有两种形态:含代码(有 main 入口)与纯声明式。没有 main 模式、没有
 * render 层、没有 capability —— 那些是 v1 的层模型,已经从界面上整个删掉。
 * 所有界面都从这里取标签,避免各写一套条件、更避免 `v-else` 把未知形态误标成
 * 「纯声明」。
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

/** 一行文字摘要;用于详情页标题下/设置页 */
export function shapeSummary(shape: MarketPluginShape): string {
  return shapeLabels(shape)[0]!.label
}

/** 含代码扩展需要用户在安装确认框里主动勾选「以当前用户权限运行」 */
export function needsTrustAck(shape: MarketPluginShape): boolean {
  return shape.hasMain
}
